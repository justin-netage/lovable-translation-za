# Google Cloud Translation API

Everything provider-specific lives here: enabling the API, creating a service account, the language codes the skill supports, the request shape, pricing, and budget controls.

## Why v3 specifically

Cloud Translation has two generations:

- **v2 (Basic).** Supports API keys. Simpler to set up. Limited to text translation.
- **v3 (Advanced).** Requires service-account / OAuth bearer tokens — **no API keys**. Adds glossaries, batch translation, custom models, Document Translation. Same pricing as v2 for the base NMT model.

This skill uses **v3** because (a) API keys cooked into Edge Function env are still secrets and v3's IAM-scoped service account is the safer credential, and (b) v3 is what new projects should target — v2 is in long-term maintenance.

Endpoint used by this skill:

```
POST https://translation.googleapis.com/v3/projects/{PROJECT_ID}/locations/global:translateText
```

Region must be `global` for the default NMT model. Other regions exist for data-residency requirements but the public NMT only serves from `global`.

## Setup — one-time, ~10 minutes

### 1. Create or select a GCP project

If you don't already have a project for this app:

1. Go to https://console.cloud.google.com/projectcreate
2. Name it (e.g. `lovable-{appname}`). Note the **project ID** (not the name — it's the lowercase string near the top of the project picker).
3. Link a billing account. **You cannot call the v3 API without billing enabled**, even within the free tier. This is the most common setup blocker.

### 2. Enable the Cloud Translation API

```
https://console.cloud.google.com/apis/library/translate.googleapis.com?project={PROJECT_ID}
```

Click **Enable**. Wait ~30 seconds for it to propagate.

### 3. Create a service account

1. Go to **IAM & Admin → Service Accounts** in the GCP Console.
2. **Create Service Account** → name it `supabase-translator` (description: "Called by Supabase Edge Function for v3 translateText").
3. Grant role: **Cloud Translation API User** (`roles/cloudtranslate.user`). This is the minimum role — it allows calling `translateText` and reading supported-languages, nothing else. Don't grant Editor or Admin.
4. Don't grant any users access to the service account (skip the "Grant users access" step).
5. After creation, open the service account → **Keys** tab → **Add Key → Create new key → JSON**. The JSON downloads. This file is the credential — treat it like a password.

### 4. Store the credential in Supabase

The downloaded JSON looks like:

```json
{
  "type": "service_account",
  "project_id": "lovable-myapp-123456",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "supabase-translator@lovable-myapp-123456.iam.gserviceaccount.com",
  ...
}
```

Set it as an Edge Function secret. The entire JSON goes in as one value:

```bash
supabase secrets set GOOGLE_TRANSLATE_SA_JSON="$(cat path/to/key.json)"
supabase secrets set GOOGLE_PROJECT_ID="lovable-myapp-123456"
```

Verify:

```bash
supabase secrets list
# Expect: GOOGLE_TRANSLATE_SA_JSON, GOOGLE_PROJECT_ID
```

**Delete the local JSON file after the secret is set.** Don't commit it, don't leave it in `~/Downloads`, don't paste it into chat.

### 5. Confirm with a smoke test

```bash
# Locally — sanity check that the credential works at all
gcloud auth activate-service-account --key-file=path/to/key.json
gcloud projects describe {PROJECT_ID}
# Expect: project metadata, no permission error.
```

You can revoke this local activation immediately after (`gcloud auth revoke`); it's just to confirm the JSON file isn't corrupt before pasting it into Supabase.

## Supported languages

The skill ships with four locales. All four are supported by the standard NMT model in v3:

| Locale | Display | Native | Google code | Notes |
|---|---|---|---|---|
| English | English | English | `en` | Source language; no API call needed when target is also `en`. |
| Afrikaans | Afrikaans | Afrikaans | `af` | Long-supported by Google NMT. |
| isiZulu | Zulu | isiZulu | `zu` | First-class NMT support. |
| isiXhosa | Xhosa | isiXhosa | `xh` | First-class NMT support. |

For native-name display, use the Native column verbatim — capitalisation matters in isiZulu/isiXhosa.

### Adding another language

Two checks before extending the locale set:

1. **Is the code supported by v3?** Hit the supported-languages endpoint once:
   ```
   GET https://translation.googleapis.com/v3/projects/{PROJECT_ID}/locations/global/supportedLanguages?display_language_code=en
   ```
   Look for the `languageCode` in the response. Common South African additions that work: `st` (Sesotho), `tn` (Setswana), `sn` (Shona — useful for cross-border).
2. **Will the closed locale set in the router accept it?** Update `assets/za-languages.json` *and* the `:locale?` constraint in the router (see `references/client-integration.md`). Both must agree or the new locale will fall through to English.

## Request and response shape

The skill's Edge Function constructs:

```json
POST /v3/projects/{PROJECT_ID}/locations/global:translateText
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{
  "contents": ["Add to cart"],
  "sourceLanguageCode": "en",
  "targetLanguageCode": "af",
  "mimeType": "text/plain"
}
```

Response:

```json
{
  "translations": [
    { "translatedText": "Voeg by mandjie" }
  ]
}
```

Notes:

- `contents` is an array — Google supports batch translation (up to 1024 strings per request, 30k chars total). The skill issues one string per request from the client, but the Edge Function could be extended to batch — see `references/troubleshooting.md` for when that matters.
- `mimeType: "text/plain"` prevents Google from interpreting `<…>` as HTML. Use `text/html` only if the source actually contains markup you want preserved through the translation.
- Don't pass `sourceLanguageCode` if you're unsure of the source — Google auto-detects. The skill always passes `en` because the source is always English in our usage.

## Authentication — how the Edge Function gets a token

`assets/edge-function-translate.ts` implements this; the summary so you can debug it:

1. Parse `GOOGLE_TRANSLATE_SA_JSON` from env.
2. Build a JWT with header `{ alg: "RS256", typ: "JWT", kid: <private_key_id> }` and claims `{ iss: <client_email>, scope: "https://www.googleapis.com/auth/cloud-translation", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }`.
3. Sign with the private key from the SA JSON (RS256).
4. Exchange the JWT for an access token: `POST https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={JWT}`.
5. Use the returned `access_token` as a Bearer token. It's valid for ~1 hour.
6. Cache the token in module-scope memory (`let cachedToken: { token, exp } | null`) so warm Edge Function invocations skip steps 1-5.

Cold start cost: ~150ms for the JWT exchange. Worth caching.

## Pricing and the free tier

| What | Cost |
|---|---|
| First 500,000 characters per calendar month | **Free** |
| Beyond 500k chars/month, standard NMT (v3) | **$20.00 per 1M characters** |
| Document Translation | $0.08 per page (separate API, not used by this skill) |

A "character" is a Unicode code point counted across **all calls** to `translateText` in the billing period. The 500k free tier resets on the 1st of each month UTC. The cache means each unique source string costs once per locale — typical Lovable app ships with maybe 200-500 unique strings × 3 non-English locales ≈ 30-50k characters total, well inside the free tier on month 1 and ~zero ongoing cost if copy is stable.

The cost blow-up scenario is dynamic content (CMS body text, user-generated posts) that pushes through the translate function for every new piece. Plan for ~3,000 chars per CMS post × 3 locales = 9k chars per post; 500 posts/month ≈ 4.5M chars ≈ $90/month after free tier.

## Budget alerts — set this before you ship

Cost protection is one billing-console click. Skipping it has burned production teams who left a `useTranslate` call inside a `useEffect` loop.

1. Go to **Billing → Budgets & alerts** for the project.
2. **Create budget** → scope to the project → set amount (e.g. $50/month) → alert at 50%, 90%, 100%.
3. Optionally: configure **Programmatic notifications** to a Pub/Sub topic and wire that to a Supabase Edge Function that flips a `translation_disabled` flag — see `references/troubleshooting.md` for the kill-switch pattern.

## What to check after wiring this up

- [ ] Project ID is the lowercase ID, not the display name. (Common mismatch: a project named "Lovable Myapp" has ID `lovable-myapp-123456`.)
- [ ] Cloud Translation API shows **Enabled** in `console.cloud.google.com/apis/dashboard?project={PROJECT_ID}`.
- [ ] Service account has exactly one role: `Cloud Translation API User`. No Owner, no Editor.
- [ ] Service account JSON file is **deleted** from local disk after `supabase secrets set`.
- [ ] `supabase secrets list` shows `GOOGLE_TRANSLATE_SA_JSON` and `GOOGLE_PROJECT_ID`.
- [ ] Billing is enabled on the project (free tier still requires billing to be linked).
- [ ] A budget alert exists for the project.
- [ ] First test call from the Edge Function returns a translated string and writes a row to `translations`.

## Common errors

- **`PERMISSION_DENIED: Cloud Translation API has not been used in project X before or it is disabled.`** Step 2 was skipped, OR the `GOOGLE_PROJECT_ID` secret points at a different project than the one that has the API enabled. Re-enable on the right project.
- **`UNAUTHENTICATED: Request had invalid authentication credentials.`** The SA JSON was edited in transit (often a copy-paste that dropped a newline in `private_key`). Re-export the key and re-set the secret. `private_key` must contain literal `\n` escapes if you're echoing it, or real newlines if you're piping a file — pick one and be consistent.
- **`PERMISSION_DENIED: The caller does not have permission`** (when calling `translateText`, not when enabling). The SA was created but the IAM role wasn't granted, or the role was granted on a different project. Confirm in **IAM & Admin → IAM** that `supabase-translator@...` shows `Cloud Translation API User` for the right project.
- **`INVALID_ARGUMENT: Target language is invalid: af-ZA`.** Don't pass region tags. `af`, `zu`, `xh` not `af-ZA`, `zu-ZA`, `xh-ZA`. (The router can still use `af-ZA` in URLs if you want; just normalise to the 2-letter code before sending to Google.)
- **`RESOURCE_EXHAUSTED: Quota exceeded`.** Default quota is 600k characters/minute and 6M/day; you've hit one. Check `console.cloud.google.com/iam-admin/quotas?project={PROJECT_ID}&service=translate.googleapis.com`. If hit organically, request a quota increase. If hit suspiciously, look for a runaway loop calling `useTranslate` on changing input — see the cost gotcha in `references/architecture.md`.
- **403 from `oauth2.googleapis.com/token` during JWT exchange.** Almost always a clock-skew issue between the Edge Function runtime and Google's token endpoint, or a wrong `aud` claim. The Edge Function must use `aud: "https://oauth2.googleapis.com/token"` exactly — not the translation endpoint.
- **Free tier blew past 500k chars in week one.** Almost certainly a `useTranslate` call on an interpolated string — every value change is a new hash and a new translation. Translate the template; interpolate after.

Sources:
- [Authenticate to Cloud Translation](https://docs.cloud.google.com/translate/docs/authentication)
- [Translation IAM roles](https://cloud.google.com/iam/docs/roles-permissions/cloudtranslate)
- [Cloud Translation pricing](https://cloud.google.com/translate/pricing)
- [Cloud Translation API overview](https://docs.cloud.google.com/translate/docs/api-overview)
