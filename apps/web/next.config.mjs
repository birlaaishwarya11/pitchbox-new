/**
 * The pipeline server runs on EC2 behind Caddy, reachable only as
 * https://<ip>.sslip.io because no domain is registered. Rather than expose a
 * raw IP in API calls, media URLs, and every MCP config, Vercel proxies those
 * paths to it — so the whole product lives on one hostname.
 *
 * Two things this buys beyond appearances: requests become same-origin, so the
 * browser never needs CORS; and the backend address becomes a deploy-time
 * detail that can change without touching published instructions.
 *
 * Caveat: Vercel caps proxied requests at 120s. The pipeline is unaffected
 * because it is asynchronous — start returns a session id immediately and the
 * client polls. `/api/record` and `/api/deploy` are synchronous and can exceed
 * that on a slow sandbox; they are used by the /test page, not the main flow.
 */
const SERVER_ORIGIN = process.env.PITCHBOX_SERVER_ORIGIN ?? 'https://3.90.117.18.sslip.io';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${SERVER_ORIGIN}/api/:path*` },
      // Generated media is served statically by the same server.
      { source: '/sessions/:path*', destination: `${SERVER_ORIGIN}/sessions/:path*` },
      { source: '/test-audio/:path*', destination: `${SERVER_ORIGIN}/test-audio/:path*` },
    ];
  },
};

export default nextConfig;
