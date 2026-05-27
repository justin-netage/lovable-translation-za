# Architecture

How the translation system fits together — read this first when wiring a new project or when debugging an unexpected request path.

## Overview

The system is a four-layer cache in front of Google Cloud Translation API v3. Source text is wrapped in `<T>` on the client; the current locale is read from the URL prefix. If the locale is `en` the text passes through unchanged. Otherwise the text flows through (in-memory → localStorage → Supabase table → Edge Function → Google), each layer falling through on miss. Cache keys are `SHA-256(source_text) || target_lang`, so editing the source string is sufficient to invalidate everywhere downstream — no manual purge.

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (React)                                             │
│                                                              │
│  <T>Hello</T>                                                │
│     │                                                        │
│     ▼                                                        │
│  useTranslate("Hello")                                       │
│     │                                                        │
│     ├──► in-memory Map  (per tab, per session)         HIT ─┐│
│     │                                                        ││
│     ├──► localStorage   (per browser, per origin)      HIT ─┤│
│     │                                                        ││
│     ▼ MISS                                                  ▼│
│  supabase.functions.invoke("translate", { text, locale })    │
└────────────────────────────────┬─────────────────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  Supabase Edge Function: translate                           │
│                                                              │
│  1. SELECT translated_text FROM translations                 │
│     WHERE source_hash = $1 AND target_lang = $2     HIT ─┐   │
│                                                          │   │
│  2. MISS → exchange SA JSON for Google access token      │   │
│     (token cached in module scope until exp)             │   │
│                                                          │   │
│  3. POST translation.googleapis.com/v3/.../translateText │   │
│                                                          │   │
│  4. INSERT into translations (source_hash, target_lang,  │   │
│     source_text, translated_text, updated_at)            │   │
│                                                          │   │
│  5. Return translated_text                              ◄┘   │
└────────────────────────────────┬─────────────────────────────┘
                                 ▼
                       returned to client,
                       written to localStorage
                       and in-memory map
```

## Data flow — one request, end to end

A visitor lands on `/af/products`. Each step below assumes a cold cache; later steps short-circuit when warmer layers hit.

1. **Route resolution.** React Router matches `/:locale?/*` and `TranslationProvider` reads `af` from the URL. The provider exposes `locale = "af"` via context.
2. **Render.** A component renders `<T>Add to cart</T>`. The component calls `useTranslate("Add to cart")`.
3. **In-memory check.** The hook looks up `Map<key, string>` where `key = sha256("Add to cart") + ":af"`. Miss on first call.
4. **localStorage check.** Same key under namespace `tx:`. Miss.
5. **Supabase call.** The hook calls `supabase.functions.invoke("translate", { text: "Add to cart", target_lang: "af" })`. While the request is in flight the hook returns `text` (English) so the UI never shows blank — see "First-paint behaviour" below.
6. **Edge Function: cache lookup.** The function computes the hash server-side, then `SELECT translated_text FROM translations WHERE source_hash = $1 AND target_lang = $2`. On hit (warm visitor 2+), return immediately. On miss continue.
7. **Edge Function: Google call.** The function holds a service account JSON in env, signs a JWT, exchanges it for an access token (cached in module scope until ~1 minute before expiry), and calls `POST https://translation.googleapis.com/v3/projects/{PROJECT_ID}/locations/global:translateText` with body `{ contents: ["Add to cart"], sourceLanguageCode: "en", targetLanguageCode: "af" }`.
8. **Edge Function: write-through.** The result is upserted into `translations` keyed by `(source_hash, target_lang)` with `updated_at = now()`. Return `translated_text` to the client.
9. **Client write-through.** The hook writes the result to localStorage and the in-memory map, then triggers a re-render. The user sees the Afrikaans string.

All later visitors for that string hit step 6 only. All later renders in the same tab hit step 3 only.

## Locale resolution

Locale is resolved on every render in this order. First match wins:

1. **URL prefix.** `/af/...`, `/zu/...`, `/xh/...` set the locale explicitly. The router constrains `:locale?` to the closed set `af | zu | xh` so unknown values never reach the provider.
2. **Default: `en`.** No prefix → English.

There is intentionally no `navigator.language` lookup, no localStorage lookup, and no Accept-Language header inspection. URL is the single source of truth — that's what makes URLs shareable across users and crawlable by bots.

`<LanguageSwitcher>` writes the chosen locale to localStorage under `tx:preferred-locale` *and* navigates to the prefixed path. The localStorage value is read only by the switcher itself (to highlight the active language in the menu); it never silently redirects the visitor.

**Opt-in escape hatch.** `<TranslationProvider detectBrowserLocale={true}>` enables a one-time check on first ever visit (no localStorage flag set) that compares `navigator.language` against the locale set and redirects if a match is found. Default is `false`. Document this only where it's genuinely needed.

## Cache layers — hit, miss, refresh rules

| Layer | Scope | TTL | Invalidated by |
|---|---|---|---|
| In-memory `Map` | Per tab, lives until reload | None (process lifetime) | Page reload |
| `localStorage` (`tx:` namespace) | Per browser, per origin | None | User clears storage; source hash changes (key no longer matches) |
| Supabase `translations` table | Global, all users | None | Manual `DELETE` (rare); source hash changes (new row created on next miss) |
| Google access token | Edge Function module scope | ~1 hour (Google's default) | Token expiry; cold start |

None of the caches need a TTL because they're all keyed by content hash. When source text changes, the new hash points to no row → cache miss → fresh translation → new row written. The old row stays behind but is unreachable from the client (no `<T>` block produces its hash any more); pruning is optional cleanup, not correctness.

## Content-hash invalidation

The hash is `SHA-256(normalised(source_text))` where `normalised()` does the minimum work needed to avoid trivial misses:

- Trim leading and trailing whitespace.
- Collapse runs of internal whitespace to a single space.
- Keep punctuation and case unchanged.

Case matters because `"Cart"` and `"cart"` legitimately translate differently in context. Don't be tempted to lowercase before hashing.

To force a refresh of a specific string without editing it (rare — e.g. Google improved the model and you want the new output), `DELETE FROM translations WHERE source_hash = $1` and the next render produces a fresh translation.

## First-paint behaviour

The Edge Function call is async, so the very first render of a non-English page can't have translations ready. Two acceptable strategies, both implemented in `assets/useTranslate.tsx`:

1. **Show source text while loading (default).** `<T>Add to cart</T>` renders "Add to cart" until the Afrikaans string arrives, then re-renders. Visible flicker on cold caches but no blank UI. This is what's used unless the caller passes `fallback="..."`.
2. **Render a Suspense boundary.** Wrap the page (or a section) in `<Suspense fallback={<Spinner/>}>`. The hook throws a promise on miss. Clean but requires a Suspense-aware tree.

For Lovable apps the default flicker behaviour is the right call — visitors on `/af/products` reaching the page over a warm Supabase cache see Afrikaans on first paint, and only the very-first-ever visitor to a fresh translation sees the flicker.

## SEO and SSR — the limitation and the escape hatch

The standard flow injects translations client-side, so crawlers that don't execute JavaScript receive English HTML even on `/af/...`. For SEO-critical apps targeting non-English audiences this is a problem.

**When it matters.** If a key business goal is "rank in Google Search for `kos bestel` (Afrikaans for 'order food')", the standard flow is not enough.

**When it doesn't.** Internal tools, authenticated dashboards, single-market English-SEO products with af/zu/xh as accessibility-only.

**The escape hatch — prerender at build.** Generate static HTML per locale during the build:

1. Use a Vite SSG plugin (`vite-plugin-ssg`, `vite-react-ssg`) or a deploy-time prerender step (Vercel's `vercel build` with a prerender adapter, Netlify's prerender).
2. The build crawls the route tree once per locale, invoking the same `useTranslate` hook. Translations are fetched at build time from Supabase (warm-cache reads) or directly from Google for cold misses.
3. The output is static `/index.html`, `/af/index.html`, `/zu/index.html`, `/xh/index.html`. Crawlers see translated HTML; client takes over after hydration for any subsequent translations.

Step 2 requires the build environment to have read access to Supabase (use the anon key — translation rows are public-read) and, for cold cache misses, the Edge Function URL plus an anon JWT.

A more involved alternative for static documents (PDFs, long-form copy) is the Cloud Translation **Document Translation API**, which translates entire files. That's out of scope for this skill — the runtime hook handles every case the SPA needs.

## What to check after wiring this up

Before declaring the integration done:

- [ ] `/` renders English with no network calls to Supabase functions.
- [ ] `/af/`, `/zu/`, `/xh/` render the localised versions, with one Edge Function call per unique string on first visit, zero calls on reload (localStorage hit).
- [ ] A second visitor to `/af/` makes zero Edge Function calls for any string the first visitor already translated (Supabase cache hit returned by step 6).
- [ ] Editing the source text in JSX and reloading produces a fresh translation (hash changed).
- [ ] `<LanguageSwitcher>` round-trips through all four locales without leaving the locale prefix stuck.
- [ ] The `translations` table grows by exactly the count of unique source strings × target locales, not more.
- [ ] Network panel shows zero direct calls to `translation.googleapis.com` from the browser.
- [ ] `supabase secrets list` shows `GOOGLE_TRANSLATE_SA_JSON` and `GOOGLE_PROJECT_ID` set; neither is visible in any client bundle.

## Common errors

- **Translation flickers on every render, not just first.** The in-memory map isn't being read because the `TranslationProvider` is re-mounting (likely due to a key change on a parent). Move the provider above the route changes.
- **`/af/products` shows English forever.** Either the Edge Function is failing silently (check its logs) or the locale prefix isn't reaching the provider (check the router config — `:locale?` must be the first segment).
- **Same string translates multiple times.** The hash is being computed differently on the client and the server (different normalisation). Re-check that both sides trim + collapse whitespace identically.
- **Costs ramping faster than expected.** Something is calling `useTranslate` with values that change every render (e.g. `useTranslate(`Total: ${price}`)` produces a new hash per price). For interpolated content, translate the template and interpolate after: `useTranslate("Total: {price}")` then `.replace("{price}", price)`.
- **`navigator.language` translation kicked in for a user who never asked.** `detectBrowserLocale` is set to `true` somewhere. Default it back to `false`.
- **Anon visitor can write to `translations`.** RLS policy is wrong — anon role should be `SELECT` only. See `references/supabase-backend.md`.
