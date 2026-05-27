// lovable-translation-za: locale-preserving navigation helpers
//
// Place at: src/i18n/LocalizedLink.tsx
//
// Three exports:
//
// 1. <LocalizedLink to="/products">  – ergonomic wrapper, `to` is `string`.
//    Use for app-level nav. Looser typing than TanStack's <Link>.
//
// 2. useLocaleParams()  – returns { locale } for spreading into a fully
//    type-safe TanStack <Link>:
//       <Link to="/products" params={useLocaleParams()}>Products</Link>
//
// 3. useLocalizedNavigate()  – imperative version of <LocalizedLink>.
//    Drop-in replacement for TanStack's useNavigate that injects locale.

import { useCallback } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  useTranslationContext,
  type SupportedLocale,
} from './TranslationProvider';
import languages from './za-languages.json';

const DEFAULT_LOCALE: SupportedLocale =
  (languages.default as SupportedLocale) ?? 'en';

type LocaleParam = string | undefined;

function localeParamFor(locale: SupportedLocale): LocaleParam {
  return locale === DEFAULT_LOCALE ? undefined : locale;
}

// ─── useLocaleParams ────────────────────────────────────────────────
// Returns an object suitable for spreading into TanStack's <Link params>.
// Use this with the typed <Link> when type safety matters.

export function useLocaleParams(): { locale: LocaleParam } {
  const { locale } = useTranslationContext();
  return { locale: localeParamFor(locale) };
}

// ─── <LocalizedLink> ────────────────────────────────────────────────
// Ergonomic wrapper around TanStack's <Link>. The `to` prop is a plain
// string here; TanStack's typed `to` (union of known route paths) is not
// preserved through the wrapper. Users who want strict type-safety should
// use TanStack's <Link> directly with useLocaleParams().

interface LocalizedLinkProps {
  to: string;
  params?: Record<string, string | undefined>;
  search?: Record<string, unknown>;
  hash?: string;
  replace?: boolean;
  preload?: 'intent' | 'render' | 'viewport' | false;
  className?: string;
  activeProps?: { className?: string };
  children?: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  /** Allow any other prop TanStack's Link supports. */
  [key: string]: unknown;
}

export function LocalizedLink({
  to,
  params,
  ...rest
}: LocalizedLinkProps) {
  const { locale } = useTranslationContext();
  const mergedParams = { ...(params ?? {}), locale: localeParamFor(locale) };

  // TanStack's <Link> is heavily typed against the route tree. The wrapper
  // accepts `to: string` for ergonomics; cast to satisfy the typed API.
  // Runtime behaviour is unaffected — TanStack matches the path string.
  return (
    <Link
      // @ts-expect-error see comment above
      to={to}
      // @ts-expect-error see comment above
      params={mergedParams}
      {...rest}
    />
  );
}

// ─── useLocalizedNavigate ───────────────────────────────────────────
// Drop-in replacement for TanStack's useNavigate. Injects the current
// locale into `params` so the resulting URL stays in the active locale.

interface LocalizedNavigateOptions {
  to: string;
  params?: Record<string, string | undefined>;
  search?: Record<string, unknown>;
  hash?: string;
  replace?: boolean;
  state?: unknown;
}

export function useLocalizedNavigate() {
  const navigate = useNavigate();
  const { locale } = useTranslationContext();
  const localeParam = localeParamFor(locale);

  return useCallback(
    (options: LocalizedNavigateOptions) => {
      return navigate({
        // @ts-expect-error see <LocalizedLink> comment
        to: options.to,
        // @ts-expect-error see <LocalizedLink> comment
        params: { ...(options.params ?? {}), locale: localeParam },
        search: options.search,
        hash: options.hash,
        replace: options.replace,
        state: options.state,
      });
    },
    [navigate, localeParam],
  );
}
