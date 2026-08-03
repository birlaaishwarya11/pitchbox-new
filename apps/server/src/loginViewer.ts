import net from 'node:net';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import type { InteractiveLoginManager } from './InteractiveLogin';

/**
 * Serves the browser-in-a-browser view of a login session, and bridges its
 * websocket to x11vnc.
 *
 * x11vnc listens on loopback only and there is no VNC password, because a
 * password on the wire would be the weaker control: what actually guards this is
 * the API. The viewer page and the socket both require the run's own token, which
 * is issued once to the authenticated owner. Nothing about the browser is
 * reachable without it.
 *
 * The bridge is hand-rolled because `websockify` is a Python tool and not
 * available here. It is only a byte pump: RFB frames in binary websocket
 * messages, in both directions, which is exactly what noVNC expects.
 */

export interface LoginViewerDeps {
  manager: InteractiveLoginManager;
  /** Confirms the caller owns this run. Called with the raw session id. */
  ownsSession: (sessionId: string, req: IncomingMessage) => boolean | Promise<boolean>;
}

/** Where the viewer lives, relative to the API root. */
export const LOGIN_VIEWER_PATH = '/api/pipeline/:id/login/viewer';
export const LOGIN_SOCKET_PATH_RE = /^\/api\/pipeline\/([^/]+)\/login\/socket$/;

/**
 * Attach the websocket bridge to an existing HTTP server.
 *
 * Done on the raw server rather than through Express because a websocket
 * upgrade never reaches Express middleware, so the token has to be checked here.
 */
export function attachLoginSocket(server: HttpServer, deps: LoginViewerDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }

    const match = LOGIN_SOCKET_PATH_RE.exec(url.pathname);
    if (!match) return; // not ours; leave it for anything else listening

    const sessionId = decodeURIComponent(match[1]);
    const login = deps.manager.authorise(sessionId, url.searchParams.get('token') ?? undefined);
    if (!login) {
      // Deliberately terse: a live browser is behind this, so an attacker learns
      // nothing about whether the run exists.
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      bridgeToVnc(ws, login.vncPort, sessionId);
    });
  });

  return wss;
}

/** Pump bytes between a websocket and the local VNC port until either closes. */
function bridgeToVnc(ws: WebSocket, vncPort: number, sessionId: string): void {
  const tcp = net.connect({ host: '127.0.0.1', port: vncPort });

  // Binary both ways: RFB is a byte protocol and any text coercion corrupts it.
  ws.binaryType = 'nodebuffer';

  const shutdown = () => {
    tcp.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  };

  tcp.on('connect', () => {
    console.log(`[login ${sessionId}] viewer attached`);
  });
  tcp.on('data', (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  });
  tcp.on('error', (err) => {
    console.warn(`[login ${sessionId}] vnc socket error:`, err.message);
    shutdown();
  });
  tcp.on('close', shutdown);

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
    tcp.write(buf);
  });
  ws.on('close', () => {
    console.log(`[login ${sessionId}] viewer detached`);
    shutdown();
  });
  ws.on('error', shutdown);
}

/**
 * The viewer page.
 *
 * noVNC is loaded as an ES module straight from the installed package, so there
 * is no bundler step for one page. `scaleViewport` keeps the whole desktop
 * visible on any window size, because a person cannot log in through a viewport
 * they have to scroll.
 */
export function loginViewerHtml(sessionId: string, token: string): string {
  const socketPath = `/api/pipeline/${encodeURIComponent(sessionId)}/login/socket?token=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to record</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0f; color: #e4e4e7;
               font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; }
  #bar { display: flex; align-items: center; gap: 12px; padding: 8px 12px;
         border-bottom: 1px solid #27272a; }
  #status { color: #a1a1aa; }
  #screen { position: absolute; inset: 38px 0 0 0; }
  .warn { color: #fbbf24; }
  .err { color: #f87171; }
</style>
</head>
<body>
  <div id="bar">
    <strong>Sign in as you normally would</strong>
    <span id="status">connecting…</span>
  </div>
  <div id="screen"></div>
<script type="module">
  import RFB from '/api/novnc/core/rfb.js';

  const status = document.getElementById('status');
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + ${JSON.stringify(socketPath)};

  let rfb;
  try {
    rfb = new RFB(document.getElementById('screen'), url, { shared: true });
  } catch (err) {
    status.textContent = 'could not start the viewer: ' + err.message;
    status.className = 'err';
  }

  if (rfb) {
    rfb.scaleViewport = true;      // fit the desktop to the window
    rfb.resizeSession = false;     // the display size is fixed by the recorder
    rfb.focusOnClick = true;
    rfb.addEventListener('connect', () => {
      status.textContent = 'connected — this is the browser that will be recorded';
      status.className = '';
    });
    rfb.addEventListener('disconnect', (e) => {
      status.textContent = e.detail && e.detail.clean
        ? 'viewer closed'
        : 'viewer disconnected — reopen this window to carry on';
      status.className = 'warn';
    });
  }
</script>
</body>
</html>`;
}
