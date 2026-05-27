// lovable-translation-za: TranslationProvider
//
// Place at: src/i18n/TranslationProvider.tsx
// Mount inside src/routes/__root.tsx, wrapping <Outlet />.
//
// Owns:
// - Locale state (derived from URL pathname)
// - Persistence to localStorage['tx:preferred-locale']
// - The in-memory translation cache shared across all <T> / useTranslate calls
// - Optional one-shot browser-locale detection on first visit

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import languages from './za-languages.json';

export type SupportedLocale = 'en' | 'af' | 'zu' | 'xh';

const DEFAULT_LOCALE: SupportedLocale =
  (languages.default as SupportedLocale) ?? 'en';
const DEFAULT_SUPPORTED: SupportedLocale[] =
  (languages.supported as SupportedLocale[]) ?? ['en', 'af', 'zu', 'xh'];
const STORAGE_KEY = 'tx:preferred-locale';

export interface TranslationContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  supportedLocales: SupportedLocale[];
  /** In-memory translation cache. Internal — used by useTranslate. */
  cache: Map<string, string>;
}

const TranslationContext = createContext<TranslationContextValue | null>(null);

interface TranslationProviderProps {
  children: ReactNode;
  supportedLocales?: SupportedLocale[];
  /** On first ever visit, if navigator.language matches a supported locale,
   *  navigate to that locale's prefix. Default: false. */
  detectBrowserLocale?: boolean;
  onLocaleChange?: (locale: SupportedLocale) => void;
}

function parseLocaleFromPathname(
  pathname: string,
  supported: SupportedLocale[],
): SupportedLocale {
  const first = pathname.split('/')[1] ?? '';
  return (supported as string[]).includes(first) && first !== DEFAULT_LOCALE
    ? (first as SupportedLocale)
    : DEFAULT_LOCALE;
}

export function TranslationProvider({
  children,
  supportedLocales = DEFAULT_SUPPORTED,
  detectBrowserLocale = false,
  onLocaleChange,
}: TranslationProviderProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();

  const locale = useMemo(
    () => parseLocaleFromPathname(pathname, supportedLocales),
    [pathname, supportedLocales],
  );

  // Persist the choice so the switcher can highlight the active option.
  // This does NOT trigger redirects on its own — URL is the source of truth.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // localStorage may be disabled (private browsing, embedded contexts).
    }
    onLocaleChange?.(locale);
  }, [locale, onLocaleChange]);

  // One-time browser-locale detection. Fires once per browser; clearing
  // localStorage re-arms it.
  const hasCheckedBrowserRef = useRef(false);
  useEffect(() => {
    if (!detectBrowserLocale || hasCheckedBrowserRef.current) return;
    hasCheckedBrowserRef.current = true;

    let previous: string | null = null;
    try {
      previous = localStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (previous) return; // not the first visit

    const browser = (
      typeof navigator !== 'undefined' ? navigator.language : ''
    ).split('-')[0];

    if (
      browser &&
      browser !== DEFAULT_LOCALE &&
      (supportedLocales as string[]).includes(browser)
    ) {
      navigate({
        to: '.',
        params: (prev: Record<string, string | undefined>) => ({
          ...prev,
          locale: browser,
        }),
        replace: true,
      });
    }
  }, [detectBrowserLocale, navigate, supportedLocales]);

  const setLocale = useCallback(
    (next: SupportedLocale) => {
      navigate({
        to: '.',
        params: (prev: Record<string, string | undefined>) => ({
          ...prev,
          locale: next === DEFAULT_LOCALE ? undefined : next,
        }),
        replace: false,
      });
    },
    [navigate],
  );

  // The in-memory cache is a ref — same Map across renders, never replaced.
  const cacheRef = useRef<Map<string, string>>(new Map());

  const value = useMemo<TranslationContextValue>(
    () => ({
      locale,
      setLocale,
      supportedLocales,
      cache: cacheRef.current,
    }),
    [locale, setLocale, supportedLocales],
  );

  return (
    <TranslationContext.Provider value={value}>
      {children}
    </TranslationContext.Provider>
  );
}

export function useTranslationContext(): TranslationContextValue {
  const ctx = useContext(TranslationContext);
  if (!ctx) {
    throw new Error(
      'useTranslationContext must be used inside <TranslationProvider>',
    );
  }
  return ctx;
}
