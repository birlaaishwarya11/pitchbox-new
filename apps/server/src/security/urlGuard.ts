import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * Guards outbound navigation against SSRF.
 *
 * The recording pipeline points a real browser at a user-supplied URL and hands
 * the resulting frames back as a video. That makes any reachable internal
 * service directly *viewable* by the requester — a screenshot of an admin panel
 * or a cloud metadata endpoint is exfiltration, not just a blind request.
 *
 * So the rule is an allowlist of schemes plus a denylist of destinations, and
 * the destination check runs against the RESOLVED address, not the hostname:
 * `evil.example` can trivially resolve to 127.0.0.1.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/** Only these ever reach a browser. Blocks file:, data:, gopher:, ftp:, … */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * IPv4 ranges that must never be reachable. Chiefly RFC1918 private space, the
 * loopback range, and 169.254.0.0/16 — which carries the cloud metadata
 * endpoint (169.254.169.254) on AWS, GCP and Azure alike.
 */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — cloud metadata lives here
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function isBlockedV4(ip: string): boolean {
  const addr = v4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (v4ToInt(base) & mask);
  });
}

function isBlockedV6(ip: string): boolean {
  const a = ip.toLowerCase().split('%')[0]; // strip zone index
  if (a === '::' || a === '::1') return true; // unspecified / loopback
  if (a.startsWith('fe80')) return true; // link-local
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // unique local
  if (a.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:127.0.0.1) — judge by the embedded v4 address.
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedV4(ip);
  if (version === 6) return isBlockedV6(ip);
  return true; // not a recognisable IP — refuse rather than guess
}

/**
 * Validate a user-supplied URL for browser navigation.
 *
 * Returns the normalised URL when safe; throws {@link BlockedUrlError} with a
 * message intended for the end user otherwise.
 *
 * NOTE: this resolves DNS and checks the answer, which does not fully close
 * DNS rebinding — a name can return a public address here and a private one
 * when the browser resolves it moments later. Closing that properly requires
 * pinning the resolved IP for the connection, which Puppeteer does not expose.
 * The residual risk is accepted: it raises the bar from trivial to awkward, and
 * the deployment holds no IAM role for a rebinding attack to reach.
 */
export async function assertSafeUrl(raw: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw.match(/^[a-z][a-z0-9+.-]*:\/\//i) ? raw : `https://${raw}`);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${raw}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new BlockedUrlError(`Only http and https URLs can be recorded (got ${parsed.protocol}).`);
  }

  // Credentials in the URL are a redirect/confusion vector and are never needed.
  if (parsed.username || parsed.password) {
    throw new BlockedUrlError('URLs with embedded credentials are not allowed.');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // unwrap [::1]

  // A literal IP needs no DNS round-trip.
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new BlockedUrlError('That address is on a private or reserved network and cannot be recorded.');
    }
    return parsed.toString();
  }

  // `localhost` and friends may not resolve through DNS in every environment.
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new BlockedUrlError('Local hostnames cannot be recorded.');
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}.`);
  }
  if (!addresses.length) throw new BlockedUrlError(`Could not resolve ${host}.`);

  // Every answer must be safe: one private record is enough to abuse.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedUrlError('That host resolves to a private or reserved address and cannot be recorded.');
    }
  }

  return parsed.toString();
}
