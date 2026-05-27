-- lovable-translation-za: translations cache table
--
-- One row per (source_text, target_lang). Source text is always English
-- in this skill. Cache key is the SHA-256 of normalised source text so
-- editing the source string in JSX produces a new hash and a new row
-- automatically — no manual invalidation needed.
--
-- This file is intended to be placed at:
--   supabase/migrations/YYYYMMDDHHMMSS_translations.sql
-- and applied with:
--   supabase db push

CREATE TABLE IF NOT EXISTS public.translations (
  source_hash      text         NOT NULL,
  target_lang      text         NOT NULL,
  source_text      text         NOT NULL,
  translated_text  text         NOT NULL,
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (source_hash, target_lang),
  CONSTRAINT target_lang_valid CHECK (target_lang IN ('af', 'zu', 'xh'))
);

-- Secondary index for occasional per-locale analytics
-- (e.g. "how many rows do we have for zu?"). The PK already covers
-- the source_hash lookup path used by the Edge Function.
CREATE INDEX IF NOT EXISTS translations_target_lang_idx
  ON public.translations (target_lang);

-- RLS: anon and authenticated can read; only service_role writes.
-- Service role bypasses RLS, so no INSERT/UPDATE policies are needed.
ALTER TABLE public.translations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "translations_select_public" ON public.translations;
CREATE POLICY "translations_select_public"
  ON public.translations
  FOR SELECT
  TO anon, authenticated
  USING (true);
