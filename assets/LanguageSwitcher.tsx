// lovable-translation-za: language switcher UI
//
// Place at: src/i18n/LanguageSwitcher.tsx
//
// Renders a minimal native <select> with one option per supported locale,
// labelled by native name (English, Afrikaans, isiZulu, isiXhosa). On
// change it calls setLocale from context, which navigates and updates
// localStorage in one step.
//
// To swap the UI (custom dropdown, flag icons, toggle group, etc.) call
// setLocale(code) from your own component:
//
//   const { setLocale, locale, supportedLocales } = useTranslationContext();
//
// This component is the default — accessible, no design opinion, easy to
// restyle via the `className` prop or by replacing entirely.

import type { CSSProperties } from 'react';
import {
  useTranslationContext,
  type SupportedLocale,
} from './TranslationProvider';
import languages from './za-languages.json';

interface LanguageSwitcherProps {
  className?: string;
  style?: CSSProperties;
  /** Accessible label for the control. Default: "Language". */
  ariaLabel?: string;
}

interface LanguageMeta {
  code: string;
  name: string;
  nativeName: string;
  rtl: boolean;
  urlPrefix: string | null;
}

const META = languages.languages as Record<string, LanguageMeta>;

export function LanguageSwitcher({
  className,
  style,
  ariaLabel = 'Language',
}: LanguageSwitcherProps) {
  const { locale, setLocale, supportedLocales } = useTranslationContext();

  return (
    <select
      className={className}
      style={style}
      value={locale}
      onChange={(e) => setLocale(e.target.value as SupportedLocale)}
      aria-label={ariaLabel}
      data-testid="language-switcher"
    >
      {supportedLocales.map((code) => (
        <option key={code} value={code}>
          {META[code]?.nativeName ?? code}
        </option>
      ))}
    </select>
  );
}
