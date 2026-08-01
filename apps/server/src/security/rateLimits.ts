import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';
import type { AuthedRequest } from '../auth/supabaseAuth';

/**
 * Rate limits.
 *
 * The instance is small and publicly linked, so the goal is less "stop a
 * determined attacker" and more "stop one script, or one enthusiastic demo,
 * from exhausting the box or the operator's Daytona credits".
 *
 * Limits are per authenticated user where a user exists, and per IP otherwise.
 * Keying authenticated traffic by user rather than IP matters because signup is
 * open: an IP-only limit is trivially sidestepped, and a user-only limit cannot
 * be applied to anonymous endpoints.
 *
 * NOTE: the store is in-memory, so counters reset on restart and are per
 * process. That is proportionate for a single-instance deployment; a second
 * instance would need a shared store to mean anything.
 */

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Per-user when signed in, per-IP otherwise. ipKeyGenerator normalises IPv6. */
function userOrIpKey(req: Request): string {
  const userId = (req as AuthedRequest).user?.id;
  if (userId) return `u:${userId}`;
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

function tooMany(message: string) {
  return (_req: Request, res: Response) => {
    res.status(429).json({ error: message, code: 'RATE_LIMITED' });
  };
}

/**
 * Blanket ceiling on every request. Deliberately generous — the UI polls
 * session status every 1.5s, so a legitimate user watching one run makes
 * roughly 40 requests a minute and must not trip this.
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: num('RATE_LIMIT_GLOBAL_PER_15MIN', 1000),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: tooMany('Too many requests. Slow down and try again shortly.'),
});

/**
 * Starting a pipeline is the expensive path: it spawns LLM calls and holds a
 * session in memory until it expires. Far tighter than the global ceiling.
 */
export const startPipelineLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: num('RATE_LIMIT_STARTS_PER_HOUR', 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: tooMany('You have started a lot of videos recently. Try again in a little while.'),
});

/**
 * `/api/validate-key` is unauthenticated and makes a live outbound call with a
 * caller-supplied key. Without a limit it is an anonymous oracle for testing
 * stolen API keys against six providers, using someone else's server. This is
 * the strictest limit in the file for that reason.
 */
export const validateKeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: num('RATE_LIMIT_VALIDATE_PER_HOUR', 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
  handler: tooMany('Too many key validation attempts. Try again later.'),
});

/** Minting API keys should be rare; a burst means something is wrong. */
export const keyMintLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: num('RATE_LIMIT_KEY_MINT_PER_HOUR', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: tooMany('Too many API keys created recently. Try again later.'),
});

/** Anything that spends the operator's Daytona credits. */
export const sandboxLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: num('RATE_LIMIT_SANDBOX_PER_HOUR', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  handler: tooMany('Too many recording/deploy requests. Try again in a little while.'),
});
