/// <reference lib="dom" />
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { harvestTargets, installCinematics, applyShot, resetCamera } from './cinematics/pageScript';
import type { PageTarget, Shot } from './cinematics/types';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
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
  instance: Xvfb;
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
       * Given the elements found on the page, return the camera moves to make.
       * Optional: without it the recorder falls back to a plain scroll, which is
       * what happens when no LLM is available or shot planning fails.
       */
      planShots?: (targets: PageTarget[]) => Promise<Shot[]>;
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
        await this.recordWithXvfb(url, tmpOutput);
      } else {
        await this.recordWithScreenshots(url, tmpOutput, options.targetDurationMs, options.planShots);
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

  private async recordWithXvfb(url: string, tmpOutput: string): Promise<void> {
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
      await this.scrollToBottom(page);
      await this.delay(this.scroll.tailWaitMs);

      await this.stopProcess(ffmpegProcess);
      ffmpegProcess = undefined;

      await browser.close();
      browser = undefined;

      await virtualDisplay.stop();
      virtualDisplay = undefined;
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
    planShots?: (targets: PageTarget[]) => Promise<Shot[]>,
  ): Promise<void> {
    let ffmpegProcess: ChildProcessWithoutNullStreams | undefined;
    let browser: Browser | undefined;
    let capturing = false;
    let watchdog: NodeJS.Timeout | undefined;

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

      // Plan the camera before any frame is captured, so shot 0 is already in
      // place when recording starts. Failure here is not fatal: a plain scroll
      // is a worse video, not a broken one.
      let shots: Shot[] = [];
      if (planShots) {
        try {
          // tsx/esbuild wraps transpiled functions with a `__name` helper to
          // preserve Function.prototype.name. page.evaluate() ships the
          // function's *source* to the browser, where that helper doesn't
          // exist — so every camera call died with "__name is not defined" and
          // silently fell back to scrolling. Define a no-op shim first.
          // Passed as a string on purpose: string arguments aren't transpiled,
          // so this one line can't itself depend on the helper it installs.
          await page.evaluate('globalThis.__name = globalThis.__name || ((fn) => fn)');

          const targets = await page.evaluate(harvestTargets);
          if (targets.length) {
            shots = await planShots(targets);
            await page.evaluate(installCinematics);
          }
        } catch (err) {
          console.warn('[recorder] shot planning failed, falling back to scroll:', err);
          shots = [];
        }
      }

      capturing = true;
      const frameIntervalMs = Math.max(1, Math.floor(1000 / this.ffmpeg.frameRate));

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

      // Either the camera runs the shot list, or we fall back to scrolling.
      // Both are fire-and-forget: they drive motion while frames are captured.
      const scrollPromise = shots.length
        ? this.runShotList(page, shots, targetDurationMs ?? 0).catch((err) => {
            console.warn('[recorder] shot list aborted:', err);
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

      while (capturing) {
        const frameStart = Date.now();
        let frame: Buffer;
        try {
          frame = (await page.screenshot({
            type: 'jpeg',
            quality: 80,
            fullPage: false,
            captureBeyondViewport: false,
          })) as Buffer;
        } catch {
          break;
        }

        if (!ffmpegStdin.writable) break;
        const ok = ffmpegStdin.write(frame);
        if (!ok) {
          await new Promise<void>((resolve) => ffmpegStdin.once('drain', () => resolve()));
        }

        if (endAt !== undefined) {
          if (Date.now() >= endAt) break;
          // Time left but nothing moving: restart the scroll so the footage keeps
          // motion instead of holding one frozen frame under the narration.
          if (scrollFinished) {
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
      ffmpegStdin.end();

      // The watchdog may have already closed the browser; close() is safe to
      // call again but can reject, so swallow it.
      await browser.close().catch(() => undefined);
      browser = undefined;

      await this.waitForClose(ffmpegProcess);
      ffmpegProcess = undefined;
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

  private async startVirtualDisplay(): Promise<VirtualDisplaySession> {
    if (!this.xvfbOptions.enabled) {
      throw new RecorderError(
        'XVFB_DISABLED',
        'Virtual display capture is disabled. Enable it or switch to screenshot capture mode.',
      );
    }

    const screen = `${this.viewport.width}x${this.viewport.height}x${this.xvfbOptions.depth}`;
    const xvfb = new Xvfb({
      xvfb_args: ['-screen', '0', screen, '-nolisten', 'tcp', ...this.xvfbOptions.extraArgs],
    });

    await new Promise<void>((resolve, reject) => {
      xvfb.start((err?: Error | null) => {
        if (err) {
          reject(new RecorderError('XVFB_START_FAILED', 'Failed to start Xvfb.', { cause: err }));
          return;
        }
        resolve();
      });
    });

    const displayNumber = this.extractDisplayNumber(xvfb);

    if (displayNumber === undefined) {
      await new Promise<void>((resolve) => {
        xvfb.stop(() => resolve());
      });
      throw new RecorderError('XVFB_DISPLAY_UNAVAILABLE', 'Xvfb did not provide a display number.');
    }

    const display = `:${displayNumber}`;

    return {
      instance: xvfb,
      display,
      stop: () =>
        new Promise<void>((resolve, reject) => {
          xvfb.stop((err?: Error | null) => {
            if (err) {
              reject(new RecorderError('XVFB_START_FAILED', 'Failed to stop Xvfb.', { cause: err }));
              return;
            }
            resolve();
          });
        }),
    };
  }

  private extractDisplayNumber(xvfb: Xvfb): number | undefined {
    const candidate = (xvfb as { display?: number }).display;
    if (typeof candidate === 'number') {
      return candidate;
    }

    const hiddenCandidate = (xvfb as { _display?: number })._display;
    if (typeof hiddenCandidate === 'number') {
      return hiddenCandidate;
    }

    return undefined;
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

    return spawn('ffmpeg', ffmpegArgs, {
      env: { ...process.env, DISPLAY: display },
    });
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

    return spawn('ffmpeg', ffmpegArgs);
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

  private async stopProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        process.kill('SIGKILL');
      }, 5_000);

      process.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(
            new RecorderError('FFMPEG_FAILED', `ffmpeg exited with code ${code ?? 'unknown'}.`),
          );
        }
      });

      process.once('error', (error) => {
        clearTimeout(timeout);
        reject(new RecorderError('FFMPEG_FAILED', 'ffmpeg encountered an error.', { cause: error }));
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
      throw new RecorderError('FFMPEG_FAILED', `ffmpeg exited with code ${process.exitCode ?? process.signalCode}.`);
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
          reject(
            new RecorderError('FFMPEG_FAILED', `ffmpeg exited with code ${code ?? 'unknown'}.`),
          );
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
      `--window-size=${this.viewport.width},${this.viewport.height}`,
    ]);

    const launchOptions: LaunchOptions & BrowserLaunchArgumentOptions = {
      // Chromium renders to the Xvfb virtual display, so it cannot be in headless mode here.
      headless: false,
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
    await this.delay(this.scroll.preScrollWaitMs);
  }

  /**
   * Execute planned shots against the wall clock.
   *
   * Timing is absolute rather than cumulative: a slow `applyShot` would
   * otherwise push every later shot out of sync with the narration, and the
   * whole point is that the picture lands on the sentence.
   */
  private async runShotList(page: Page, shots: Shot[], totalMs: number): Promise<void> {
    const startedAt = Date.now();
    for (const shot of shots) {
      const dueAt = startedAt + shot.atSec * 1000;
      const wait = dueAt - Date.now();
      if (wait > 0) await this.delay(wait);
      if (totalMs && Date.now() - startedAt >= totalMs) break;
      try {
        await page.evaluate(applyShot, shot.selector, shot.zoom, shot.highlight);
      } catch {
        // A selector can stop resolving if the page re-rendered. Skip the shot
        // rather than abandoning the rest of the sequence.
      }
    }
    // Ease out so the video does not end mid-push.
    await page.evaluate(resetCamera).catch(() => undefined);
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
