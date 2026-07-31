import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Long-lived API keys for headless clients (the MCP server, scripts, CI).
 *
 * MCP clients are configured from a static JSON file and cannot complete a
 * browser OAuth flow, so they cannot hold a short-lived Supabase JWT. They
 * present one of these keys instead; the server resolves it to the same user
 * id a JWT would have produced, so every downstream check is unchanged.
 */

/** Visible prefix. `live` leaves room for a future `pbx_test_` variant. */
const KEY_PREFIX = 'pbx_live_';

/** Characters of the plaintext kept in the clear so users can identify a key. */
const DISPLAY_PREFIX_LEN = KEY_PREFIX.length + 6;

export interface MintedKey {
  /** Full secret. Shown to the user ONCE — it is not recoverable afterwards. */
  plaintext: string;
  /** What actually goes in the database. */
  hash: string;
  /** Non-secret display fragment, e.g. `pbx_live_a1b2c3`. */
  prefix: string;
}

/**
 * Hash a key for storage/lookup.
 *
 * A plain SHA-256 is correct here, where it would be wrong for a password:
 * these keys are 256 bits of CSPRNG output, so there is no dictionary to
 * attack and no need for the deliberate slowness of bcrypt/argon2. A fast
 * hash also keeps it usable as an indexed lookup column.
 */
export function hashApiKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Generate a new key. The plaintext is never persisted. */
export function mintApiKey(): MintedKey {
  const plaintext = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, DISPLAY_PREFIX_LEN),
  };
}

/** Cheap shape check so obvious non-keys never reach the database. */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX);
}

export interface ResolvedApiKey {
  userId: string;
  apiKeyId: string;
}

/**
 * Resolve a plaintext key to its owner, or null if it is unknown or revoked.
 *
 * Lookup is by hash, so the plaintext is never compared in the database and a
 * dump of `api_keys` yields nothing usable.
 */
export async function resolveApiKey(
  supabase: SupabaseClient,
  plaintext: string,
): Promise<ResolvedApiKey | null> {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, user_id')
    .eq('key_hash', hashApiKey(plaintext))
    .is('revoked_at', null)
    .maybeSingle();

  if (error || !data) return null;

  // Best-effort "last used" stamp. Deliberately not awaited: it is a UI nicety
  // and must never add latency to — or fail — an otherwise valid request.
  void supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(undefined, () => {});

  return { userId: data.user_id as string, apiKeyId: data.id as string };
}
