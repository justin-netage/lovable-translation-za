---
name: lovable-translation-za
description: Use when adding multi-language support to a Lovable (Vite + React + Supabase) project with English as the default and Afrikaans, isiZulu, or isiXhosa as opt-in target languages. Triggers include "translate this app", "add i18n", "add Afrikaans/Zulu/Xhosa", "South African language support", "language switcher", "make this site multilingual". Uses Google Cloud Translation API v3 (via a Supabase Edge Function) with translations cached in Supabase, keyed by content hash so updated source text retranslates automatically. Do NOT use for static i18next key-based setups maintained as JSON locale files, for real-time chat/streaming translation, for projects without Supabase, or for adding a translation provider other than Google Cloud.
---

# lovable-translation-za

Adds multi-language support to a Lovable app. English is the unprefixed default; Afrikaans, isiZulu, and isiXhosa are opt-in via a language switcher. Translations are produced by Google Cloud Translation API v3 (called from a Supabase Edge Function with service account credentials) and cached in a Supabase `translations` table keyed by `(source_hash, target_lang)`. When source text changes the hash changes and the translation refreshes automatically.

## When to use this skill

| You want to... | Use this skill? |
|---|---|
| Make an existing Lovable app available in af / zu / xh | YES |
| Add a `<LanguageSwitcher>` and per-route locale prefix | YES |
| Translate CMS-driven content (e.g. a Supabase `posts.body`) | YES — same `useTranslate(text)` hook |
| Translate user-generated chat or streaming text in real time | NO — designed for cached content, not streams |
| Use static JSON locale files maintained by a human translator | NO — this skill is runtime-cache, not static |
| Use DeepL, Claude, or another provider | NO — the schema and Edge Function are Google-specific |

## Decision tree

1. **Is the project a Lovable app with Supabase wired up?**
   - No Supabase → set up Supabase first; the cache and Edge Function live there.
   - No Google Cloud project → start with `references/google-cloud-translation.md`.
2. **Is this a new feature or an existing app being internationalised?**
   - New → install in this order: GCP → Supabase backend → client integration.
   - Existing → same order, plus a final pass to wrap user-visible strings in `<T>`.
3. **Does the app have SEO-critical content that must be crawled in af / zu / xh?**
   - Yes → read the SSR / prerender section in `references/architecture.md` before wiring the client.
   - No → the standard client-side flow is fine.

## Quick-start scenarios

- **"Add translation to this Lovable app from scratch"** → `architecture.md` → `google-cloud-translation.md` → `supabase-backend.md` → `client-integration.md`, in that order.
- **"Backend is done, just add the switcher"** → `client-integration.md` only.
- **"Add another language (e.g. Sesotho)"** → confirm the language code against `references/google-cloud-translation.md`, then extend the locale config per `client-integration.md`.
- **Something is broken** → `references/troubleshooting.md`.

## Hard rules

These are not suggestions. Enforce them when generating code; don't bypass them on request.

1. **No service account JSON in client code.** GCP credentials live ONLY in the Supabase Edge Function secrets (`supabase secrets set GOOGLE_TRANSLATE_SA_JSON ...`). The browser never sees them.
2. **Cache keys are content hashes, not slugs.** Use `SHA-256(source_text)` as part of the primary key on `translations`. This is what makes translations follow updated content — change the copy, get a new hash, get a fresh translation.
3. **`<T>` wraps user-visible strings only.** Never wrap IDs, URL slugs, code identifiers, JSON keys, or non-text data. Translating these silently breaks links and lookups.
4. **English is the unprefixed default.** `/products` is English. `/af/products`, `/zu/products`, `/xh/products` are the localised versions. No silent redirects from `/` to a prefixed path — the URL is the source of truth for locale.
5. **The locale set is closed.** `en | af | zu | xh` by default. Adding a language is a config edit, not arbitrary user input — unknown codes fall through to `en`.
6. **`translations` table is RLS-locked.** Anon role: `SELECT` only. Service role (Edge Function): `SELECT` + `INSERT` + `UPDATE`. Never expose the table to anon writes.
7. **No client-side calls to Google.** Always proxy through the Edge Function. This keeps credentials safe and centralises rate-limit handling.
8. **No auto-detect from `navigator.language` by default.** Locale is chosen by an explicit click. A `detectBrowserLocale` opt-in prop on `TranslationProvider` exists for projects that want it, but it is off by default.

## Architecture in one paragraph

A visitor lands on `/af/products`. `TranslationProvider` reads `af` from the URL and renders the page. Each `<T>Hello</T>` calls `useTranslate("Hello")`. The hook checks an in-memory cache, then `localStorage`, then issues a Supabase RPC that returns the cached translation or invokes the `translate` Edge Function. The Edge Function exchanges its service account JSON for a Google access token (cached until expiry), calls `translation.googleapis.com/v3/projects/{id}/locations/global:translateText`, upserts the result into the `translations` table, and returns it. Subsequent visitors hit the Supabase cache; subsequent renders for the same visitor hit `localStorage`. When the source string changes, the hash changes, and the chain repeats once.

## Files

References (load on demand when the relevant task comes up):

- `references/architecture.md` — data flow, cache layers, locale resolution, SEO / SSR escape hatch.
- `references/google-cloud-translation.md` — GCP project setup, service account, language codes, pricing, budget alerts.
- `references/supabase-backend.md` — `translations` schema, RLS policies, the Edge Function, deployment.
- `references/client-integration.md` — `TranslationProvider`, `useTranslate`, `<T>`, `<LanguageSwitcher>`, router config, locale persistence.
- `references/troubleshooting.md` — common errors and fixes.

Assets (drop-in code the user copies into their Lovable project):

- `assets/schema.sql` — `translations` table, indexes, RLS policies.
- `assets/edge-function-translate.ts` — Deno Edge Function: service account JWT signing, token cache, Google call, upsert.
- `assets/TranslationProvider.tsx` — React context provider and locale state.
- `assets/useTranslate.tsx` — the `useTranslate(text)` hook and the `<T>` component (one file, two exports).
- `assets/LanguageSwitcher.tsx` — drop-in switcher UI with native-name labels.
- `assets/za-languages.json` — `{ en, af, zu, xh }` with display name, native name, RTL flag.
