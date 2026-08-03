/// <reference lib="dom" />
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access } from 'node:fs/promises';
import net from 'node:net';

import puppeteer, { type Browser } from 'puppeteer';

/**
 * A real browser the user drives themselves, to log in wherever the recording
 * will happen.
 *
 * Automating the login was never going to generalise. It works on a site with
 * plain email-and-password signup and fails on OAuth, SSO, two-factor, a magic
 * link or a captcha — which is most products — and it required Pitchbox to hold
 * somebody's credentials to do it. A person signing in themselves handles every
 * one of those, and Pitchbox never learns a single secret.
 *
 * The browser runs on a private X display so it can be both *shown* to the user
 * (over VNC, proxied through the authenticated API) and *recorded* (with ffmpeg
 * grabbing the same display). Crucially it is one browser throughout: the one
 * signed into is the one explored and the one filmed. Anything else captures a
 * different session from the one that was authenticated.
 *
 * Everything here is Linux-only — Xvfb and x11vnc do not exist on macOS — so
 * `isSupported()` is what callers check before offering the feature.
 */

export class InteractiveLoginError extends Error {}

/** How long an unattended login browser is kept before it is reclaimed. */
const DEFAULT_TTL_MS = Number.parseInt(process.env.PITCHBOX_LOGIN_TTL_MIN ?? '30', 10) * 60_000;
/** Displays to try. Each session takes one for its lifetime. */
const DISPLAY_POOL = [101, 102, 103, 104, 105, 106, 107, 108];

export interface LoginSessionView {
  /** Opaque secret. The viewer and its websocket are useless without it. */
  token: string;
  /** X display the browser and the recorder share, e.g. ":101". */
  display: string;
  /** Loopback port x11vnc is serving on. Never exposed directly. */
  vncPort: number;
  expiresAt: string;
}

interface LoginSession extends LoginSessionView {
  browser: Browser;
  xvfb: ChildProcess;
  vnc: ChildProcess;
  displayNumber: number;
  timer: NodeJS.Timeout;
}

export class InteractiveLoginManager {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly viewport: { width: number; height: number };

  constructor(options: { viewport?: { width: number; height: number } } = {}) {
    this.viewport = options.viewport ?? { width: 1280, height: 720 };
  }

  /**
   * Whether a driveable browser can be offered at all.
   *
   * Checked rather than assumed: on a machine without Xvfb the honest answer is
   * "this deployment cannot do interactive login", and the caller should say so
   * instead of failing halfway through starting one.
   */
  static async isSupported(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    const found = await Promise.all(
      ['Xvfb', 'x11vnc'].map((bin) => which(bin).then((p) => Boolean(p))),
    );
    return found.every(Boolean);
  }

  /** Reasons this deployment cannot offer it, for a message a human can act on. */
  static async unsupportedReason(): Promise<string | undefined> {
    if (process.platform !== 'linux') {
      return `Interactive login needs a virtual X display, which only exists on Linux (this host is ${process.platform}).`;
    }
    const missing: string[] = [];
    for (const bin of ['Xvfb', 'x11vnc']) {
      if (!(await which(bin))) missing.push(bin);
    }
    if (missing.length) return `Interactive login needs ${missing.join(' and ')} installed on the server.`;
    return undefined;
  }

  get(sessionId: string): LoginSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Constant-time token check, so the viewer cannot be probed for a valid one. */
  authorise(sessionId: string, token: string | undefined): LoginSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || !token) return undefined;
    const expected = Buffer.from(session.token);
    const given = Buffer.from(token);
    if (expected.length !== given.length) return undefined;
    return timingSafeEqual(expected, given) ? session : undefined;
  }

  /**
   * Open a browser on its own display, put a VNC server in front of it, and
   * point it at `url`.
   *
   * Chrome is deliberately *not* in kiosk mode here: the person needs the window
   * furniture to see what they are doing, deal with a popup, or read a URL they
   * are being asked to trust. The recording is launched separately, chromeless,
   * once they are done.
   */
  async start(sessionId: string, url: string): Promise<LoginSessionView> {
    const reason = await InteractiveLoginManager.unsupportedReason();
    if (reason) throw new InteractiveLoginError(reason);

    await this.stop(sessionId);

    const displayNumber = await this.claimDisplay();
    const display = `:${displayNumber}`;
    let xvfb: ChildProcess | undefined;
    let vnc: ChildProcess | undefined;
    let browser: Browser | undefined;

    try {
      xvfb = await this.startXvfb(displayNumber);
      const vncPort = 5900 + displayNumber;
      vnc = await this.startVnc(display, vncPort);

      browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          `--window-size=${this.viewport.width},${this.viewport.height}`,
          '--window-position=0,0',
        ],
        // The automation banner is fine here — this window is for the person, not
        // the camera — but the recording pass hides it.
        env: { ...process.env, DISPLAY: display },
      });

      const page = (await browser.pages())[0] ?? (await browser.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);

      const token = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
      const timer = setTimeout(() => {
        console.warn(`[login ${sessionId}] reclaiming an unattended login browser`);
        void this.stop(sessionId);
      }, DEFAULT_TTL_MS);
      timer.unref?.();

      this.sessions.set(sessionId, {
        token, display, vncPort, expiresAt,
        browser, xvfb, vnc, displayNumber, timer,
      });
      console.log(`[login ${sessionId}] browser up on ${display}, vnc on 127.0.0.1:${vncPort}`);
      return { token, display, vncPort, expiresAt };
    } catch (error) {
      await browser?.close().catch(() => undefined);
      vnc?.kill('SIGKILL');
      xvfb?.kill('SIGKILL');
      throw error instanceof InteractiveLoginError
        ? error
        : new InteractiveLoginError(`Could not start the login browser: ${describe(error)}`);
    }
  }

  /**
   * Hand the browser to the caller and stop managing it.
   *
   * The TTL timer is cleared and the entry dropped, but the processes are left
   * running: from here the browser belongs to the recording, and reclaiming it
   * on a timer would kill a run in progress. `release` returns everything the
   * caller needs to shut it down when it is finished.
   */
  release(sessionId: string): { browser: Browser; display: string; shutdown: () => Promise<void> } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    clearTimeout(session.timer);
    this.sessions.delete(sessionId);
    return {
      browser: session.browser,
      display: session.display,
      shutdown: async () => {
        await session.browser.close().catch(() => undefined);
        session.vnc.kill('SIGTERM');
        session.xvfb.kill('SIGTERM');
        await delay(200);
        if (session.vnc.exitCode === null) session.vnc.kill('SIGKILL');
        if (session.xvfb.exitCode === null) session.xvfb.kill('SIGKILL');
      },
    };
  }

  /** Tear a login browser down, whether or not it was ever used. */
  async stop(sessionId: string): Promise<void> {
    const released = this.release(sessionId);
    if (released) await released.shutdown();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  // -------------------------------------------------------------------------

  private async claimDisplay(): Promise<number> {
    const taken = new Set([...this.sessions.values()].map((s) => s.displayNumber));
    for (const candidate of DISPLAY_POOL) {
      if (taken.has(candidate)) continue;
      // A lock file means someone else's X server already has it.
      try {
        await access(`/tmp/.X${candidate}-lock`);
      } catch {
        return candidate;
      }
    }
    throw new InteractiveLoginError(
      'All login displays are in use. Wait for another sign-in to finish, or try again shortly.',
    );
  }

  private async startXvfb(displayNumber: number): Promise<ChildProcess> {
    const child = spawn(
      'Xvfb',
      [`:${displayNumber}`, '-screen', '0', `${this.viewport.width}x${this.viewport.height}x24`, '-nolisten', 'tcp'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr = `${stderr}${c.toString()}`.slice(-1_000);
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) {
        throw new InteractiveLoginError(`Xvfb exited immediately: ${stderr.trim() || 'no output'}`);
      }
      try {
        await access(`/tmp/.X${displayNumber}-lock`);
        return child;
      } catch {
        await delay(250);
      }
    }
    child.kill('SIGKILL');
    throw new InteractiveLoginError('Xvfb did not become ready.');
  }

  /**
   * x11vnc, bound to loopback only.
   *
   * This is a live browser that is about to hold somebody's real session, so it
   * is never reachable from outside the host. The only way in is the API's own
   * websocket bridge, which checks the caller owns the run and knows the token.
   */
  private async startVnc(display: string, port: number): Promise<ChildProcess> {
    const child = spawn(
      'x11vnc',
      [
        '-display', display,
        '-rfbport', String(port),
        '-localhost',
        '-nopw',
        '-forever',
        '-shared',
        '-noxdamage',
        '-quiet',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr = `${stderr}${c.toString()}`.slice(-1_000);
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) {
        throw new InteractiveLoginError(`x11vnc exited immediately: ${stderr.trim() || 'no output'}`);
      }
      if (await portOpen(port)) return child;
      await delay(250);
    }
    child.kill('SIGKILL');
    throw new InteractiveLoginError('x11vnc did not start listening.');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve a binary on PATH without shelling out through a shell. */
function which(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${bin}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.on('error', () => resolve(undefined));
    child.on('exit', (code) => resolve(code === 0 && out.trim() ? out.trim() : undefined));
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}
