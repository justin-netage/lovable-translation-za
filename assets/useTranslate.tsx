// lovable-translation-za: useTranslate hook and <T> component
//
// Place at: src/i18n/useTranslate.tsx
//
// Imports the project's Supabase client from `@/lib/supabase`. If your
// project exports it from a different path, change the import below.

import { useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useTranslationContext } from './TranslationProvider';

interface UseTranslateOptions {
  /** Text shown while the translation is loading. Defaults to source. */
  fallback?: string;
}

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Translate `text` into the current locale.
 *
 * - Returns source text immediately when locale is `en` (no work).
 * - Otherwise: checks in-memory cache, then localStorage, then calls the
 *   Edge Function. While the network call is in flight returns
 *   `options.fallback ?? text` (English source) so the UI is never blank.
 * - On error, logs to console and returns source text.
 *
 * Cache key on the client: `${normalised_text}:${locale}`. The server uses
 * a SHA-256 of the same normalised text. Both sides trim and collapse
 * internal whitespace identically so the caches stay in sync.
 */
export function useTranslate(
  text: string,
  options: UseTranslateOptions = {},
): string {
  const { locale, cache } = useTranslationContext();
  const normalised = normalise(text);
  const isEnglish = locale === 'en';
  const cacheKey = `${normalised}:${locale}`;
  const storageKey = `tx:${cacheKey}`;

  // Re-render trigger — bumped after a successful fetch so the next render
  // reads the freshly written cache entry.
  const [, force] = useState(0);

  // Synchronous cache lookup, runs every render. Cheap: one Map.get plus
  // (at most) one localStorage.getItem on first sight.
  let cached: string | null = null;
  if (isEnglish) {
    cached = text;
  } else {
    const inMem = cache.get(cacheKey);
    if (inMem !== undefined) {
      cached = inMem;
    } else {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored !== null) {
          cache.set(cacheKey, stored);
          cached = stored;
        }
      } catch {
        // localStorage disabled (private browsing / sandbox); ignore.
      }
    }
  }

  useEffect(() => {
    // Skip work if English source or already cached.
    if (isEnglish || cached !== null || normalised === '') return;

    let cancelled = false;

    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('translate', {
          body: { text: normalised, target_lang: locale },
        });

        if (cancelled) return;

        const translated = (data as { translated_text?: string } | null)
          ?.translated_text;

        if (error || !translated) {
          console.error(
            '[useTranslate] translate failed',
            error ?? 'missing translated_text',
          );
          return;
        }

        cache.set(cacheKey, translated);
        try {
          localStorage.setItem(storageKey, translated);
        } catch {
          // localStorage write may fail (quota); the in-memory cache is enough.
        }
        force((n) => n + 1);
      } catch (e) {
        console.error('[useTranslate] unexpected error', e);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, isEnglish, locale, normalised]);

  return cached ?? options.fallback ?? text;
}

interface TProps {
  /** Source English text. Must be a single string child. */
  children: string;
  /** Optional fallback shown while loading. Default: source text. */
  fallback?: string;
}

/**
 * Inline translation component. Equivalent to `useTranslate(children)`.
 *
 *   <T>Add to cart</T>
 *
 * Children MUST be a single string. Mixed children (interpolations,
 * nested elements) won't translate as a unit — use the hook form and
 * the template-and-replace pattern instead:
 *
 *   const t = useTranslate('Total: R{amount}');
 *   return <span>{t.replace('{amount}', total.toString())}</span>;
 */
export function T({ children, fallback }: TProps): ReactNode {
  if (typeof children !== 'string') {
    if (
      typeof process !== 'undefined' &&
      process.env?.NODE_ENV !== 'production'
    ) {
      console.warn(
        '[<T>] children must be a single string. Got:',
        children,
        '\nUse useTranslate() and interpolate manually for mixed content.',
      );
    }
    return <>{children}</>;
  }
  const translated = useTranslate(children, { fallback });
  return <>{translated}</>;
}
