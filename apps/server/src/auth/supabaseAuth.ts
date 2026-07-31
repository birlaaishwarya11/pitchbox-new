import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Request, Response, NextFunction } from 'express';
import { looksLikeApiKey, resolveApiKey } from './apiKeys';

/** How a request proved who it was. Recorded on every usage event. */
export type AuthSurface = 'web' | 'mcp' | 'api';

export interface AuthedRequest extends Request {
  user?: { id: string; email?: string };
  /**
   * Set when the caller authenticated with an API key rather than a browser
   * session. Null/undefined for web (JWT) requests — which is exactly what
   * makes "web vs headless" separable in the usage data.
   */
  apiKeyId?: string;
  authSurface?: AuthSurface;
}

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Service-role Supabase client (bypasses row-level security). Used to verify
 * user access tokens and to read/write the usage table. Null when Supabase is
 * not configured, in which case protected routes fail closed with a 503.
 */
export const supabaseAdmin: SupabaseClient | null =
  url && serviceKey
    ? createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

export const isSupabaseConfigured = !!supabaseAdmin;

/**
 * Express middleware requiring a credential in the `Authorization: Bearer …`
 * header. Two kinds are accepted and both resolve to the same `req.user`:
 *
 *   - a Supabase access token (the web app, via a browser session)
 *   - a `pbx_live_…` API key (headless clients: MCP, scripts, CI)
 *
 * On success attaches `req.user`, plus `req.apiKeyId`/`req.authSurface` so the
 * telemetry layer can tell the two apart.
 *
 * @param opts.jwtOnly Reject API keys outright. Used by the key-management
 *   routes: a key must never be able to mint or revoke other keys, or stealing
 *   one would grant permanent, self-renewing access.
 */
export function requireUser(opts: { jwtOnly?: boolean } = {}) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!supabaseAdmin) {
      res.status(503).json({
        error: 'Auth is not configured on the server (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
        code: 'AUTH_UNAVAILABLE',
      });
      return;
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Sign in required.', code: 'UNAUTHENTICATED' });
      return;
    }

    // --- API key path -----------------------------------------------------
    if (looksLikeApiKey(token)) {
      if (opts.jwtOnly) {
        res.status(403).json({
          error: 'API keys cannot manage API keys. Sign in from the web app to do that.',
          code: 'JWT_REQUIRED',
        });
        return;
      }
      try {
        const resolved = await resolveApiKey(supabaseAdmin, token);
        if (!resolved) {
          res.status(401).json({ error: 'Invalid or revoked API key.', code: 'UNAUTHENTICATED' });
          return;
        }
        req.user = { id: resolved.userId };
        req.apiKeyId = resolved.apiKeyId;
        // The client tells us what it is; it is untrusted, so it only ever
        // labels analytics rows and never grants anything.
        req.authSurface = (req.headers['x-pitchbox-client'] ? 'mcp' : 'api') as AuthSurface;
        next();
      } catch {
        res.status(401).json({ error: 'Could not verify your API key.', code: 'UNAUTHENTICATED' });
      }
      return;
    }

    // --- Supabase JWT path ------------------------------------------------
    try {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !data.user) {
        res.status(401).json({ error: 'Invalid or expired session. Sign in again.', code: 'UNAUTHENTICATED' });
        return;
      }
      req.user = { id: data.user.id, email: data.user.email ?? undefined };
      req.authSurface = 'web';
      next();
    } catch {
      res.status(401).json({ error: 'Could not verify your session.', code: 'UNAUTHENTICATED' });
    }
  };
}
