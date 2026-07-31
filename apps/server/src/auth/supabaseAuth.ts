import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Request, Response, NextFunction } from 'express';

export interface AuthedRequest extends Request {
  user?: { id: string; email?: string };
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
 * Express middleware requiring a valid Supabase access token in the
 * `Authorization: Bearer <jwt>` header. On success attaches `req.user`.
 */
export function requireUser() {
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
    try {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !data.user) {
        res.status(401).json({ error: 'Invalid or expired session. Sign in again.', code: 'UNAUTHENTICATED' });
        return;
      }
      req.user = { id: data.user.id, email: data.user.email ?? undefined };
      next();
    } catch {
      res.status(401).json({ error: 'Could not verify your session.', code: 'UNAUTHENTICATED' });
    }
  };
}
