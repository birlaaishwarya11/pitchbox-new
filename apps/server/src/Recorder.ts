/// <reference lib="dom" />
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  dismissOverlays,
  installCinematics,
  moveCamera,
  resetCamera,
  moveCursorTo,
  cursorPulse,
} from './cinematics/pageScript';
import type { Beat } from './cinematics/types';
import { resolveTokens, type DummyIdentity } from './cinematics/dummyIdentity';
import { mkdtemp, mkdir, rename, rm, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import puppeteer, {
  type Browser,
  type BrowserLaunchArgumentOptions,
  type LaunchOptions,
  type Page,
} from 'puppeteer';
import Xvfb from 'xvfb';

type ViewportSize = {
  width: number;
  height: number;
};

type ScrollBehavior = {
  stepPx: number;
  delayMs: number;
  maxScrollMs: number;
  preScrollWaitMs: number;
  tailWaitMs: number;
};

type FfmpegOptions = {
  frameRate: number;
  codec: string;
  preset: string;
  pixelFormat: string;
  loglevel: 'quiet' | 'error' | 'warning' | 'info' | 'debug' | 'trace';
};

type XvfbSettings = {
  enabled?: boolean;
  required?: boolean;
  depth?: number;
  extraArgs?: string[];
};

export type CaptureMode = 'auto' | 'xvfb' | 'screenshot';

export type RecorderOptions = {
  outputDir?: string;
  viewport?: ViewportSize;
  navigationTimeoutMs?: number;
  scroll?: Partial<ScrollBehavior>;
  ffmpeg?: Partial<FfmpegOptions>;
  xvfb?: XvfbSettings;
  storageProvider?: RecordingStorageProvider;
  captureMode?: CaptureMode;
};

export type StorageLocation = {
  type: 'local' | string;
  uri: string;
  metadata?: Record<string, string>;
};

type RecordingMetadata = {
  sessionId: string;
  url: string;
  filename: string;
  startedAt: Date;
  viewport: ViewportSize;
};

export type RecordingResult = {
  sessionId: string;
  url: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  viewport: ViewportSize;
  storage: StorageLocation;
  localPath: string;
};

export interface RecordingStorageProvider {
  save(tempPath: string, meta: RecordingMetadata): Promise<StorageLocation>;
}

type VirtualDisplaySession = {
  display: string;
  stop: () => Promise<void>;
};

const DEFAULT_VIEWPORT: ViewportSize = {
  width: 1280,
  height: 720,
};

// Scroll pacing. Smaller steps taken further apart read as a deliberate
// walkthrough rather than a page being yanked downwards — at 480px every 500ms
// the viewer never gets to actually see a section before it leaves the frame,
// which looks frantic under a calm voiceover.
const DEFAULT_SCROLL: ScrollBehavior = {
  stepPx: 220,
  delayMs: 1_100,
  maxScrollMs: 60_000,
  preScrollWaitMs: 2_500, // let the page settle and any hero animation play
  tailWaitMs: 2_500,
};

const DEFAULT_FFMPEG: FfmpegOptions = {
  frameRate: 30,
  codec: 'libx264',
  preset: 'veryfast',
  pixelFormat: 'yuv420p',
  loglevel: 'error',
};

const DEFAULT_RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');

/**
 * How long a camera move takes. Also its lead time: the move is started this
 * far before the beat is due, so it *settles* on the beat instead of beginning
 * on it — a push-in that is still travelling when the narrator names the thing
 * reads as a late reaction.
 */
const CAMERA_MOVE_MS = 1_100;
/** Matches the pointer's CSS transition, so a click waits for it to arrive. */
const CURSOR_GLIDE_MS = 520;
/** Per-character typing delay. Fast enough to not drag, slow enough to read. */
const TYPE_DELAY_MS = 55;
/** Breathing room after a click for the app to actually respond. */
const POST_CLICK_MS = 700;
/**
 * How long the capture may go without a single good frame before it gives up.
 *
 * Measured in time rather than attempts: a navigation mid-walkthrough makes
 * frames fail for as long as the document swap takes, and counting attempts
 * turned a slow page into a truncated recording.
 */
const FRAME_FAILURE_WINDOW_MS = 25_000;
/**
 * Ceiling on a single frame. `page.screenshot()` takes no timeout of its own in
 * this Puppeteer version, and it can block indefinitely while the renderer
 * swaps documents — which is precisely when the walkthrough is navigating.
 */
const SCREENSHOT_TIMEOUT_MS = 15_000;
/** How long an input event will wait for an in-flight screenshot to finish. */
const INPUT_SETTLE_MS = 400;
/**
 * Deadline for the very first frame, which doubles as a probe.
 *
 * Short on purpose: if compositor capture is going to hang, this is how quickly
 * we find out and switch strategy, rather than burning the full deadline.
 */
const FIRST_FRAME_TIMEOUT_MS = 5_000;

/** See `instrumentPage` for why this exists and why it is a string. */
const SHIM_SOURCE = 'globalThis.__name = globalThis.__name || ((fn) => fn)';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An ffmpeg child whose stderr tail has been retained for diagnosis. */
type FfmpegProcess = ChildProcessWithoutNullStreams & { pbxStderr?: string };

/** Turn an ffmpeg exit code into something a human can act on. */
function describeFfmpegFailure(proc: ChildProcessWithoutNullStreams, code: number | null): string {
  const stderr = (proc as FfmpegProcess).pbxStderr?.trim();
  const signal = proc.signalCode;
  const parts = [`ffmpeg exited with code ${code ?? signal ?? 'unknown'}.`];

  if (signal === 'SIGKILL' || code === 137) {
    parts.push('It was killed — on a small container this is almost always the out-of-memory killer.');
  }
  if (stderr) {
    parts.push(`ffmpeg said:\n${stderr.split(/\r?\n/).slice(-12).join('\n')}`);
  } else {
    parts.push('ffmpeg produced no diagnostic output.');
  }
  return parts.join('\n');
}

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * The abandoned promise keeps a rejection handler attached: dropping a screen-
 * shot that later fails would otherwise take the process down with an unhandled
 * rejection.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Keeps mouse input and screen capture off each other's toes.
 *
 * A `page.screenshot()` in flight while a mouse press/release pair is being
 * dispatched eats the click: the command resolves, the pointer visibly lands on
 * the button, and nothing happens. That silently froze the walkthrough on the
 * landing page — every navigation dropped, with no error to notice.
 *
 * The obvious fix, one mutex over both, is worse than the bug. A screenshot
 * taken during a document swap can block indefinitely, and a shared queue turns
 * that into a deadlock: the click waits behind the hung frame, the next frame
 * waits behind the click, and the recording holds one image until the watchdog
 * kills the browser. So input never queues. It signals intent — which stops new
 * frames being started — waits a bounded moment for anything already running,
 * and then goes regardless.
 *
 * Keyboard input stays outside entirely: typing holds the channel for a second
 * or more, and the whole point of typing on camera is watching it arrive.
 */
class CaptureGate {
  private inFlight: Promise<unknown> | null = null;
  private pendingInput = 0;

  /** True while input is being dispatched; the capture loop should stand off. */
  get inputActive(): boolean {
    return this.pendingInput > 0;
  }

  /** Capture side. Records the in-flight frame so input can wait on it. */
  async capture<T>(fn: () => Promise<T>): Promise<T> {
    const task = fn();
    this.inFlight = task;
    try {
      return await task;
    } finally {
      if (this.inFlight === task) this.inFlight = null;
    }
  }

  /** Input side. Yields to a running frame, but never waits on a stuck one. */
  async input<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingInput += 1;
    try {
      const running = this.inFlight;
      if (running) {
        await Promise.race([
          running.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, INPUT_SETTLE_MS);
            timer.unref?.();
          }),
        ]);
      }
      return await fn();
    } finally {
      this.pendingInput -= 1;
    }
  }
}

const envForceXvfb = (() => {
  if (process.env.RECORDER_ENABLE_XVFB) {
    return process.env.RECORDER_ENABLE_XVFB === 'true';
  }
  if (process.env.RECORDER_DISABLE_XVFB) {
    return !(process.env.RECORDER_DISABLE_XVFB === 'true');
  }
  return undefined;
})();

const envCaptureMode = (process.env.RECORDER_CAPTURE_MODE?.toLowerCase() as CaptureMode | undefined) ?? undefined;

export class RecorderError extends Error {
  public constructor(
    public readonly code:
      | 'INVALID_URL'
      | 'XVFB_DISABLED'
      | 'XVFB_START_FAILED'
      | 'XVFB_DISPLAY_UNAVAILABLE'
      | 'FFMPEG_FAILED'
      | 'NAVIGATION_FAILED'
      | 'UNEXPECTED_FAILURE',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    this.name = 'RecorderError';
  }
}

class LocalRecordingStorage implements RecordingStorageProvider {
  private readonly baseDir: string;

  public constructor(baseDir: string = DEFAULT_RECORDINGS_DIR) {
    this.baseDir = baseDir;
  }

  public async save(tempPath: string, meta: RecordingMetadata): Promise<StorageLocation> {
    const sessionDir = path.join(this.baseDir, meta.sessionId);
    await mkdir(sessionDir, { recursive: true });
    const destination = path.join(sessionDir, meta.filename);
    await rename(tempPath, destination);

    return {
      type: 'local',
      uri: destination,
      metadata: {
        sessionId: meta.sessionId,
        url: meta.url,
      },
    };
  }
}

export class Recorder {
  private readonly viewport: ViewportSize;
  private readonly scroll: ScrollBehavior;
  private readonly ffmpeg: FfmpegOptions;
  private readonly recordingsDir: string;
  private readonly storageProvider: RecordingStorageProvider;
  private readonly navigationTimeoutMs: number;
  private readonly captureMode: CaptureMode;
  private readonly xvfbOptions: Required<Pick<XvfbSettings, 'enabled' | 'required' | 'depth'>> & {
    extraArgs: string[];
  };

  public constructor(private readonly options: RecorderOptions = {}) {
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.scroll = { ...DEFAULT_SCROLL, ...(options.scroll ?? {}) };
    this.ffmpeg = { ...DEFAULT_FFMPEG, ...(options.ffmpeg ?? {}) };
    this.recordingsDir = options.outputDir ?? DEFAULT_RECORDINGS_DIR;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;
    this.storageProvider =
      options.storageProvider ?? new LocalRecordingStorage(this.recordingsDir);

    const runtimeDefaultXvfbEnabled = envForceXvfb ?? (process.platform === 'linux');

    this.xvfbOptions = {
      enabled: options.xvfb?.enabled ?? runtimeDefaultXvfbEnabled,
      required: options.xvfb?.required ?? true,
      depth: options.xvfb?.depth ?? 24,
      extraArgs: options.xvfb?.extraArgs ?? [],
    };

    this.captureMode = options.captureMode ?? envCaptureMode ?? 'auto';
  }

  private resolveCaptureMode(): 'xvfb' | 'screenshot' {
    if (this.captureMode === 'xvfb') return 'xvfb';
    if (this.captureMode === 'screenshot') return 'screenshot';
    // auto: prefer Xvfb only on linux when it's enabled, otherwise use
    // headless screenshot-based capture (works on macOS/Windows too).
    if (process.platform === 'linux' && this.xvfbOptions.enabled) {
      return 'xvfb';
    }
    return 'screenshot';
  }

  /**
   * @param options.targetDurationMs How long the capture should last. The
   *   caller knows the voiceover length; without it the recording ends whenever
   *   scrolling happens to finish, which is unrelated to the narration and left
   *   the fused video short.
   */
  public async record(
    rawUrl: string,
    options: {
      targetDurationMs?: number;
      /**
       * The walkthrough to perform: navigations, clicks, typing and the camera
       * framing for each. Optional — without it the recorder falls back to a
       * plain scroll, which is what happens when no LLM is available or when
       * scouting or directing failed.
       */
      beats?: Beat[];
      /** Persona substituted into `{{token}}` values as they are typed. */
      identity?: DummyIdentity;
    } = {},
  ): Promise<RecordingResult> {
    const url = this.normalizeUrl(rawUrl);
    const sessionId = randomUUID();
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'pitchbox-rec-'));
    const tmpOutput = path.join(tmpDir, `${sessionId}.mp4`);
    const startedAt = new Date();
    const mode = this.resolveCaptureMode();

    try {
      if (mode === 'xvfb') {
        await this.recordWithXvfb(url, tmpOutput, options.targetDurationMs, options.beats, options.identity);
      } else {
        await this.recordWithScreenshots(
          url,
          tmpOutput,
          options.targetDurationMs,
          options.beats,
          options.identity,
        );
      }

      const endedAt = new Date();
      const storageLocation = await this.storageProvider.save(tmpOutput, {
        sessionId,
        url,
        filename: `${sessionId}.mp4`,
        startedAt,
        viewport: this.viewport,
      });

      await rm(tmpDir, { recursive: true, force: true });

      return {
        sessionId,
        url,
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        viewport: this.viewport,
        storage: storageLocation,
        localPath: storageLocation.uri,
      };
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      throw this.wrapError(error);
    }
  }

  /**
   * Capture by grabbing an X display, and drive the walkthrough on it.
   *
   * This path exists because asking Chromium for frames does not work
   * everywhere. Inside the Daytona sandbox both `page.screenshot` strategies
   * hang indefinitely — compositor and renderer alike — while the same browser
   * navigates and runs scripts perfectly. ffmpeg reading the X display never
   * asks the browser for anything, so it is immune to whatever that is.
   *
   * It used to only scroll, which is why the repo path could not have produced a
   * walkthrough even once the app was running. It now runs the same beats as the
   * screenshot path.
   *
   * It also needs no capture gate: with no screenshots in flight there is nothing
   * for a mouse event to collide with, which removes that hazard entirely.
   */
  private async recordWithXvfb(
    url: string,
    tmpOutput: string,
    targetDurationMs?: number,
    beats?: Beat[],
    identity?: DummyIdentity,
  ): Promise<void> {
    let virtualDisplay: VirtualDisplaySession | undefined;
    let ffmpegProcess: ChildProcessWithoutNullStreams | undefined;
    let browser: Browser | undefined;

    try {
      virtualDisplay = await this.startVirtualDisplay();
      const ffmpegDisplay = virtualDisplay.display;

      ffmpegProcess = this.spawnFfmpegX11(ffmpegDisplay, tmpOutput);
      await this.waitForProcessSpawn(ffmpegProcess);

      browser = await this.launchBrowserHeaded(ffmpegDisplay);
      const page = await browser.newPage();
      await this.preparePage(page, url);

      const walkthrough = beats ?? [];
      const startedAt = Date.now();

      if (walkthrough.length) {
        try {
          await this.instrumentPage(page);
          // A gate with no screenshot side is a no-op, which is exactly right.
          await this.runWalkthrough(page, walkthrough, targetDurationMs ?? 0, new CaptureGate(), identity);
        } catch (err) {
          console.warn('[recorder] walkthrough aborted:', describeError(err));
        }
      } else {
        await this.scrollToBottom(page).catch(() => undefined);
      }

      // ffmpeg is recording wall-clock time, so hold the display until the
      // narration's full length has elapsed rather than stopping when the
      // walkthrough happens to finish.
      const remaining = (targetDurationMs ?? 0) - (Date.now() - startedAt);
      await this.delay(remaining > 0 ? remaining : this.scroll.tailWaitMs);

      await this.stopProcess(ffmpegProcess);
      ffmpegProcess = undefined;

      await browser.close();
      browser = undefined;

      await virtualDisplay.stop();
      virtualDisplay = undefined;

      // The exit code cannot say whether this worked (see stopProcess), so the
      // file does.
      const written = await stat(tmpOutput).catch(() => undefined);
      if (!written || written.size < 1_024) {
        throw new RecorderError(
          'FFMPEG_FAILED',
          `X11 capture produced ${written ? `${written.size} bytes` : 'no file'} — nothing was recorded. ` +
            'ffmpeg may not have been able to read the virtual display.',
        );
      }
      console.log(`[recorder] X11 capture wrote ${(written.size / 1024).toFixed(0)} KB`);
    } finally {
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
      }
      if (browser) {
        await browser.close().catch(() => undefined);
      }
      if (virtualDisplay) {
        await virtualDisplay.stop().catch(() => undefined);
      }
    }
  }

  private async recordWithScreenshots(
    url: string,
    tmpOutput: string,
    targetDurationMs?: number,
    beats?: Beat[],
    identity?: DummyIdentity,
  ): Promise<void> {
    let ffmpegProcess: ChildProcessWithoutNullStreams | undefined;
    let browser: Browser | undefined;
    let capturing = false;
    let watchdog: NodeJS.Timeout | undefined;
    const gate = new CaptureGate();
    // Measured so the finished file can be retimed to real time — see below.
    let capturedMs = 0;
    let capturedFrames = 0;

    try {
      ffmpegProcess = this.spawnFfmpegImagePipe(tmpOutput);
      await this.waitForProcessSpawn(ffmpegProcess);

      const ffmpegStdin = ffmpegProcess.stdin;
      // Surface ffmpeg failures instead of silently hanging the writer loop.
      ffmpegStdin.on('error', () => {
        capturing = false;
      });

      browser = await this.launchBrowserHeadless();
      const page = await browser.newPage();
      await page.setViewport({ width: this.viewport.width, height: this.viewport.height });
      await this.preparePage(page, url);

      // Install the camera before any frame is captured, so beat 0 is already
      // in place when recording starts. Failure here is not fatal: a plain
      // scroll is a worse video, not a broken one.
      let walkthrough = beats ?? [];
      if (walkthrough.length) {
        try {
          await this.instrumentPage(page);
        } catch (err) {
          console.warn('[recorder] could not install the camera, falling back to scroll:', err);
          walkthrough = [];
        }
      }
      const hasWalkthrough = walkthrough.length > 0;

      capturing = true;
      const frameIntervalMs = Math.max(1, Math.floor(1000 / this.ffmpeg.frameRate));
      // Real capture rate is measured, not assumed — see the retime below.
      const captureStartedAt = Date.now();
      let frameCount = 0;

      // Hard cap on the whole capture. A busy SPA renderer can make a single
      // page.screenshot() block with no timeout, which would stall the loop
      // forever; the watchdog stops capturing and force-closes the browser so
      // any pending screenshot rejects and the loop unwinds to finalize the mp4.
      // The floor is the caller's target when there is one: the watchdog must
      // never fire before the requested footage has been captured.
      const scrollBudgetMs = this.scroll.maxScrollMs + this.scroll.tailWaitMs;
      const hardCapMs = Math.max(scrollBudgetMs, targetDurationMs ?? 0) + 10_000;
      const capturingBrowser = browser;
      watchdog = setTimeout(() => {
        capturing = false;
        capturingBrowser.close().catch(() => undefined);
      }, hardCapMs);
      watchdog.unref?.();

      // Either the walkthrough drives the app, or we fall back to scrolling.
      // Both are fire-and-forget: they drive motion while frames are captured.
      const scrollPromise = hasWalkthrough
        ? this.runWalkthrough(page, walkthrough, targetDurationMs ?? 0, gate, identity).catch((err) => {
            console.warn('[recorder] walkthrough aborted:', err);
          })
        : this.scrollToBottom(page).catch(() => undefined);

      const tailAt = Date.now() + scrollBudgetMs;
      // Absolute end of capture. With a target we run the full length even after
      // scrolling stops; without one we keep the old scroll-driven behaviour.
      const endAt = targetDurationMs ? Date.now() + targetDurationMs : undefined;
      let scrollFinished = false;
      scrollPromise.finally(() => {
        scrollFinished = true;
      });

      let healthyAt = Date.now();
      let frameErrors = 0;
      // Compositor capture is ~13x faster where it works — 24ms a frame locally
      // against 313ms — so it stays the default and is abandoned only if it
      // actually fails. Inside the Daytona sandbox it hangs indefinitely: there
      // is no compositor surface to read back from, and every frame ran out its
      // deadline while the same Chromium navigated and ran scripts perfectly.
      // Pinning either value would give up the fast path or the sandbox, so the
      // first failed frame flips it and the rest of the capture proceeds.
      let fromSurface = true;
      while (capturing) {
        const frameStart = Date.now();

        // Stand off while a click is being dispatched, so the input lands on a
        // channel of its own. Cheap: input holds this for a few tens of ms.
        if (gate.inputActive) {
          await this.delay(15);
          continue;
        }

        let frame: Buffer;
        try {
          frame = (await gate.capture(() =>
            withDeadline(
              page.screenshot({
                type: 'jpeg',
                quality: 80,
                fullPage: false,
                captureBeyondViewport: false,
                fromSurface,
                // Skips Puppeteer's extra encode pass. On a constrained sandbox
                // that pass is the difference between a frame arriving and the
                // whole capture timing out.
                optimizeForSpeed: true,
              }),
              frameCount === 0 ? FIRST_FRAME_TIMEOUT_MS : SCREENSHOT_TIMEOUT_MS,
              'screenshot',
            ),
          )) as Buffer;
          healthyAt = Date.now();
        } catch (err) {
          // The walkthrough navigates mid-capture, and a screenshot straddling
          // a document swap fails or stalls. Dropping the recording there would
          // truncate it at the first page change, so ride the failures out and
          // give up only if nothing has come back for a good while.
          //
          // Logged, and sparsely: a sandbox that cannot screenshot at all
          // produces an empty video, and without this the only evidence was a
          // bare ffmpeg exit code with no mention of the real cause.
          frameErrors += 1;
          if (frameErrors <= 3 || frameErrors % 50 === 0) {
            console.warn(`[recorder] screenshot ${frameErrors} failed: ${describeError(err)}`);
          }
          // Nothing has been captured yet and the fast path just failed: this is
          // a machine with no readable surface, so stop asking for one.
          if (frameCount === 0 && fromSurface) {
            fromSurface = false;
            console.warn('[recorder] compositor capture is not working here; falling back to renderer capture.');
            continue;
          }
          if (Date.now() - healthyAt >= FRAME_FAILURE_WINDOW_MS) break;
          await this.delay(frameIntervalMs);
          continue;
        }

        if (!ffmpegStdin.writable) break;
        frameCount += 1;
        const ok = ffmpegStdin.write(frame);
        if (!ok) {
          await new Promise<void>((resolve) => ffmpegStdin.once('drain', () => resolve()));
        }

        if (endAt !== undefined) {
          if (Date.now() >= endAt) break;
          // Time left but nothing moving: restart the scroll so the footage keeps
          // motion instead of holding one frozen frame under the narration.
          // Never do this under a walkthrough — a scroll started behind the
          // camera's back drags the page out from under the framing.
          if (scrollFinished && !hasWalkthrough) {
            scrollFinished = false;
            void page
              .evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }))
              .then(() => this.scrollToBottom(page))
              .catch(() => undefined)
              .finally(() => {
                scrollFinished = true;
              });
          }
        } else if (scrollFinished && Date.now() >= tailAt) {
          break;
        }

        const elapsed = Date.now() - frameStart;
        const wait = frameIntervalMs - elapsed;
        if (wait > 0) await this.delay(wait);
      }

      capturing = false;
      if (watchdog) clearTimeout(watchdog);
      capturedMs = Date.now() - captureStartedAt;
      capturedFrames = frameCount;
      ffmpegStdin.end();

      // Diagnose this here rather than letting ffmpeg fail on an empty stream:
      // "ffmpeg exited with code 234" tells nobody that not one screenshot ever
      // came back, which is the actual problem.
      if (frameCount === 0) {
        throw new RecorderError(
          'UNEXPECTED_FAILURE',
          `No frames were captured — all ${frameErrors} screenshot attempt(s) failed, so there was ` +
            'nothing to encode. The browser may have died, or the machine may be too slow or too ' +
            `small to screenshot the page within ${SCREENSHOT_TIMEOUT_MS}ms.`,
        );
      }

      // The watchdog may have already closed the browser; close() is safe to
      // call again but can reject, so swallow it.
      await browser.close().catch(() => undefined);
      browser = undefined;

      await this.waitForClose(ffmpegProcess);
      ffmpegProcess = undefined;

      await this.retimeToRealTime(tmpOutput, capturedFrames, capturedMs);
    } finally {
      capturing = false;
      if (watchdog) clearTimeout(watchdog);
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
      }
      if (browser) {
        await browser.close().catch(() => undefined);
      }
    }
  }

  /**
   * Stretch the captured file so playback matches the time it actually took.
   *
   * Frames are piped to ffmpeg labelled at `frameRate`, but a headless
   * screenshot loop cannot hit 30fps — with zoom transitions it manages around
   * 20. ffmpeg honours the label, so 89 seconds of capture became a 58-second
   * file: the motion played fast and every recording came out short of the
   * narration, which the fuser then papered over by looping.
   *
   * Rescaling the container timestamps is a stream copy — no re-encode, no
   * quality loss, and the motion plays at the speed it was captured.
   */
  private async retimeToRealTime(filePath: string, frames: number, elapsedMs: number): Promise<void> {
    if (frames < 2 || elapsedMs < 1_000) return;
    const actualFps = frames / (elapsedMs / 1000);
    const scale = this.ffmpeg.frameRate / actualFps;
    // Under ~5% off is not worth a remux.
    if (!Number.isFinite(scale) || Math.abs(scale - 1) < 0.05) return;

    const retimed = `${filePath}.retimed.mp4`;
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-y',
          '-loglevel', 'error',
          // Scales input timestamps; with -c copy this is a fast remux.
          '-itsscale', scale.toFixed(6),
          '-i', filePath,
          '-c', 'copy',
          retimed,
        ]);
        proc.on('error', reject);
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg retime exited ${code}`))));
      });
      await rename(retimed, filePath);
      console.log(`[recorder] retimed capture: ${actualFps.toFixed(1)}fps actual -> ${(elapsedMs / 1000).toFixed(1)}s`);
    } catch (err) {
      // A failed retime leaves the original (short) file, which still works.
      console.warn('[recorder] retime failed, keeping original timing:', err);
      await rm(retimed, { force: true }).catch(() => undefined);
    }
  }

  private wrapError(error: unknown): RecorderError {
    if (error instanceof RecorderError) {
      return error;
    }

    if (error instanceof Error) {
      return new RecorderError('UNEXPECTED_FAILURE', error.message, { cause: error });
    }

    return new RecorderError('UNEXPECTED_FAILURE', 'Unknown recorder failure', {
      cause: error,
    });
  }

  private normalizeUrl(input: string): string {
    if (!input || !input.trim()) {
      throw new RecorderError('INVALID_URL', 'A non-empty URL is required.');
    }

    const candidate = input.match(/^https?:\/\//i) ? input : `https://${input}`;

    try {
      const normalized = new URL(candidate);
      return normalized.toString();
    } catch (error) {
      throw new RecorderError('INVALID_URL', `Invalid URL: ${input}`, { cause: error });
    }
  }

  /**
   * Start a virtual X display for ffmpeg to grab.
   *
   * Xvfb is spawned directly rather than through the `xvfb` npm wrapper. The
   * wrapper's job is to allocate a display and tell you its number, and inside
   * the Daytona sandbox it does the first but not the second — the run died with
   * "Xvfb did not provide a display number" while Xvfb itself was fine. Choosing
   * the number here removes the guesswork: we know what we asked for.
   */
  private async startVirtualDisplay(): Promise<VirtualDisplaySession> {
    if (!this.xvfbOptions.enabled) {
      throw new RecorderError(
        'XVFB_DISABLED',
        'Virtual display capture is disabled. Enable it or switch to screenshot capture mode.',
      );
    }

    const screen = `${this.viewport.width}x${this.viewport.height}x${this.xvfbOptions.depth}`;

    // Try a few display numbers: a sandbox may already have one in use, and
    // Xvfb fails rather than picking another.
    let lastError: unknown;
    for (const candidate of [99, 98, 97, 96]) {
      const display = `:${candidate}`;
      const child = spawn(
        'Xvfb',
        [display, '-screen', '0', screen, '-nolisten', 'tcp', ...this.xvfbOptions.extraArgs],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
      });

      const exited = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
        child.once('error', () => resolve(-1));
      });

      // Ready when the lock file appears; Xvfb creates it once it is serving.
      const ready = (async () => {
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            await access(`/tmp/.X${candidate}-lock`);
            return true;
          } catch {
            await this.delay(250);
          }
        }
        return false;
      })();

      const outcome = await Promise.race([ready, exited.then(() => false as const)]);

      if (outcome === true) {
        return {
          display,
          stop: async () => {
            child.kill('SIGTERM');
            await this.delay(200);
            if (child.exitCode === null) child.kill('SIGKILL');
          },
        };
      }

      child.kill('SIGKILL');
      lastError = stderr.trim() || `Xvfb on ${display} did not become ready`;
    }

    throw new RecorderError(
      'XVFB_START_FAILED',
      `Could not start Xvfb on any display. Last error: ${String(lastError)}`,
    );
  }

  private spawnFfmpegX11(display: string, outputPath: string): ChildProcessWithoutNullStreams {
    const ffmpegArgs = [
      '-y',
      '-hide_banner',
      '-loglevel',
      this.ffmpeg.loglevel,
      '-f',
      'x11grab',
      '-video_size',
      `${this.viewport.width}x${this.viewport.height}`,
      '-framerate',
      `${this.ffmpeg.frameRate}`,
      '-draw_mouse',
      '0',
      '-i',
      `${display}.0`,
      '-c:v',
      this.ffmpeg.codec,
      '-preset',
      this.ffmpeg.preset,
      '-pix_fmt',
      this.ffmpeg.pixelFormat,
      outputPath,
    ];

    return this.traceFfmpeg(
      spawn('ffmpeg', ffmpegArgs, {
        env: { ...process.env, DISPLAY: display },
      }),
    );
  }

  private spawnFfmpegImagePipe(outputPath: string): ChildProcessWithoutNullStreams {
    const ffmpegArgs = [
      '-y',
      '-hide_banner',
      '-loglevel',
      this.ffmpeg.loglevel,
      '-f',
      'image2pipe',
      '-framerate',
      `${this.ffmpeg.frameRate}`,
      '-vcodec',
      'mjpeg',
      '-i',
      '-',
      '-vf',
      `scale=${this.viewport.width}:${this.viewport.height}:force_original_aspect_ratio=decrease,pad=${this.viewport.width}:${this.viewport.height}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v',
      this.ffmpeg.codec,
      '-preset',
      this.ffmpeg.preset,
      '-pix_fmt',
      this.ffmpeg.pixelFormat,
      '-movflags',
      '+faststart',
      outputPath,
    ];

    return this.traceFfmpeg(spawn('ffmpeg', ffmpegArgs));
  }

  /**
   * Keep the tail of ffmpeg's stderr on the process object.
   *
   * ffmpeg explains itself on stderr and then exits with a code that means
   * nothing on its own. A real sandbox run died with "ffmpeg exited with code
   * 234" and there was no way to find out why, because the only thing anyone
   * ever saw was the number.
   */
  private traceFfmpeg(proc: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
    const traced = proc as FfmpegProcess;
    traced.pbxStderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      traced.pbxStderr = `${traced.pbxStderr ?? ''}${chunk.toString()}`.slice(-4_000);
    });
    return proc;
  }

  private async waitForProcessSpawn(
    childProcess: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const handleSpawn = () => {
        childProcess.off('error', handleError);
        resolve();
      };

      const handleError = (error: Error) => {
        childProcess.off('spawn', handleSpawn);
        reject(new RecorderError('FFMPEG_FAILED', 'ffmpeg failed to start.', { cause: error }));
      };

      childProcess.once('spawn', handleSpawn);
      childProcess.once('error', handleError);
    });
  }

  /**
   * Stop a recording ffmpeg that we started, and do not mistake its goodbye for
   * a failure.
   *
   * ffmpeg exits 255 when it is interrupted — which is precisely how this stops
   * it — and it finalises the file on the way out. Insisting on exit 0 therefore
   * failed every X11 capture *after* it had successfully recorded, reported as a
   * bare "ffmpeg exited with code 255". A non-zero code here is expected; the
   * output file is what says whether the capture worked, and the caller checks
   * that next.
   */
  private async stopProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        process.kill('SIGKILL');
        resolve();
      }, 8_000);

      process.once('close', (code) => {
        clearTimeout(timeout);
        // 255 and 130 are the two ways ffmpeg reports "you interrupted me".
        if (code !== null && code !== 0 && code !== 255 && code !== 130) {
          console.warn(`[recorder] ${describeFfmpegFailure(process, code)}`);
        }
        resolve();
      });

      process.once('error', (error) => {
        clearTimeout(timeout);
        console.warn('[recorder] ffmpeg errored while stopping:', describeError(error));
        resolve();
      });

      process.kill('SIGINT');
    });
  }

  private async waitForClose(process: ChildProcessWithoutNullStreams): Promise<void> {
    // If ffmpeg has already exited, the 'close' event has fired and will not
    // fire again — attaching a listener now would hang forever. Resolve based
    // on the recorded exit state instead.
    if (process.exitCode !== null || process.signalCode !== null) {
      if (process.exitCode === 0) return;
      throw new RecorderError('FFMPEG_FAILED', describeFfmpegFailure(process, process.exitCode));
    }

    await new Promise<void>((resolve, reject) => {
      // After stdin.end(), ffmpeg flushes and exits on its own. If it does not,
      // SIGKILL it and resolve anyway — a partial mp4 is better than a hang.
      const timeout = setTimeout(() => {
        process.kill('SIGKILL');
        resolve();
      }, 30_000);

      process.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new RecorderError('FFMPEG_FAILED', describeFfmpegFailure(process, code)));
        }
      });

      process.once('error', (error) => {
        clearTimeout(timeout);
        reject(new RecorderError('FFMPEG_FAILED', 'ffmpeg encountered an error.', { cause: error }));
      });
    });
  }

  private async launchBrowserHeaded(display: string): Promise<Browser> {
    const chromiumArgs = new Set<string>([
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      // This browser is being filmed, so none of the browser may be in shot.
      // Grabbing an X display captures the whole window, chrome included, and
      // the first successful sandbox recording came out with a tab strip, a URL
      // bar and a yellow "Chrome is being controlled by automated test software"
      // banner across the top — a technically correct video nobody could publish.
      '--kiosk',
      '--start-fullscreen',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=0,0',
      `--window-size=${this.viewport.width},${this.viewport.height}`,
    ]);

    const launchOptions: LaunchOptions & BrowserLaunchArgumentOptions = {
      // Chromium renders to the Xvfb virtual display, so it cannot be in headless mode here.
      headless: false,
      // Puppeteer adds `--enable-automation`, which is what draws the banner.
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: {
        width: this.viewport.width,
        height: this.viewport.height,
      },
      args: Array.from(chromiumArgs),
      timeout: this.navigationTimeoutMs,
      env: { ...process.env, DISPLAY: display },
    };

    return puppeteer.launch(launchOptions);
  }

  private async launchBrowserHeadless(): Promise<Browser> {
    const chromiumArgs = new Set<string>([
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--hide-scrollbars',
      // Container-safe rendering. Inside the Daytona sandbox every screenshot
      // was timing out after 15 seconds and the capture produced no frames at
      // all — which is what surfaced originally as an unexplained `ffmpeg exited
      // with code 234`. A headless Chromium with no GPU and no compositor to
      // read a surface from is the usual cause, and these are the usual flags.
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--use-gl=swiftshader',
      `--window-size=${this.viewport.width},${this.viewport.height}`,
    ]);

    const launchOptions: LaunchOptions & BrowserLaunchArgumentOptions = {
      headless: true,
      defaultViewport: {
        width: this.viewport.width,
        height: this.viewport.height,
      },
      args: Array.from(chromiumArgs),
      timeout: this.navigationTimeoutMs,
    };

    return puppeteer.launch(launchOptions);
  }

  private async preparePage(page: Page, url: string): Promise<void> {
    // Registered before the first navigation so the shim is present on every
    // document the walkthrough reaches, including this one.
    await page.evaluateOnNewDocument(SHIM_SOURCE).catch(() => undefined);
    try {
      // Wait only for DOM content — SPAs with persistent connections (websockets,
      // analytics, realtime) may never reach full network idle, which would hang
      // navigation. We then make a *bounded* best-effort wait for the network to
      // settle so the first frames aren't blank, but never fail on it.
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });
    } catch (error) {
      throw new RecorderError('NAVIGATION_FAILED', `Unable to navigate to ${url}`, { cause: error });
    }
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8_000 }).catch(() => undefined);
    // Done here as well as per-beat: a plain scrolling capture never calls
    // instrumentPage, and a cookie wall ruins that recording just as thoroughly.
    await page.evaluate(SHIM_SOURCE).catch(() => undefined);
    const dismissed = await page.evaluate(dismissOverlays).catch(() => null);
    if (dismissed) {
      console.log(`[recorder] dismissed an overlay via "${dismissed}"`);
      await this.delay(600);
    }
    await this.delay(this.scroll.preScrollWaitMs);
  }

  /**
   * Drive the app through the planned walkthrough, against the wall clock.
   *
   * Timing is absolute rather than cumulative: a slow camera move or a page
   * that takes its time would otherwise push every later beat out of sync with
   * the narration, and the whole point is that the picture lands on the
   * sentence. Camera moves additionally *lead* their beat by the length of the
   * move, so they settle on it rather than starting on it.
   */
  private async runWalkthrough(
    page: Page,
    beats: Beat[],
    totalMs: number,
    gate: CaptureGate,
    identity?: DummyIdentity,
  ): Promise<void> {
    const startedAt = Date.now();

    for (const beat of beats) {
      const framing = beat.reframe !== false && !!beat.selector;
      const dueAt = startedAt + beat.atSec * 1000;
      const wait = (framing ? dueAt - CAMERA_MOVE_MS : dueAt) - Date.now();
      if (wait > 0) await this.delay(wait);
      if (totalMs && Date.now() - startedAt >= totalMs) break;

      try {
        await this.performBeat(page, beat, framing, gate, identity);
      } catch (err) {
        // A selector stops resolving whenever the app re-renders differently
        // from how the scout found it. Skip the beat rather than abandoning
        // the rest of the walkthrough.
        console.warn(`[recorder] beat at ${beat.atSec}s (${beat.action}) failed:`, describeError(err));
      }
    }

    // Ease out so the video does not end mid-push.
    await page.evaluate(resetCamera, 900).catch(() => undefined);
  }

  private async performBeat(
    page: Page,
    beat: Beat,
    framing: boolean,
    gate: CaptureGate,
    identity?: DummyIdentity,
  ): Promise<void> {
    if (beat.action === 'goto') {
      if (!beat.url) return;
      await page.goto(beat.url, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs });
      await page.waitForNetworkIdle({ idleTime: 350, timeout: 4_000 }).catch(() => undefined);
      await this.instrumentPage(page);
      if (beat.selector) await this.frame(page, beat);
      return;
    }

    if (!beat.selector) return;

    // A previous beat may have navigated, which takes the overlays with it.
    await this.instrumentPage(page);
    if (framing) await this.frame(page, beat);

    if (beat.action === 'click') {
      await this.pointAndClick(page, beat.selector, gate);
      await this.delay(POST_CLICK_MS);
      // Re-install in case that click was the thing that navigated.
      await this.instrumentPage(page);
      return;
    }

    if (beat.action === 'type') {
      const value = identity ? resolveTokens(beat.value ?? '', identity) : (beat.value ?? '');
      if (!value) return;
      await this.pointAndClick(page, beat.selector, gate);
      // Typed rather than assigned: a controlled React input ignores a value
      // set on the element, and the viewer should see the characters appear.
      await page.keyboard.type(value, { delay: TYPE_DELAY_MS });
      return;
    }

    // 'hold' and 'scrollTo' are camera-only; framing above was the whole beat.
  }

  /** Run one camera move and wait for it to settle. */
  private async frame(page: Page, beat: Beat): Promise<void> {
    if (!beat.selector) return;
    await page.evaluate(moveCamera, beat.selector, beat.zoom, beat.highlight, CAMERA_MOVE_MS);
  }

  /**
   * Glide the visible pointer onto the element, then click where it landed.
   *
   * Clicking the returned coordinates rather than the selector matters twice
   * over: the pointer the viewer sees and the click the browser makes can never
   * disagree, and Puppeteer's selector click scrolls the element into view,
   * which would yank the page out from under the camera mid-shot.
   */
  private async pointAndClick(page: Page, selector: string, gate: CaptureGate): Promise<void> {
    const point = await page.evaluate(moveCursorTo, selector).catch(() => null);
    if (!point) {
      await gate.input(() => page.click(selector, { delay: 40 })).catch(() => undefined);
      return;
    }
    await this.delay(CURSOR_GLIDE_MS);
    await page.evaluate(cursorPulse).catch(() => undefined);
    await gate.input(() => page.mouse.click(point.x, point.y, { delay: 40 }));
  }

  /**
   * Make the page ready for camera calls. Cheap and idempotent, so it can be
   * run before every beat rather than tracking navigations.
   *
   * tsx/esbuild wraps transpiled functions with a `__name` helper to preserve
   * Function.prototype.name. page.evaluate() ships the function's *source* to
   * the browser, where that helper doesn't exist — so every camera call died
   * with "__name is not defined" and silently fell back to scrolling. The shim
   * is registered on new documents too, so it survives the walkthrough's own
   * navigations. Passed as a string on purpose: string arguments aren't
   * transpiled, so this one line can't itself depend on the helper it installs.
   */
  private async instrumentPage(page: Page): Promise<void> {
    await page.evaluate(SHIM_SOURCE);
    await page.evaluate(installCinematics);
    // A consent wall would swallow every click of the walkthrough and put a
    // modal in the opening shot. Self-limiting to once per document, so this
    // stays cheap even though it runs before every beat.
    const dismissed = await page.evaluate(dismissOverlays).catch(() => null);
    if (dismissed) console.log(`[recorder] dismissed an overlay via "${dismissed}"`);
  }

  private async scrollToBottom(page: Page): Promise<void> {
    await page.evaluate(
      async (config: { stepPx: number; delayMs: number; maxScrollMs: number }) => {
        await new Promise<void>((resolve) => {
          let elapsed = 0;
          const interval = window.setInterval(() => {
            const scrollHeight =
              document.documentElement?.scrollHeight ?? document.body.scrollHeight ?? 0;
            const currentPosition = window.scrollY + window.innerHeight;

            if (currentPosition + config.stepPx >= scrollHeight || elapsed >= config.maxScrollMs) {
              window.scrollTo({ top: scrollHeight, behavior: 'smooth' });
              window.clearInterval(interval);
              resolve();
              return;
            }

            window.scrollBy({ top: config.stepPx, behavior: 'smooth' });
            elapsed += config.delayMs;
          }, config.delayMs);
        });
      },
      {
        stepPx: this.scroll.stepPx,
        delayMs: this.scroll.delayMs,
        maxScrollMs: this.scroll.maxScrollMs,
      },
    );
  }

  private async delay(durationMs: number): Promise<void> {
    if (durationMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), durationMs);
    });
  }
}
