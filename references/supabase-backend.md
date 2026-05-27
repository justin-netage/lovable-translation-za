# Supabase Backend

The cache table, RLS policies, and the `translate` Edge Function. This file covers the shape and the decisions; the full files are in `assets/schema.sql` and `assets/edge-function-translate.ts` ready to drop in.

## Why two pieces

The backend has exactly two moving parts:

1. **A `translations` table** that holds every translation the system has ever produced, keyed by content hash.
2. **A `translate` Edge Function** that the client calls. On cache hit it returns the cached row; on miss it talks to Google, writes the result, and returns it.

That's it. No RPC, no triggers, no scheduled jobs. The hash-keyed cache means nothing ever needs to be invalidated; editing source text simply produces a new hash and a new row on next visit.

## Schema

The complete DDL lives in `assets/schema.sql`. The shape:

```sql
CREATE TABLE public.translations (
  source_hash    text         NOT NULL,
  target_lang    text         NOT NULL,
  source_text    text         NOT NULL,
  translated_text text        NOT NULL,
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (source_hash, target_lang),
  CONSTRAINT target_lang_valid CHECK (target_lang IN ('af', 'zu', 'xh'))
);

CREATE INDEX translations_target_lang_idx ON public.translations (target_lang);
```

Decisions worth knowing:

- **Composite primary key `(source_hash, target_lang)`.** Same source text translates differently into different locales; both columns are needed for uniqueness. `source_hash` leads the key because client lookups always filter by hash first.
- **`source_text` is stored alongside the hash** even though it's redundant for lookups. It makes the table inspectable — you can see what was translated without recomputing hashes. Costs a little storage; pays for itself the first time you debug a mistranslation.
- **No `source_lang` column.** Source is always English in this skill. If you need polyglot source later, that's a column add and a PK change — explicit migration, not a runtime decision.
- **`target_lang` is constrained at the DB level.** Bad client code can't write `target_lang = 'fr'` into the cache and pollute it. If you add a language, update the CHECK constraint.
- **No row-level `expires_at`.** Cache entries don't expire — they become unreachable when the source text changes (new hash → no row → write new row). The old row stays around as dead weight; see "Pruning" below.

## RLS policies

The table is enabled for Row Level Security, with one policy:

```sql
ALTER TABLE public.translations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "translations_select_public"
  ON public.translations
  FOR SELECT
  TO anon, authenticated
  USING (true);
```

That's the only policy. There is intentionally **no `INSERT` or `UPDATE` policy** for `anon` or `authenticated` — which means those roles are denied writes by default (RLS without a matching policy denies). Writes happen only from the Edge Function, which uses the `service_role` key and bypasses RLS.

This means:

- A logged-out visitor on `/af/products` can read translations directly via PostgREST if we ever want to. (We don't — the client always goes through the Edge Function — but it's a safe escape hatch for prefetch tooling at build time.)
- Nobody who has only the anon key can corrupt the cache.
- The `service_role` key (used by the Edge Function) must never be shipped to the client. This is a general Supabase rule; just calling it out because this skill is one of the cases where the service role's write capability matters.

## The Edge Function — `translate`

Folder location: `supabase/functions/translate/index.ts`. The complete implementation lives in `assets/edge-function-translate.ts`.

### What it accepts

```ts
// POST /functions/v1/translate
// Body:
{
  "text": "Add to cart",
  "target_lang": "af"   // one of 'af' | 'zu' | 'xh'
}
```

The function requires a valid Supabase JWT (anon or user). Default — keep it on. Turning off JWT verification (`verify_jwt = false` in the function config) opens the endpoint to the public internet and is the single fastest way to burn through your Google free tier. Don't.

### What it does — pseudocode

```
1. Parse body → { text, target_lang }
2. Validate target_lang is in ['af', 'zu', 'xh']. Reject 400 otherwise.
3. Normalise text: trim + collapse internal whitespace. (Matches client normalisation.)
4. hash = sha256(normalised_text)
5. SELECT translated_text FROM translations
     WHERE source_hash = $1 AND target_lang = $2
   If row exists → return { translated_text }. DONE.
6. accessToken = getCachedGoogleToken() ?? exchangeServiceAccountForToken()
7. POST translation.googleapis.com/v3/projects/{PROJECT_ID}/locations/global:translateText
     headers: Authorization: Bearer accessToken
     body: { contents: [text], sourceLanguageCode: 'en', targetLanguageCode: target_lang, mimeType: 'text/plain' }
8. INSERT INTO translations (source_hash, target_lang, source_text, translated_text)
     VALUES (hash, target_lang, normalised_text, response.translations[0].translatedText)
   ON CONFLICT (source_hash, target_lang) DO UPDATE SET
     translated_text = EXCLUDED.translated_text,
     updated_at = now();
9. Return { translated_text }.
```

### Module-scope state

Two pieces of state live across warm invocations:

- `cachedGoogleToken: { token: string, exp: number } | null` — the access token, valid for ~1 hour.
- `cachedSupabaseClient: SupabaseClient` — created once on cold start with the service role key.

On Supabase Edge Functions (Deno Deploy), module-scope state persists for the lifetime of an instance (~minutes of idleness before recycle). The token cache is the difference between ~50ms warm calls and ~200ms cold ones.

### Required env vars

```
GOOGLE_TRANSLATE_SA_JSON   # the full service account JSON, as a string
GOOGLE_PROJECT_ID          # the GCP project ID, e.g. "lovable-myapp-123456"
SUPABASE_URL               # auto-set by Supabase
SUPABASE_SERVICE_ROLE_KEY  # auto-set by Supabase
```

The first two are set via `supabase secrets set ...` — see `references/google-cloud-translation.md` step 4. The Supabase ones are populated automatically; don't set them manually.

### Error handling

The function should surface, not swallow, real errors but degrade gracefully on transient ones:

| Failure | Status | Body | Client should... |
|---|---|---|---|
| Body missing `text` or `target_lang` | 400 | `{ error: "bad_request", detail }` | Treat as a bug; log. |
| `target_lang` not in closed set | 400 | `{ error: "unsupported_locale" }` | Fall back to source text. |
| Google returns 5xx | 502 | `{ error: "provider_error", detail }` | Retry once, then fall back to source text. |
| Google quota exhausted | 429 | `{ error: "rate_limited" }` | Back off; render source text. |
| Cache row exists but Google call fails (shouldn't happen — cache hit returns before Google call) | n/a | n/a | n/a |
| Cache miss + Google success but DB write fails | 200 with translation | `{ translated_text, _warning: "cache_write_failed" }` | Use the translation; the next visitor will refill the cache. |

The principle: the user-visible page should never be blank because translation failed. Falling back to source English is correct behaviour.

## Client invocation

From the `useTranslate` hook (full implementation in `assets/useTranslate.tsx`):

```ts
const { data, error } = await supabase.functions.invoke('translate', {
  body: { text: normalisedText, target_lang: locale }
});

if (error || !data?.translated_text) {
  return text; // fall back to source
}
return data.translated_text;
```

The Supabase JS client attaches the anon JWT automatically. No extra headers needed.

## Migrations and deployment

The Supabase project layout the skill assumes:

```
supabase/
├── config.toml
├── migrations/
│   └── 20260527000000_translations.sql   # ← from assets/schema.sql
└── functions/
    └── translate/
        └── index.ts                       # ← from assets/edge-function-translate.ts
```

Deploy in this order on first install:

```bash
# 1. Apply schema
supabase db push

# 2. Set secrets
supabase secrets set GOOGLE_TRANSLATE_SA_JSON="$(cat path/to/sa-key.json)"
supabase secrets set GOOGLE_PROJECT_ID="your-project-id"

# 3. Deploy the function
supabase functions deploy translate

# 4. Smoke test
supabase functions invoke translate --body '{"text":"Hello","target_lang":"af"}'
# Expect: { "translated_text": "Hallo" }
```

If steps 2 and 3 swap order, the first invocation will fail with `UNAUTHENTICATED` (secrets unset). Re-run `supabase functions deploy translate` after secrets are set, or wait ~10s — secrets propagate quickly but not instantly.

## Pruning (optional)

Cache rows become unreachable when their source string changes. They're not harmful — just storage. If the `translations` table ever grows uncomfortably large, prune the unreachable rows:

```sql
DELETE FROM translations
WHERE updated_at < now() - interval '90 days'
  AND source_hash NOT IN (
    -- replace with: hashes of every <T> string currently in the codebase
    -- (extract via a build-time scan; out of scope for this skill)
    SELECT 'never_matches' WHERE false
  );
```

In practice, prune by age only — rows untouched for 90+ days are almost certainly orphaned. Schedule with `pg_cron` if it bothers you:

```sql
SELECT cron.schedule('prune-stale-translations', '0 3 1 * *', $$
  DELETE FROM translations WHERE updated_at < now() - interval '90 days';
$$);
```

Most projects can ignore this entirely. The cost of holding a million 200-byte translation rows is ~$0.20/month on Supabase.

## What to check after wiring this up

- [ ] `select count(*) from translations` returns 0 immediately after `supabase db push`.
- [ ] `\d translations` (or Studio table view) shows the composite PK, the CHECK constraint on `target_lang`, and the secondary index.
- [ ] RLS is **enabled** on the table (`\d translations` shows `Row Level Security: yes` or Studio shows "RLS enabled").
- [ ] Exactly one policy exists, of type SELECT, on roles `anon, authenticated`.
- [ ] As anon: `select * from translations limit 1` succeeds; `insert into translations(...) values (...)` fails with `permission denied`.
- [ ] As service_role: insert succeeds.
- [ ] `supabase secrets list` shows `GOOGLE_TRANSLATE_SA_JSON` and `GOOGLE_PROJECT_ID`.
- [ ] Function logs (`supabase functions logs translate`) show no errors on first smoke-test call.
- [ ] Second smoke-test call with the same body returns much faster (cache hit, no Google call). Confirm by tailing logs.
- [ ] A row appears in `translations` with the source text, target_lang `af`, and a non-trivial `translated_text`.

## Common errors

- **Function deploys but `invoke` returns `Function not found`.** The function name in the deploy command doesn't match the folder name. Folder must be `supabase/functions/translate/`, deploy command must be `supabase functions deploy translate`.
- **`new row violates row-level security policy for table "translations"`.** The Edge Function is using the anon key instead of the service role key. Confirm `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` not `SUPABASE_ANON_KEY` inside the function.
- **`CHECK constraint "target_lang_valid" violated`.** Client sent a locale that isn't in the closed set. Either the router let an unknown locale through, or you're extending languages — add the new code to both the CHECK and the router.
- **Cache miss writes are duplicating instead of upserting.** The `ON CONFLICT` clause is missing or has the wrong column list. Must be `ON CONFLICT (source_hash, target_lang)`, matching the PK exactly.
- **Translation works locally but 401s in production.** Production has a different Supabase project; secrets weren't set on the production project. `supabase link --project-ref <prod-ref>` then re-run `supabase secrets set`.
- **`Resource not accessible by integration` when running `supabase db push`.** The CLI is logged in as a different user than the project owner, or the project's access token expired. `supabase login` to refresh.
- **Edge Function works but takes 2-3 seconds on every call, including cache hits.** Module-scope state isn't persisting — the function is probably exporting using `export default async function handler(req) { ... }` but creating the Supabase client and token cache *inside* the handler. Move them to module scope (top of file).
