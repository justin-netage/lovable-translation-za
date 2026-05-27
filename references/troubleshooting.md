# Troubleshooting

Symptom-first guide. When something looks wrong, find the row that matches what you're seeing, narrow the failure to one layer, and follow the fix or the cross-reference.

## Diagnostic ladder — narrow it in 60 seconds

When something's broken, run these four checks in order. The first failure tells you which layer to investigate.

1. **Browser → DevTools → Network.** Visit `/af/`. Is `functions/v1/translate` being called at all?
   - **No call** → client problem. Provider not mounted, hook short-circuiting on the wrong condition, or locale not parsed from URL.
   - **Call returns 4xx** → client sent bad input, or auth (anon JWT) is missing.
   - **Call returns 5xx** → Edge Function or Google problem (jump to step 2).
   - **Call returns 200 but UI doesn't update** → React state issue. Likely re-render not triggered; check the hook's setState.
2. **`supabase functions logs translate --tail`.** Tail the function logs and reload the page.
   - **No log entries** → request isn't reaching the function. Check the function name in the deploy, and confirm the project ref the client is pointing at.
   - **Logs show DB query but no Google call** → cache hit (expected when warm). Try a fresh string.
   - **Logs show Google call failing** → jump to step 3.
   - **Logs show "permission denied" on the DB write** → Edge Function is using anon key instead of service role. See `references/supabase-backend.md` § Common errors.
3. **GCP Console → APIs & Services → Credentials → service account → "Metrics" tab.** Are requests showing up?
   - **No requests** → token exchange failed. Check `oauth2.googleapis.com/token` errors in function logs.
   - **Requests with 4xx** → API not enabled, wrong project ID, or invalid locale.
   - **Requests with 5xx or 429** → Google's problem or quota. See `references/google-cloud-translation.md` § Common errors.
4. **Supabase Studio → Table editor → `translations`.** Manually query a row.
   - **Row exists with correct translation** → cache is fine; problem is downstream of the function. Re-check the function's response shape against what the hook expects.
   - **Row exists with empty/garbage translation** → Google returned junk OR your function wrote `text` to the wrong column.
   - **No row after a confirmed call** → upsert is silently failing. Check the function logs for DB write errors.

## Symptom catalog

### "I see English on `/af/`, never anything else"

| Possible cause | How to confirm | Fix |
|---|---|---|
| Provider not mounted | `console.log` inside `useTranslate` for `locale` value | Wrap `<App>` in `<TranslationProvider>` *inside* `<BrowserRouter>` |
| URL prefix not parsed | The provider's pathname-split result is `''` instead of `'af'` | Confirm `pathname.split('/')[1]` and that you're checking against `'af'`, not `'/af'` |
| `useTranslate` short-circuits before the locale switch | First line returns `text` regardless of locale | The short-circuit must check `locale === 'en'`, not `!locale` |
| Locale validation rejects `'af'` | The `supportedLocales` array is mis-typed | Confirm exact strings: `['en','af','zu','xh']`, no spaces |
| `/af/products` doesn't have a route match | React Router returns `<NotFound />` and you can't tell | Add the `:locale`-prefixed twin routes per `client-integration.md` § Option B |

### "Some strings translate, others don't"

Almost always: the untranslated strings aren't wrapped in `<T>` or `useTranslate`. Open DevTools, find the offending string, and inspect the element — if there's no `<span>` wrapper from `<T>`, that's your issue. Grep the source for the literal text to find the unwrapped JSX.

Less commonly: the string contains characters that `JSON.stringify` mangles (NUL, lone surrogates). Trim those out at the source.

### "Translation flickers / shows English briefly, then the real translation"

Expected behaviour on first ever render of a fresh string. The flicker is one async round-trip (~200ms warm cache, ~500ms cold). If it's happening on every render, not just first:

- The in-memory cache isn't being read because the provider is re-mounting. See `client-integration.md` § Common errors.
- You set `fallback=""` and a Suspense boundary is showing then dismissing.

To eliminate the flicker entirely for SEO-critical content, prerender — see `references/architecture.md` § SEO and SSR.

### "Translation is wrong / unnatural / mistranslates a brand name"

Three escalating options:

1. **Don't translate the term.** Replace the literal string with a token. `<T>Welcome to {brand}</T>` and interpolate `brand = 'Pick n Pay'` after. Brand names should never go through translation.
2. **Use a Google glossary.** v3 supports per-call glossary resources that fix specific terms. Out of scope for the skill's default Edge Function but supported by the API — see Google's docs on `CreateGlossary`.
3. **Override in the cache directly.** `UPDATE translations SET translated_text = $1 WHERE source_hash = $2 AND target_lang = $3`. The override sticks until the source string changes. Good for one-off fixes; brittle as policy.

### "Same string gets translated twice with different results"

The hash differs between the two requests. Causes, ordered by frequency:

- Trailing space or invisible character in one of the source strings (common with copy-pasted text from Slack / Notion).
- Client and server are normalising whitespace differently. Both must trim + collapse internal whitespace identically. See `references/architecture.md` § Content-hash invalidation.
- The string contains an interpolated value (`Total: R${total}`). Each price is a new hash. See the interpolation gotcha in `client-integration.md`.

To find offenders: `SELECT source_hash, source_text, count(*) FROM translations GROUP BY source_hash, source_text HAVING count(*) > 1` — except this won't find them because hashes differ. Instead: `SELECT source_text, count(*) FROM translations GROUP BY source_text HAVING count(*) > 1` shows source strings that hash to multiple keys.

### "Costs are spiking / free tier already used up in week one"

Stop the bleeding first, diagnose second. See § Kill switch below.

Diagnosis once stable:

```sql
-- Top sources by row count (high count = same string with many hash variants)
SELECT source_text, count(*) AS variants
FROM translations
GROUP BY source_text
HAVING count(*) > 5
ORDER BY variants DESC
LIMIT 20;

-- Total characters translated this month, by target language
SELECT target_lang, sum(char_length(source_text)) AS chars
FROM translations
WHERE updated_at >= date_trunc('month', now())
GROUP BY target_lang;
```

If "variants" is large for any string, that's a `useTranslate(\`...${var}...\`)` — find it and fix it (template-and-replace pattern in `client-integration.md`).

If a particular `target_lang` has hugely more characters than others, something is bulk-translating one locale (e.g. a build-time prerender misconfigured to retranslate every visit).

### "Translation calls all return 401 after a few hours"

Two distinct flavours:

- **`401` from `oauth2.googleapis.com`** in function logs — the Google access token expired and the cache isn't refreshing. The token cache logic in `assets/edge-function-translate.ts` checks expiry with a ~60s safety margin; if you've modified it, that margin may be wrong or missing.
- **`401` from the *Edge Function* itself**, never reaching Google — the Supabase anon JWT used by the client is expired or absent. This is the "reload keeps asking me to login" cousin: a session-management bug in the app, not the translation system. The Supabase JS client should refresh the anon JWT automatically; if it's not, the client config has `persistSession: false` or `autoRefreshToken: false`.

### "Edge Function is slow — 2+ seconds even when cache should hit"

| Cause | Confirm | Fix |
|---|---|---|
| Cold start every call | First call after 5+ min idle is slow, subsequent fast | Expected. Use a heartbeat ping if you need warm-only. |
| Supabase client created inside handler | Logs show "creating client" on every call | Hoist `createClient` to module scope |
| Token cache reset every call | Logs show "fetching token" on every call | Hoist `cachedGoogleToken` to module scope |
| DB query slow | Add `EXPLAIN ANALYZE` on the SELECT | Should be < 5ms; if not, primary key wasn't created correctly |
| Function deployed to a far region | Check function region vs your DB region | Deploy to the same region as the DB |

### "I deployed but the page still shows the old translation"

- Service Worker is caching the old translation. Hard-reload (Ctrl-Shift-R / Cmd-Shift-R) or unregister the SW.
- localStorage has the old translation. Open DevTools → Application → Local Storage → clear keys starting with `tx:`.
- The `translations` row still has the old value because the source text didn't actually change (whitespace-only edit, normalised away). Either change the text meaningfully or `DELETE FROM translations WHERE source_hash = $1`.

### "Same translation appears in two languages"

Google occasionally returns the source text untranslated when it can't translate (very short strings, all-caps acronyms, numbers). For example, `<T>OK</T>` may come back as `"OK"` in all four locales. This is correct behaviour — there's nothing to translate. If you want a different label per locale, override in the DB or use locale-aware UI text (e.g. `useTranslate('Continue')` instead of `'OK'`).

### "Build / prerender failing with translation errors"

Pre-rendering at build runs the hook in a Node environment, not a browser. Without the Supabase URL and anon key set as build env vars, the Supabase client can't authenticate to the Edge Function. Set:

```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
```

in the build environment. The build should NOT have access to the service role key — translations during prerender go through the same Edge Function that runtime traffic uses.

## Kill switch — cost emergency runbook

If costs are running away (free tier exhausted, daily quota threatened, suspected abuse), stop translation in production immediately:

**Option 1 — fastest, brutally simple.** Disable the Cloud Translation API in GCP Console:

```
https://console.cloud.google.com/apis/api/translate.googleapis.com/overview?project={PROJECT_ID}
```

→ Disable API.

The Edge Function will start failing on the Google call. The hook falls back to source English. The user experience degrades; nothing breaks.

**Option 2 — graceful, requires the kill-switch hook.** Set a feature flag in Supabase that the Edge Function checks before calling Google. The default `assets/edge-function-translate.ts` does NOT include this check (it would slow every call by ~10ms). Add when needed:

```sql
INSERT INTO public.app_flags (key, value) VALUES ('translation_enabled', 'false');
```

And in the Edge Function:

```ts
const { data: flag } = await supabase
  .from('app_flags').select('value').eq('key', 'translation_enabled').single();
if (flag?.value === 'false') {
  return new Response(JSON.stringify({ translated_text: text }), { headers });
}
```

Effect: the function returns source text without calling Google. Re-enable by flipping the flag.

**Option 3 — Google budget alert auto-disable.** If you wired the Pub/Sub topic in `references/google-cloud-translation.md` § Budget alerts to a Supabase function, the kill switch can flip automatically at the 100% threshold. The wiring is out of scope for the default skill but the hook in option 2 is the receiver.

After the bleeding stops, diagnose with the queries in "Costs are spiking" above.

## Useful diagnostic commands

```bash
# Tail Edge Function logs in real time
supabase functions logs translate --tail

# Re-run a smoke test from the CLI
supabase functions invoke translate \
  --body '{"text":"Welcome","target_lang":"af"}'

# Inspect current secrets (won't reveal values)
supabase secrets list

# Force-redeploy the function (e.g. after editing without code changes, to bust caches)
supabase functions deploy translate --no-verify-jwt=false

# List which locales have rows for a specific string
psql "$DATABASE_URL" -c "
  SELECT target_lang, translated_text, updated_at
  FROM translations
  WHERE source_text = 'Add to cart'
  ORDER BY target_lang;
"

# Delete a single problematic translation to force refresh
psql "$DATABASE_URL" -c "
  DELETE FROM translations
  WHERE source_text = 'Add to cart' AND target_lang = 'af';
"

# Manually probe Google with a curl, bypassing the function entirely
# (requires the SA JSON locally — only do this on a dev machine)
gcloud auth activate-service-account --key-file=path/to/sa-key.json
TOKEN=$(gcloud auth print-access-token)
curl -sX POST \
  "https://translation.googleapis.com/v3/projects/${PROJECT_ID}/locations/global:translateText" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"contents":["Welcome"],"sourceLanguageCode":"en","targetLanguageCode":"af","mimeType":"text/plain"}'
gcloud auth revoke
```

## When to escalate vs. when to ship a workaround

- **Mistranslation of a key brand term** → workaround: don't translate it (interpolate as a token).
- **One locale consistently lower quality** → workaround: glossary or per-locale overrides in DB. Escalation: nothing to escalate — Google's NMT is what it is. Investigate the LLM-based Cloud Translation models if quality is unacceptable.
- **Cost growing linearly with traffic, not with content** → bug in your interpolation. Workaround: kill switch + fix. Don't ship until fixed.
- **Edge Function reliability < 99%** → don't ship until diagnosed. Translation failures fall back to English, but that's a degraded UX, not a non-feature.
- **`/af/` indexes in Google Search as English** → bug. SSR / prerender is the only fix; the hook can't help here. See architecture.md § SEO and SSR.

## When to remove the skill / revert

If translation is causing more pain than it's worth (cost out of control, latency unacceptable, mistranslation hurting brand):

1. Remove `<TranslationProvider>` from the tree. All `<T>` and `useTranslate` calls become pass-throughs to source English without code changes (locale is always `en` when there's no provider — design the provider's default context that way).
2. Remove the `/:locale` prefixed routes. Optional — they'll just be unreachable.
3. **Don't drop the `translations` table immediately.** It's cheap to keep and re-enabling the skill is a one-line revert if you change your mind.
4. Disable the Cloud Translation API to stop any cost. The Edge Function will fail but no one's calling it now.

This is a soft-revert: removable, re-installable, leaves no debt in source code.
