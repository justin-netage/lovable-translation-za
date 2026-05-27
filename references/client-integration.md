# Client Integration

How the React side fits together: the provider, the hook, the `<T>` component, the TanStack Router config, the language switcher, and the gotchas that lose people half a day. Full implementations live in `assets/`.

## Prerequisites in the Lovable project

This reference assumes the current Lovable default stack:

- **Vite + React 18+**
- **TanStack Router** (`@tanstack/react-router`) — file-based routing by default
- **`@supabase/supabase-js`** client already exported from somewhere central (often `src/lib/supabase.ts`)
- **TypeScript** (assets are `.tsx` / `.ts`)

The provider, hook, and `<T>` are router-agnostic and would work with any React router. Only the router-config section, `LocalizedLink`, and `LanguageSwitcher` are TanStack-specific. If you're on a legacy React Router project, the same patterns translate with import swaps and a route-duplication approach.

## What you mount, in order

1. `<TranslationProvider>` once, inside `__root.tsx`, wrapping `<Outlet />`.
2. A `{-$locale}` layout route that contains your app's routes.
3. `<LanguageSwitcher />` somewhere visible in nav.
4. `<T>...</T>` or `useTranslate(...)` everywhere you have user-visible text.
5. Replace `<Link>` with `<LocalizedLink>` for any link that should preserve the current locale.

Asset files (`assets/TranslationProvider.tsx`, `assets/useTranslate.tsx`, `assets/LanguageSwitcher.tsx`, `assets/za-languages.json`) drop into `src/i18n/` in the Lovable project. No other layout works without renaming imports.

## TranslationProvider

Wraps the app, owns locale state, exposes context. In a TanStack file-based project, it goes in the root route component:

```tsx
// src/routes/__root.tsx
import { Outlet, createRootRoute } from '@tanstack/react-router';
import { TranslationProvider } from '@/i18n/TranslationProvider';

export const Route = createRootRoute({
  component: () => (
    <TranslationProvider>
      <Outlet />
    </TranslationProvider>
  ),
});
```

It MUST sit inside the TanStack router context (i.e. inside or below `RouterProvider`). The root route component is the canonical location. If you mount it outside `RouterProvider`, `useRouterState` throws at runtime.

### Props

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `supportedLocales` | `('en' \| 'af' \| 'zu' \| 'xh')[]` | from `za-languages.json` | The closed set. Unknown URL prefixes fall through to `en`. |
| `detectBrowserLocale` | `boolean` | `false` | On first-ever visit (no `tx:preferred-locale` in localStorage), if `navigator.language` matches one of `supportedLocales`, navigate to that locale's prefix. Off by default. |
| `onLocaleChange` | `(locale) => void` | `undefined` | Optional callback. Useful for analytics or syncing other systems. |

### What it owns

- Reading the current locale from the URL via `useRouterState({ select: s => s.location.pathname })`. Splits on `/`, takes the first segment, validates against `supportedLocales`.
- Exposing `{ locale, setLocale, supportedLocales }` via context.
- An in-memory `Map<string, string>` cache shared across all `useTranslate` calls in the tree.
- Writing the user's chosen locale to `localStorage['tx:preferred-locale']` whenever it changes.
- Reading that localStorage key only on first visit, and only if `detectBrowserLocale` is `true`.

### What it does NOT own

- localStorage cache of *translations* — that lives in `useTranslate` so the hook can be used independently.
- The actual Edge Function call — also in `useTranslate`.
- Route definitions — see "Router configuration" below.

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

## Router configuration — TanStack Router

TanStack Router has a built-in optional-locale primitive: the `{-$locale}` segment. **One route file matches both `/products` and `/af/products`** — no manual duplication.

### File-based routing (default — what Lovable scaffolds)

The route tree lives in `src/routes/`. To add a `{-$locale}` prefix to your existing routes, group them under a layout route file:

```
src/routes/
├── __root.tsx                          // wraps everything in TranslationProvider
├── {-$locale}.tsx                      // optional-locale layout route
├── {-$locale}/index.tsx                // matches /  AND  /af  AND  /zu  AND  /xh
├── {-$locale}/products.tsx             // matches /products  AND  /af/products  …
├── {-$locale}/products.$id.tsx         // /products/123 AND /af/products/123 …
└── {-$locale}/about.tsx                // /about AND /af/about …
```

Behaviour:

- A visit to `/products` matches the route with `params.locale === undefined`.
- A visit to `/af/products` matches with `params.locale === 'af'`.
- A visit to `/foo/products` (`foo` is not a known locale) — by default, TanStack tries to match `foo` as the locale value. The provider validates and falls through to `en`, **but** the URL still shows `/foo/products`. To redirect cleanly, validate in the layout's `beforeLoad`:

```tsx
// src/routes/{-$locale}.tsx
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

const SUPPORTED_PREFIXES = ['af', 'zu', 'xh'] as const;

export const Route = createFileRoute('/{-$locale}')({
  beforeLoad: ({ params }) => {
    if (params.locale && !(SUPPORTED_PREFIXES as readonly string[]).includes(params.locale)) {
      // Bogus prefix — strip it
      throw redirect({ to: '/', replace: true });
    }
  },
  component: Outlet,
});
```

The layout itself just renders `<Outlet />`. The locale is read from URL by `TranslationProvider`; the layout doesn't need to pass it down.

### Code-based routing (alternative — older TanStack projects)

If your project defines routes in code with `createRouter`/`createRoute`, the same `{-$locale}` segment works:

```tsx
import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';

const rootRoute = createRootRoute({
  component: () => (
    <TranslationProvider>
      <Outlet />
    </TranslationProvider>
  ),
});

const localeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/{-$locale}',
  beforeLoad: ({ params }) => {
    if (params.locale && !['af','zu','xh'].includes(params.locale)) {
      throw redirect({ to: '/', replace: true });
    }
  },
});

const productsRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: 'products',
  component: ProductsPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    localeRoute.addChildren([productsRoute /* …other routes */]),
  ]),
});
```

Same matching behaviour as file-based. The file-based form is much shorter and is what new Lovable projects use.

### Migrating from React Router

If you're porting an existing React Router app: every `<Route path="/foo">` becomes a `src/routes/{-$locale}/foo.tsx` (or a code-based child of `localeRoute`). React Router's "duplicate every route under `/:locale`" pattern is **not** needed in TanStack — the optional param does it for you.

## LocalizedLink

TanStack's `<Link>` requires you to pass the locale explicitly as a path param:

```tsx
import { Link } from '@tanstack/react-router';

// Tedious — every link needs the locale param manually
<Link to="/products" params={{ locale: currentLocale === 'en' ? undefined : currentLocale }}>
  Products
</Link>
```

`LocalizedLink` reads the current locale from `TranslationProvider` and injects it for you:

```tsx
import { LocalizedLink } from '@/i18n/LocalizedLink';

<LocalizedLink to="/products">Products</LocalizedLink>
// → on /, renders <a href="/products">
// → on /af/anything, renders <a href="/af/products">
```

Implementation lives in `assets/TranslationProvider.tsx` (exported alongside the provider). It wraps `<Link>` and forwards all props, only overriding `params.locale`. Type safety is slightly loosened compared to raw `<Link>` (the `to` prop is `string` rather than the inferred route-tree union); users who want strict type-safety can call TanStack's `<Link>` directly with explicit params.

### Programmatic navigation

Use TanStack's `useNavigate` and pass the locale:

```tsx
import { useNavigate } from '@tanstack/react-router';
import { useTranslationContext } from '@/i18n/TranslationProvider';

const navigate = useNavigate();
const { locale } = useTranslationContext();

navigate({
  to: '/products',
  params: { locale: locale === 'en' ? undefined : locale },
});
```

A `useLocalizedNavigate()` helper in `assets/TranslationProvider.tsx` wraps this so call sites stay short:

```tsx
const localizedNavigate = useLocalizedNavigate();
localizedNavigate({ to: '/products' });
// locale param injected automatically
```

## LanguageSwitcher

Drop-in component, no required props:

```tsx
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';

<nav>
  {/* ... */}
  <LanguageSwitcher />
</nav>
```

Renders a button/dropdown listing the four locales by their **native** name (English, Afrikaans, isiZulu, isiXhosa). On click it:

1. Calls TanStack's `useNavigate` with the current `to` path and the new locale param. Same path, different locale.
2. Writes the choice to `localStorage['tx:preferred-locale']`.
3. Uses `replace: false` so the back button returns to the previous locale.

The current locale is shown as selected/disabled. Styling is left to the consumer (`assets/LanguageSwitcher.tsx` uses minimal class names; restyle freely).

To use a different UI (toggle, flag icons, etc.) — call `setLocale(code)` from context yourself. The context handles both the navigation and the localStorage write.

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

Behaviour: on the very first visit (no `tx:preferred-locale` set), if `navigator.language.split('-')[0]` is in `supportedLocales`, navigate to the matching prefix.

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

### Route loaders

TanStack `loader` and `beforeLoad` run *before* the React tree mounts, so the `useTranslate` hook isn't available there. If a loader needs translated strings (e.g. for the document title), translate inline:

```tsx
export const Route = createFileRoute('/{-$locale}/products')({
  loader: async ({ params }) => {
    // Don't useTranslate here — call the Edge Function directly if you really need it
    return { /* data */ };
  },
  head: () => ({ meta: [{ title: 'Products' }] }), // English; consider per-locale heads
});
```

Per-locale `<head>` content (titles, meta descriptions) is best handled with a small `useDocumentTitle(t('Products'))` hook called from the component body, not from `loader`. The skill does not ship a meta-translation helper — too coupled to specific SEO patterns.

### Server-rendered HTML (SSR / prerender / TanStack Start)

If you're prerendering for SEO, or using TanStack Start with SSR enabled, the hook needs to run on the server too. The Supabase client must be available at SSR time and authenticated (anon key is fine — translation rows are public-read). See `references/architecture.md` § SEO and SSR — the hook is build-time-aware when given a locale prop instead of reading from URL.

## What to check after wiring this up

- [ ] `/` renders English; no calls visible in Network panel to `functions/v1/translate`.
- [ ] `/af/` (or `/zu/`, `/xh/`) renders translated, with one call per unique `<T>` string on first visit.
- [ ] Reloading `/af/` makes zero Edge Function calls — all served from localStorage.
- [ ] Switching languages via `<LanguageSwitcher>` round-trips through all four locales, URL updates correctly, no stuck prefixes.
- [ ] `/foo/products` (bogus prefix) redirects to `/products` (or wherever your `beforeLoad` sends it) without rendering anything broken.
- [ ] An English page with an `<a href="/products">` (raw HTML, not `<LocalizedLink>`) jumps to the English version — confirms `<LocalizedLink>` is being used where intended.
- [ ] `localStorage` shows `tx:preferred-locale` and a growing list of `tx:{hash}:{locale}` keys.
- [ ] Editing a `<T>` string and reloading retranslates it (new hash → cache miss → fresh API call).
- [ ] No `<T>` wrapping an interpolated string (`${...}` inside the children). Grep for `<T>{\`` and `useTranslate(\`` in the codebase.

## Common errors

- **"`useRouterState` called outside `RouterProvider`".** `TranslationProvider` is mounted outside the TanStack router context. Move it into `__root.tsx`'s component.
- **`Cannot read properties of undefined (reading 'pathname')`.** Same root cause — the provider is rendering before the router mounts.
- **`/foo/products` matches the route but `params.locale === 'foo'`.** The layout's `beforeLoad` is missing or doesn't redirect. Add the validation pattern in § File-based routing.
- **Switching locales via the switcher updates `localStorage` but not the URL.** `LanguageSwitcher` is calling `setLocale(code)` only, not navigating. Either use the bundled switcher or also call `navigate({ to: currentPath, params: { locale: newCode } })`.
- **`<LocalizedLink>` to `/products` with locale `af` ends up at `/af/af/products`.** The `to` prop already contains a locale prefix — pass the unprefixed path. `to` is logical; `LocalizedLink` does the prefixing via `params.locale`.
- **Translation flashes English on every navigation.** The in-memory cache is being thrown away between routes because the provider is unmounting. Confirm `TranslationProvider` is in `__root.tsx` (lives once for the app), not in `{-$locale}.tsx` (re-mounts on every locale change).
- **Translations work in dev but not after `vite build && vite preview`.** The Supabase URL or anon key is missing from the build's env. Check `.env.production` and Lovable's deploy env.
- **First paint shows blank text, not English fallback.** `<T>` is rendering with `fallback={''}` or the `suspend` option is on without a Suspense boundary. Use the default — pass no `fallback`, no `suspend`.
- **TypeScript errors on `<LocalizedLink to="/products">`.** TanStack's `<Link>` infers `to` from the route tree; the wrapper widens it to `string`. Either accept the looser typing or call `<Link>` directly with explicit `params={{ locale }}`.
- **Translation function called for `target_lang = 'en'`.** The hook isn't short-circuiting when locale is `en`. Confirm the first line of `useTranslate` returns `text` immediately when `locale === 'en'`.

Sources:
- [TanStack Router Path Params](https://tanstack.com/router/latest/docs/guide/path-params)
- [TanStack Router Internationalization (i18n)](https://tanstack.com/router/latest/docs/guide/internationalization-i18n)
- [TanStack Router Navigation](https://tanstack.com/router/latest/docs/guide/navigation)
