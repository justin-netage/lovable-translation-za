// lovable-translation-za: Edge Function `translate`
//
// Place at: supabase/functions/translate/index.ts
// Deploy with: supabase functions deploy translate
//
// Required env (set via `supabase secrets set`):
//   GOOGLE_TRANSLATE_SA_JSON  – full service account JSON (one line)
//   GOOGLE_PROJECT_ID         – GCP project ID, e.g. "lovable-myapp-123456"
// Auto-provided by Supabase:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Keep `verify_jwt = true` (the default). The anon JWT is enough — the
// Supabase JS client attaches it automatically. Turning verification off
// opens this endpoint to the public internet and is the fastest way to
// burn through the Google free tier.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPPORTED_LOCALES = ['af', 'zu', 'xh'] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];

interface ServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id: string;
}

// Module-scope state — persists across warm invocations.
let cachedSA: ServiceAccount | null = null;
let cachedPrivateKey: CryptoKey | null = null;
let cachedToken: { token: string; exp: number } | null = null;

const supabase: SupabaseClient = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

const PROJECT_ID = Deno.env.get('GOOGLE_PROJECT_ID');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

class TranslateError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64UrlEncode(input: string | Uint8Array): string {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseServiceAccount(): ServiceAccount {
  if (cachedSA) return cachedSA;
  const raw = Deno.env.get('GOOGLE_TRANSLATE_SA_JSON');
  if (!raw) {
    throw new TranslateError(
      500,
      'misconfigured',
      'GOOGLE_TRANSLATE_SA_JSON is not set',
    );
  }
  const sa = JSON.parse(raw) as ServiceAccount;
  // Private key may arrive with literal \n escapes or real newlines.
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  cachedSA = sa;
  return sa;
}

async function importPrivateKey(): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const sa = parseServiceAccount();
  const pemBody = sa.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  cachedPrivateKey = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return cachedPrivateKey;
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // 60s safety margin — refresh just before expiry.
  if (cachedToken && cachedToken.exp > now + 60) {
    return cachedToken.token;
  }

  const sa = parseServiceAccount();
  const key = await importPrivateKey();

  const header = base64UrlEncode(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }),
  );
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-translation',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );

  const toSign = new TextEncoder().encode(`${header}.${claims}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, toSign),
  );
  const jwt = `${header}.${claims}.${base64UrlEncode(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new TranslateError(
      502,
      'token_exchange_failed',
      `${res.status}: ${detail}`,
    );
  }

  const { access_token, expires_in } = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = { token: access_token, exp: now + expires_in };
  return access_token;
}

async function translateViaGoogle(
  text: string,
  targetLang: Locale,
): Promise<string> {
  if (!PROJECT_ID) {
    throw new TranslateError(
      500,
      'misconfigured',
      'GOOGLE_PROJECT_ID is not set',
    );
  }
  const token = await getAccessToken();
  const url =
    `https://translation.googleapis.com/v3/projects/${PROJECT_ID}` +
    `/locations/global:translateText`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [text],
      sourceLanguageCode: 'en',
      targetLanguageCode: targetLang,
      mimeType: 'text/plain',
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    if (res.status === 429) throw new TranslateError(429, 'rate_limited', detail);
    if (res.status === 401 || res.status === 403) {
      // Token may have been revoked or scope changed. Force a refresh.
      cachedToken = null;
      throw new TranslateError(502, 'provider_auth', detail);
    }
    throw new TranslateError(502, 'provider_error', `${res.status}: ${detail}`);
  }

  const data = (await res.json()) as {
    translations?: Array<{ translatedText?: string }>;
  };
  const translated = data.translations?.[0]?.translatedText;
  if (!translated) {
    throw new TranslateError(502, 'empty_translation');
  }
  return translated;
}

// ────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  try {
    const body = (await req.json().catch(() => null)) as
      | { text?: unknown; target_lang?: unknown }
      | null;

    if (
      !body ||
      typeof body.text !== 'string' ||
      typeof body.target_lang !== 'string'
    ) {
      return json(
        { error: 'bad_request', detail: 'text and target_lang are required strings' },
        400,
      );
    }

    const { text, target_lang } = body;

    if (!(SUPPORTED_LOCALES as readonly string[]).includes(target_lang)) {
      return json({ error: 'unsupported_locale' }, 400);
    }

    const normalised = normalise(text);
    if (normalised === '') {
      return json({ translated_text: '' });
    }

    const hash = await sha256Hex(normalised);

    // 1. Cache lookup.
    const { data: cached, error: lookupErr } = await supabase
      .from('translations')
      .select('translated_text')
      .eq('source_hash', hash)
      .eq('target_lang', target_lang)
      .maybeSingle();

    if (lookupErr) {
      console.error('translations lookup failed', lookupErr);
      // Don't fail the whole request — fall through to Google.
    }

    if (cached?.translated_text) {
      return json({ translated_text: cached.translated_text });
    }

    // 2. Google call.
    const translated = await translateViaGoogle(normalised, target_lang as Locale);

    // 3. Write-through. If write fails, still serve the translation.
    const { error: writeErr } = await supabase
      .from('translations')
      .upsert(
        {
          source_hash: hash,
          target_lang,
          source_text: normalised,
          translated_text: translated,
        },
        { onConflict: 'source_hash,target_lang' },
      );

    if (writeErr) {
      console.error('translations upsert failed', writeErr);
      return json({
        translated_text: translated,
        _warning: 'cache_write_failed',
      });
    }

    return json({ translated_text: translated });
  } catch (e) {
    if (e instanceof TranslateError) {
      return json({ error: e.code, detail: e.detail ?? null }, e.status);
    }
    console.error('translate handler error', e);
    return json({ error: 'internal_error', detail: String(e) }, 500);
  }
});
