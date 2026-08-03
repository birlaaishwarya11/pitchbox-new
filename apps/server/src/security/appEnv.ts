/**
 * Environment variables for the app being demoed.
 *
 * Most real projects will not boot without them — a missing `DATABASE_URL` or
 * publishable key means `npm run dev` exits, the port never opens, and the
 * recording falls back to a slate. So a run can supply them, and they are
 * injected into the sandbox that builds and runs the repo.
 *
 * They are treated as secrets throughout. Values are never logged, never
 * recorded on the session, never sent to an LLM, and never returned by an API
 * response — only the *names* ever appear anywhere, which is enough to diagnose
 * a boot failure without printing someone's database password into a log.
 *
 * The limits exist because this is an arbitrary blob travelling from an HTTP
 * body into a shell environment. Bounding count and size keeps a malformed or
 * hostile payload from becoming a giant command line or a wedged sandbox.
 */

export interface AppEnvLimits {
  maxVars: number;
  maxKeyLength: number;
  maxValueLength: number;
  maxTotalBytes: number;
}

export const DEFAULT_APP_ENV_LIMITS: AppEnvLimits = {
  // Comfortably more than a real dev `.env` needs, far less than a dump of a
  // whole production environment.
  maxVars: 40,
  maxKeyLength: 128,
  maxValueLength: 4_096,
  maxTotalBytes: 16_384,
};

/**
 * Names the pipeline sets itself, or that would compromise the sandbox.
 *
 * `PORT`/`HOST` are the contract the recorder relies on to find the app, and
 * the `RECORDER_`/`PUPPETEER_`/`DAYTONA_` prefixes drive the capture machinery —
 * letting a request set any of them turns a demo into a way to reconfigure the
 * recorder. `PATH` and the loader variables are the classic way to get arbitrary
 * code run by a later command.
 */
const RESERVED_EXACT = new Set([
  'PORT',
  'HOST',
  'HOSTNAME',
  'VITE_PORT',
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'IFS',
  'SHELL',
]);
const RESERVED_PREFIXES = ['RECORDER_', 'PUPPETEER_', 'DAYTONA_', 'PBX_'];

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class AppEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppEnvError';
  }
}

/**
 * Validate and normalise caller-supplied environment variables.
 *
 * Accepts either an object or a `.env`-style string, because the two natural
 * sources differ: an API client sends JSON, and a person pasting from their own
 * `.env` file wants to paste the file.
 *
 * Throws {@link AppEnvError} with a message meant to be shown to the caller.
 * Returns an empty record for empty input, so callers can pass through freely.
 */
export function parseAppEnv(
  input: unknown,
  limits: AppEnvLimits = DEFAULT_APP_ENV_LIMITS,
): Record<string, string> {
  if (input === undefined || input === null || input === '') return {};

  const pairs: Array<[string, string]> =
    typeof input === 'string' ? parseDotenv(input) : parseObject(input);

  const env: Record<string, string> = {};
  let totalBytes = 0;

  for (const [rawKey, rawValue] of pairs) {
    const key = rawKey.trim();
    if (!key) continue;

    if (!KEY_PATTERN.test(key)) {
      throw new AppEnvError(
        `Environment variable name ${JSON.stringify(key)} is not valid. Use letters, digits and ` +
          'underscores, starting with a letter or underscore.',
      );
    }
    if (key.length > limits.maxKeyLength) {
      throw new AppEnvError(`Environment variable name ${JSON.stringify(key)} is longer than ${limits.maxKeyLength} characters.`);
    }
    if (isReserved(key)) {
      throw new AppEnvError(
        `${key} is set by Pitchbox and cannot be overridden. ` +
          'The port and host are chosen so the recorder can find your app; ' +
          'use `sandboxPort` to change the port.',
      );
    }
    if (rawValue.length > limits.maxValueLength) {
      throw new AppEnvError(`The value of ${key} is longer than ${limits.maxValueLength} characters.`);
    }
    // Newlines and NULs cannot survive a shell environment intact, and a
    // silently truncated secret is worse than a rejected one.
    if (/[\0]/.test(rawValue)) {
      throw new AppEnvError(`The value of ${key} contains a null byte.`);
    }

    if (Object.prototype.hasOwnProperty.call(env, key)) {
      throw new AppEnvError(`${key} is defined more than once.`);
    }

    env[key] = rawValue;
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(rawValue) + 2;

    if (Object.keys(env).length > limits.maxVars) {
      throw new AppEnvError(`Too many environment variables — the limit is ${limits.maxVars}.`);
    }
    if (totalBytes > limits.maxTotalBytes) {
      throw new AppEnvError(`Environment variables are too large — the limit is ${limits.maxTotalBytes} bytes in total.`);
    }
  }

  return env;
}

function isReserved(key: string): boolean {
  const upper = key.toUpperCase();
  if (RESERVED_EXACT.has(upper)) return true;
  return RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function parseObject(input: unknown): Array<[string, string]> {
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AppEnvError('`appEnv` must be an object of NAME: value pairs, or a .env-style string.');
  }
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') {
      throw new AppEnvError(`The value of ${key} must be a string, number or boolean.`);
    }
    out.push([key, String(value)]);
  }
  return out;
}

/** Parse `.env` text: comments, blank lines, `export ` prefixes, quoted values. */
function parseDotenv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) {
      throw new AppEnvError(`Could not read the line ${JSON.stringify(truncate(line))} — expected NAME=value.`);
    }

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();

    // Strip matching quotes, and only then drop a trailing comment: a `#` inside
    // a quoted value is part of the secret, not a comment.
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2];
      // Double quotes carry escapes, single quotes are literal — the same split
      // every `.env` loader makes. Without this, a password written as
      // "a\"b" arrives with the backslash still in it, which does not read as a
      // corrupted secret so much as a wrong one.
      if (quoted[1] === '"') {
        value = value.replace(/\\([nrt"\\$])/g, (_, ch: string) =>
          ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch,
        );
      }
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out.push([key, value]);
  }

  return out;
}

function truncate(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/**
 * A safe description of what was supplied: names only, never values.
 *
 * This is what goes in logs and in the error a user sees when their app does
 * not boot — "you gave me these three names" is the single most useful fact for
 * diagnosing a missing-variable failure, and it leaks nothing.
 */
export function describeAppEnv(env: Record<string, string>): string {
  const names = Object.keys(env);
  if (!names.length) return 'none';
  return `${names.length} (${names.join(', ')})`;
}
