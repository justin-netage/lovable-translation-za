# Client Integration

How the React side fits together: the provider, the hook, the `<T>` component, the router config, the language switcher, and the gotchas that lose people half a day. Full implementations live in `assets/`.

## Prerequisites in the Lovable project

This reference assumes a typical Lovable stack:

- **Vite + React 18+**
- **React Router 6+** (`react-router-dom`)
- **`@supabase/supabase-js`** client already exported from somewhere central (often `src/lib/supabase.ts`)
- **TypeScript** (not strictly required but the assets are `.tsx` / `.ts`)

If the project uses TanStack Router, Next.js App Router, or another router, the router-config section below changes shape — the provider, hook, and `<T>` are router-agnostic.

## What you mount, in order

1. `<TranslationProvider>` once, at the root, inside `<BrowserRouter>`.
2. `<LanguageSwitcher />` somewhere visible in nav.
3. `<T>...</T>` or `useTranslate(...)` everywhere you have user-visible text.
4. Replace `<Link>` with `<LocalizedLink>` for any link that should preserve the current locale.

Asset files (`assets/TranslationProvider.tsx`, `assets/useTranslate.tsx`, `assets/LanguageSwitcher.tsx`, `assets/za-languages.json`) drop into `src/i18n/` in the Lovable project — no other layout works without renaming imports.

## TranslationProvider

Wraps the app, owns locale state, exposes context.

```tsx
// src/main.tsx
import { BrowserRouter } from 'react-router-dom';
import { TranslationProvider } from './i18n/TranslationProvider';

<BrowserRouter>
  <TranslationProvider>
    <App />
  </TranslationProvider>
</BrowserRouter>
```

It MUST sit inside `<BrowserRouter>` because it reads `useLocation()` to derive locale from the URL. If it sits outside, you'll get a runtime error from the hook.

### Props

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `supportedLocales` | `('en' \| 'af' \| 'zu' \| 'xh')[]` | from `za-languages.json` | The closed set. Unknown URL prefixes fall through to `en`. |
| `detectBrowserLocale` | `boolean` | `false` | On first-ever visit (no `tx:preferred-locale` in localStorage), if `navigator.language` matches one of `supportedLocales`, navigate to that locale's prefix. Off by default. |
| `onLocaleChange` | `(locale) => void` | `undefined` | Optional callback. Useful for analytics or syncing other systems. |

### What it owns

- Reading the current locale from `useLocation().pathname` (first segment, validated against `supportedLocales`).
- Exposing `{ locale, setLocale, supportedLocales }` via context.
- An in-memory `Map<string, string>` cache shared across all `useTranslate` calls in the tree.
- Writing the user's chosen locale to `localStorage['tx:preferred-locale']` whenever it changes.
- Reading that localStorage key only on first visit, and only if `detectBrowserLocale` is `true`.

### What it does NOT own

- localStorage cache of *translations* — that lives in `useTranslate` so the hook can be used independently.
- The actual Edge Function call — also in `useTranslate`.
- Routing / `<Link>` rewriting — `<LocalizedLink>` is a separate small component.

## useTranslate and `<T>`

Two ways to invoke the same machinery. Use whichever reads better at the call site.

```tsx
// Component form — best for inline JSX text
<T>Add to cart</T>

// Hook form — best when the text is dynamic or you need it as a string
const label = useTranslate(product.shortDescription);
```

### Signature

```ts
useTranslate(text: string, options?: {
  fallback?: string;   // shown while loading; default is `text` itself (source English)
  suspend?: boolean;   // throw a promise on miss (Suspense mode); default false
}): string

<T>{text}</T>             // children must be a single string
<T fallback="…">{text}</T>
```

### Behaviour

1. If `locale === 'en'`, return `text` immediately. No network, no cache lookup, no work.
2. Normalise `text` (trim + collapse internal whitespace).
3. Check in-memory cache. Hit → return.
4. Check `localStorage[tx:{hash}:{locale}]`. Hit → write into in-memory cache, return.
5. Call `supabase.functions.invoke('translate', { body: { text, target_lang: locale } })`.
6. While pending: return `fallback ?? text` (English source).
7. On resolve: write to localStorage and in-memory cache, trigger re-render with translated text.
8. On error: log to console, return source text.

### Hard rules for what to wrap

- **Wrap user-visible strings.** Button labels, headings, body copy, alt text, placeholders, aria labels, tooltips, validation messages.
- **Do NOT wrap.** IDs, URL slugs, JSON keys, query-string values, code identifiers, currency codes (`ZAR`), country codes (`za`), email addresses, phone numbers, dates that are already formatted by a locale-aware formatter.
- **Children must be a single string for `<T>`.** `<T>Hello {name}</T>` is **wrong** — `{name}` is a separate child node and won't be translated correctly. Use interpolation (see next section).

### The interpolation gotcha — the single biggest footgun

This pattern produces a new hash for every value and burns through your free tier:

```tsx
// ❌ WRONG — every price change is a new translation request
<T>{`Total: R${total}`}</T>
useTranslate(`Total: R${total}`)
```

Translate the template once, interpolate after:

```tsx
// ✅ RIGHT
const template = useTranslate('Total: R{amount}');
const display = template.replace('{amount}', total.toString());
```

The `{amount}` token survives Google's translation intact (it's not a word in any of the supported languages), so af/zu/xh translations also contain `{amount}` and the same `.replace()` works for all locales.

For multiple values use named tokens: `'You have {count} items in your {bag}'` → `template.replace('{count}', n.toString()).replace('{bag}', bagLabel)`.

If named tokens read awkwardly, write a tiny helper in `src/i18n/format.ts`:

```ts
export const fmt = (template: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
    template,
  );
```

## Router configuration

The router itself is unchanged from a standard Lovable setup. Locale is parsed from `pathname`, not from a route segment, so you don't need a `:locale?` parameter.

```tsx
// src/App.tsx
<Routes>
  <Route path="/products" element={<Products />} />
  <Route path="/about" element={<About />} />
  <Route path="/:rest*" element={<NotFound />} />
</Routes>
```

When a visitor lands on `/af/products`, the `Routes` block above does **not** match — that's intentional, because we want the provider to handle the prefix, not the router. To make it work, peel the locale prefix off the pathname inside the provider before React Router sees it. Two implementations both work; the assets use option B.

### Option A: redirect to the un-prefixed path internally

The provider, on detecting `/af/...`, stores `locale = 'af'` and uses `useNavigate({ replace: true })` to rewrite to `/...`. The URL displayed to the user is then `/products`, but locale is `af`. This breaks the URL contract (shareable links lose the locale).

**Don't use this.** Listed only so you know to avoid it if you see it suggested elsewhere.

### Option B: split routes into a localised group (default)

```tsx
// src/App.tsx
<Routes>
  {/* English routes (no prefix) */}
  <Route path="/" element={<Home />} />
  <Route path="/products" element={<Products />} />
  <Route path="/products/:id" element={<ProductDetail />} />
  <Route path="/about" element={<About />} />

  {/* Localised routes — same components, prefixed path */}
  <Route path="/:locale" element={<Home />} />
  <Route path="/:locale/products" element={<Products />} />
  <Route path="/:locale/products/:id" element={<ProductDetail />} />
  <Route path="/:locale/about" element={<About />} />

  <Route path="*" element={<NotFound />} />
</Routes>
```

Verbose but explicit. The provider validates that `:locale` is in `supportedLocales`; anything else falls through to `<NotFound />`.

For larger apps, generate the localised duplicates from a route table:

```ts
const routes = [
  { path: '/', element: <Home /> },
  { path: '/products', element: <Products /> },
  // ...
];
// Render both: plain + each prefixed with /:locale
```

`assets/TranslationProvider.tsx` ships with a `useLocalizedRoutes(routes)` helper that does exactly this.

### LocalizedLink

Drop-in replacement for React Router's `<Link>`:

```tsx
// ❌ jumps to English version
<Link to="/products">Products</Link>

// ✅ stays in the current locale
<LocalizedLink to="/products">Products</LocalizedLink>
```

`LocalizedLink` reads the current locale from context and prepends `/${locale}/` if locale is not `en`. For `to="/products"` with locale `af` it renders `<a href="/af/products">`. It also accepts the same `replace`, `state`, `relative` props as `<Link>`.

Programmatic navigation uses the same `localePath` helper:

```tsx
const navigate = useNavigate();
const { locale } = useTranslationContext();

navigate(localePath('/products', locale));
// locale 'en' → '/products'
// locale 'af' → '/af/products'
```

## LanguageSwitcher

Drop-in component, no required props:

```tsx
import { LanguageSwitcher } from './i18n/LanguageSwitcher';

<nav>
  {/* ... */}
  <LanguageSwitcher />
</nav>
```

Renders a button/dropdown listing the four locales by their **native** name (English, Afrikaans, isiZulu, isiXhosa). On click it:

1. Computes the new path: strip the current locale prefix if any, then prepend the new one (unless the new locale is `en`).
2. Writes the choice to `localStorage['tx:preferred-locale']`.
3. Calls `navigate(newPath, { replace: false })` so back-button still works.

The current locale is shown as selected/disabled. Styling is left to the consumer (`assets/LanguageSwitcher.tsx` uses minimal class names; restyle freely).

To use a different UI (toggle, flag icons, etc.) — call `setLocale(code)` from context yourself. Don't re-implement the path rewriting; import `localePath` from the provider.

## Persistence — the role of localStorage

Two localStorage keys are used. They have different roles; don't conflate them.

| Key | What it holds | Read when? | Written when? |
|---|---|---|---|
| `tx:preferred-locale` | User's last chosen locale, e.g. `"af"` | Only on first visit, only if `detectBrowserLocale` is true OR the switcher renders (to highlight the active option) | Whenever locale changes via the switcher |
| `tx:{sha256}:{locale}` | One translation per source string per locale | Inside `useTranslate`, on every render where the string is requested | After every successful Edge Function call |

The first key does NOT silently redirect the user. URL is the source of truth. The skill explicitly avoids "you visited last time in Zulu, so we'll redirect you" — that breaks shareable URLs and confuses bots.

If you want auto-redirect-on-return, that's a one-line change in the provider — see the comment in `assets/TranslationProvider.tsx`. Default off.

## detectBrowserLocale — when to turn it on

```tsx
<TranslationProvider detectBrowserLocale={true}>
```

Behaviour: on the very first visit (no `tx:preferred-locale` set), if `navigator.language.split('-')[0]` is in `supportedLocales`, redirect to the matching prefix.

Turn on when:

- The app is primarily used by South African visitors and you want their browser locale honoured automatically.
- Onboarding analytics show drop-off on the language switcher.

Leave off when:

- The app has a public-facing English homepage that should always start in English (default).
- You're worried about test users in non-English browser locales getting confused while developing.

It only fires once per browser. Clearing `localStorage` re-arms it.

## Pitfalls beyond interpolation

### Mixed children won't translate as a unit

```tsx
<T>Welcome back, <strong>{name}</strong>!</T>
```

`<T>` sees three children: the string `"Welcome back, "`, the `<strong>` element, and `"!"`. It can only translate the strings, in isolation, and ordering may break in af/zu/xh.

Fix: translate the template, interpolate the markup:

```tsx
const template = useTranslate('Welcome back, {name}!');
const [pre, post] = template.split('{name}');
return <>{pre}<strong>{name}</strong>{post}</>;
```

Or accept the limitation and translate it as two strings:

```tsx
<T>Welcome back,</T> <strong>{name}</strong>!
```

### Rich text from a CMS

If `post.body` is markdown or HTML from a CMS:

```tsx
const translated = useTranslate(post.body);
return <ReactMarkdown>{translated}</ReactMarkdown>;
```

Pass `mimeType: 'text/html'` to the Edge Function (the asset hook supports an option) if the body contains tags you want preserved through translation. Default `text/plain` is safer — Google won't try to interpret `<em>` as HTML, but the tags pass through literally.

### Forms

Wrap labels, placeholders, helper text, error messages. **Don't** wrap form field values. A `<T>` around the value of a `<input>` would translate user input every render — wrong, expensive, and identity-destroying.

### Toasts and dynamic notifications

```tsx
// ❌ Translated once at registration time, before locale is known
toast.success(useTranslate('Saved successfully'));

// ✅ Translate just before showing
const t = useTranslate('Saved successfully');
toast.success(t);
```

Or for toast libraries that take JSX:

```tsx
toast.success(<T>Saved successfully</T>);
```

### Server-rendered HTML (SSR / prerender)

If you're prerendering for SEO, the hook needs to run at build time with locale set explicitly. See `references/architecture.md` § SEO and SSR — the hook is build-time-aware when given a locale prop instead of reading from URL.

## What to check after wiring this up

- [ ] `/` renders English; no calls visible in Network panel to `functions/v1/translate`.
- [ ] `/af/` (or `/zu/`, `/xh/`) renders translated, with one call per unique `<T>` string on first visit.
- [ ] Reloading `/af/` makes zero Edge Function calls — all served from localStorage.
- [ ] Switching languages via `<LanguageSwitcher>` round-trips through all four locales, URL updates correctly, no stuck prefixes.
- [ ] An English page with an `<a href="/products">` (raw HTML, not `<LocalizedLink>`) jumps to the English version — confirms `<LocalizedLink>` is being used where intended.
- [ ] `localStorage` shows `tx:preferred-locale` and a growing list of `tx:{hash}:{locale}` keys.
- [ ] Editing a `<T>` string and reloading retranslates it (new hash → cache miss → fresh API call).
- [ ] No `<T>` wrapping an interpolated string (`${...}` inside the children). Grep for `<T>{\`` and `useTranslate(\`` in the codebase.

## Common errors

- **"`useLocation` called outside `<BrowserRouter>`".** `TranslationProvider` is mounted above `<BrowserRouter>`. Move it inside.
- **"Cannot read property `pathname` of undefined".** Same root cause — the provider is rendering outside the router context.
- **Switching locales via the switcher updates `localStorage` but not the URL.** `LanguageSwitcher` is calling `setLocale(code)` only, not navigating. Either use the bundled switcher or also call `navigate(localePath(currentPath, code))`.
- **`<LocalizedLink>` to `/products` with locale `af` ends up at `/af/af/products`.** The `to` prop already contains a locale prefix — pass the unprefixed path. `to` is logical; `LocalizedLink` does the prefixing.
- **Translation flashes English on every navigation.** The in-memory cache is being thrown away between routes because the provider is unmounting. Check React Router config — `<TranslationProvider>` must be above `<Routes>`, not inside a route element.
- **Translations work in dev but not after `vite build && vite preview`.** The Supabase URL or anon key is missing from the build's env. Check `.env.production` and Lovable's deploy env.
- **First paint shows blank text, not English fallback.** `<T>` is rendering with `fallback={''}` or the `suspend` option is on without a Suspense boundary. Use the default — pass no `fallback`, no `suspend`.
- **All localised pages show 404.** The localised routes weren't duplicated in `<Routes>`. See § Option B above — every English route needs a `/:locale/...` twin.
- **Translation function called for `target_lang = 'en'`.** The hook isn't short-circuiting when locale is `en`. Confirm the first line of `useTranslate` returns `text` immediately when `locale === 'en'`.
