import { createHash } from 'node:crypto';
import type { FormField } from './types';

/**
 * The throwaway persona a walkthrough uses to actually operate the app.
 *
 * Everything here is deliberately, visibly fake. `example.com` is reserved by
 * RFC 2606 and `555-01xx` by NANP for fiction, so nothing typed on camera can
 * reach a real inbox or phone — which matters because these values end up in a
 * video the user is about to publish.
 *
 * Values are derived from the session id rather than randomised: the same run
 * always produces the same persona, so a retried recording signs in as the
 * account the first attempt created instead of orphaning a new one.
 */
export interface DummyIdentity {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  fullName: string;
  username: string;
  company: string;
  jobTitle: string;
  phone: string;
  url: string;
  /** A short free-text answer, for single-line fields with no obvious type. */
  shortText: string;
  /** A paragraph, for textareas. */
  longText: string;
}

const FIRST_NAMES = ['Alex', 'Riley', 'Jordan', 'Sam', 'Casey', 'Morgan', 'Avery', 'Quinn'];
const LAST_NAMES = ['Rivera', 'Chen', 'Okafor', 'Novak', 'Haddad', 'Lindqvist', 'Moreau', 'Bhatt'];
const COMPANIES = ['Northwind Labs', 'Kestrel Analytics', 'Lumen Works', 'Harbour Systems'];
const TITLES = ['Product Manager', 'Founding Engineer', 'Head of Growth', 'Design Lead'];

/** Deterministic per-session persona. Same seed in, same persona out. */
export function makeDummyIdentity(seed: string): DummyIdentity {
  const digest = createHash('sha256').update(seed).digest();
  const pick = <T>(list: T[], offset: number): T => list[digest[offset] % list.length];
  // Short, readable tag that ties the account back to the run without exposing
  // the whole session id inside the app being demoed.
  const tag = digest.toString('hex').slice(0, 6);

  const firstName = pick(FIRST_NAMES, 0);
  const lastName = pick(LAST_NAMES, 1);

  return {
    email: `demo.user+${tag}@example.com`,
    // Long and mixed-class so it survives the usual signup validators without
    // the walkthrough having to read the error message and retry.
    password: `Demo-Pass-${tag}!7`,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    username: `${firstName.toLowerCase()}${tag}`,
    company: pick(COMPANIES, 2),
    jobTitle: pick(TITLES, 3),
    // 555-01xx is the reserved fictional block.
    phone: `+1 555 01${String(digest[4] % 100).padStart(2, '0')}`,
    url: 'https://example.com',
    shortText: 'Recording a product demo',
    longText:
      'Trying this out to see how the flow feels end to end. Everything here is placeholder content from an automated demo run.',
  };
}

/** Identity tokens a plan may use instead of literal values. */
const TOKENS: Array<[RegExp, keyof DummyIdentity]> = [
  [/\{\{\s*email\s*\}\}/gi, 'email'],
  [/\{\{\s*password\s*\}\}/gi, 'password'],
  [/\{\{\s*first_?name\s*\}\}/gi, 'firstName'],
  [/\{\{\s*last_?name\s*\}\}/gi, 'lastName'],
  [/\{\{\s*(full_?)?name\s*\}\}/gi, 'fullName'],
  [/\{\{\s*username\s*\}\}/gi, 'username'],
  [/\{\{\s*company\s*\}\}/gi, 'company'],
  [/\{\{\s*job_?title\s*\}\}/gi, 'jobTitle'],
  [/\{\{\s*phone\s*\}\}/gi, 'phone'],
  [/\{\{\s*url\s*\}\}/gi, 'url'],
];

/** Replace `{{email}}`-style tokens in a planned value with the real persona. */
export function resolveTokens(value: string, identity: DummyIdentity): string {
  let out = value;
  for (const [pattern, key] of TOKENS) out = out.replace(pattern, identity[key]);
  return out;
}

/**
 * Choose what to type into a field.
 *
 * The control's own type wins where it is meaningful (`type="email"` is not
 * ambiguous); otherwise the label, name and placeholder are matched, because
 * that is the only signal a plain `type="text"` box gives.
 */
export function valueForField(field: FormField, identity: DummyIdentity): string {
  const hint = `${field.label} ${field.name}`.toLowerCase();

  switch (field.kind) {
    case 'email':
      return identity.email;
    case 'password':
      return identity.password;
    case 'tel':
      return identity.phone;
    case 'url':
      return identity.url;
    case 'number':
      return '3';
    case 'date':
      return '2026-01-15';
    case 'textarea':
      return identity.longText;
    case 'search':
      return identity.shortText;
    default:
      break;
  }

  // Password managers and validators key off the name, so check it before the
  // generic text fallbacks — a `type="text"` field named `password` is real.
  if (/pass(word|phrase)|pwd/.test(hint)) return identity.password;
  if (/e-?mail/.test(hint)) return identity.email;
  if (/phone|mobile|tel\b/.test(hint)) return identity.phone;
  if (/first.?name|given.?name|forename/.test(hint)) return identity.firstName;
  if (/last.?name|surname|family.?name/.test(hint)) return identity.lastName;
  if (/user.?name|handle|nickname/.test(hint)) return identity.username;
  if (/full.?name|your.?name|^name$|\bname\b/.test(hint)) return identity.fullName;
  if (/company|organi[sz]ation|team|workspace|business/.test(hint)) return identity.company;
  if (/job|role|title|position/.test(hint)) return identity.jobTitle;
  if (/website|url|link|domain/.test(hint)) return identity.url;
  if (/message|description|bio|about|notes?|comment|feedback/.test(hint)) return identity.longText;

  return identity.shortText;
}
