/**
 * Secrets the walkthrough types into the product on camera.
 *
 * Distinct from `appEnv`, which configures the app so it will *boot*. These are
 * values a demo has to enter through the UI to get anywhere — an API key pasted
 * into a settings field, a licence code, a token. Pitchbox's own demo needs one:
 * the pipeline page does nothing without an LLM key.
 *
 * Three properties have to hold, and each is enforced in a different place
 * because each has a different way of failing:
 *
 * 1. **The LLM never sees a value.** The planner and director are told the
 *    *names* only, and emit `{{secret:NAME}}` where a value belongs. A plan is
 *    therefore safe to log, show, store and hand back to a model. Substitution
 *    happens in the recorder, at the keystroke, and nowhere earlier.
 *
 * 2. **The camera never sees a value.** The field is masked before typing
 *    starts and stays masked — see `Recorder.maskField`. Restoring it after
 *    typing would put the value on screen, which is precisely the thing being
 *    avoided.
 *
 * 3. **Nothing echoes a value back.** Values live in a Map beside the session,
 *    never on it, so no API response can serialise them. `redactSecrets` is the
 *    backstop for the paths that are hard to reason about — an exception
 *    message, a stack trace, a stage note — where a value might otherwise ride
 *    along into a log.
 *
 * What this cannot promise: if the product itself displays the value after
 * accepting it, that is on screen and Pitchbox has no say. Masking covers the
 * field being typed into, not the app's own rendering of what it received.
 */

export interface SecretLimits {
  maxSecrets: number;
  maxNameLength: number;
  maxValueLength: number;
  maxTotalBytes: number;
}

export const DEFAULT_SECRET_LIMITS: SecretLimits = {
  maxSecrets: 20,
  maxNameLength: 64,
  // Generous: some tokens (JWTs, service-account blobs) are genuinely long.
  maxValueLength: 8_192,
  maxTotalBytes: 32_768,
};

/**
 * Below this length a value is too short to redact safely.
 *
 * Redacting a 2-character secret would rewrite half of every log line it happens
 * to appear inside, which destroys the diagnostics that make a failed run
 * debuggable. Short values are also unlikely to be real credentials.
 */
const MIN_REDACTABLE_LENGTH = 6;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `{{secret:NAME}}` — what a plan carries in place of a value. */
export const SECRET_TOKEN_RE = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

/**
 * Validate and normalise caller-supplied secrets.
 *
 * Accepts an object, or an array of `{name, value}` rows, because the UI collects
 * rows and an API client sends an object. Deliberately does *not* accept
 * `.env`-style text: `appEnv` does that, and a paste-a-file affordance here
 * encourages dumping a whole environment in when one field is what is wanted.
 */
export function parseSecrets(
  input: unknown,
  limits: SecretLimits = DEFAULT_SECRET_LIMITS,
): Record<string, string> {
  if (input === undefined || input === null || input === '') return {};

  const rows: Array<[string, string]> = Array.isArray(input) ? parseRows(input) : parseObject(input);

  const secrets: Record<string, string> = {};
  let totalBytes = 0;

  for (const [rawName, rawValue] of rows) {
    const name = rawName.trim();
    // A row with a name and no value yet is the normal state of a half-filled
    // form, not an error worth rejecting the whole save for.
    if (!name && !rawValue) continue;

    if (!NAME_PATTERN.test(name)) {
      throw new SecretError(
        `${JSON.stringify(name)} is not a valid secret name. Use letters, digits and underscores, ` +
          'starting with a letter or underscore.',
      );
    }
    if (name.length > limits.maxNameLength) {
      throw new SecretError(`The name ${JSON.stringify(name)} is longer than ${limits.maxNameLength} characters.`);
    }
    if (!rawValue) {
      throw new SecretError(`${name} has no value. Remove the row, or fill it in.`);
    }
    if (rawValue.length > limits.maxValueLength) {
      throw new SecretError(`The value of ${name} is longer than ${limits.maxValueLength} characters.`);
    }
    if (rawValue.includes('\0')) {
      throw new SecretError(`The value of ${name} contains a null byte.`);
    }
    if (Object.prototype.hasOwnProperty.call(secrets, name)) {
      throw new SecretError(`${name} is defined more than once.`);
    }

    secrets[name] = rawValue;
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(rawValue) + 2;

    if (Object.keys(secrets).length > limits.maxSecrets) {
      throw new SecretError(`Too many secrets — the limit is ${limits.maxSecrets}.`);
    }
    if (totalBytes > limits.maxTotalBytes) {
      throw new SecretError(`The secrets are too large — the limit is ${limits.maxTotalBytes} bytes in total.`);
    }
  }

  return secrets;
}

function parseObject(input: unknown): Array<[string, string]> {
  if (typeof input !== 'object') {
    throw new SecretError('`secrets` must be an object of NAME: value pairs, or a list of {name, value} rows.');
  }
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') {
      throw new SecretError(`The value of ${name} must be a string, number or boolean.`);
    }
    out.push([name, String(value)]);
  }
  return out;
}

function parseRows(input: unknown[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const row of input) {
    if (typeof row !== 'object' || row === null) {
      throw new SecretError('Each secret must be an object with `name` and `value`.');
    }
    const { name, value } = row as { name?: unknown; value?: unknown };
    if (value !== undefined && value !== null && typeof value === 'object') {
      throw new SecretError(`The value of ${String(name)} must be a string.`);
    }
    out.push([String(name ?? ''), value === undefined || value === null ? '' : String(value)]);
  }
  return out;
}

/** The names, which are all the LLM is ever told and all an API returns. */
export function secretNames(secrets: Record<string, string>): string[] {
  return Object.keys(secrets);
}

/** A safe one-line description for logs: how many, and what they are called. */
export function describeSecrets(secrets: Record<string, string>): string {
  const names = secretNames(secrets);
  return names.length ? `${names.length} (${names.join(', ')})` : 'none';
}

export interface SecretResolution {
  text: string;
  /** Names that were substituted — safe to log, and how the recorder knows to mask. */
  usedNames: string[];
  /** Referenced but not supplied. The caller decides whether that is fatal. */
  missingNames: string[];
}

/**
 * Replace `{{secret:NAME}}` with the value.
 *
 * A token with no matching secret is left standing rather than replaced with an
 * empty string: typing nothing into a required field produces a confusing
 * half-broken demo, whereas the literal token on screen — and the name in
 * `missingNames` — says exactly what was not supplied.
 */
export function resolveSecretTokens(
  text: string,
  secrets: Record<string, string>,
): SecretResolution {
  const usedNames = new Set<string>();
  const missingNames = new Set<string>();

  const out = text.replace(SECRET_TOKEN_RE, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(secrets, name)) {
      usedNames.add(name);
      return secrets[name];
    }
    missingNames.add(name);
    return whole;
  });

  return { text: out, usedNames: [...usedNames], missingNames: [...missingNames] };
}

/** True when the text references any secret at all. */
export function referencesSecret(text: string | undefined): boolean {
  if (!text) return false;
  // `.test` on a /g regex advances lastIndex; a fresh regex avoids the stale-state
  // bug where every other call returns false.
  return new RegExp(SECRET_TOKEN_RE.source).test(text);
}

/**
 * Remove any secret value from text on its way to a log, an error or an API.
 *
 * The last line of defence, for the paths too diffuse to audit individually: a
 * provider's error message quoting the key it rejected, an exception carrying a
 * request body, a stage note built by string interpolation. Longest values first,
 * so a secret that contains another is not left half-exposed.
 */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  const values = Object.entries(secrets)
    .filter(([, value]) => value.length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [name, value] of values) {
    if (!out.includes(value)) continue;
    out = out.split(value).join(`«${name} redacted»`);
  }
  return out;
}
