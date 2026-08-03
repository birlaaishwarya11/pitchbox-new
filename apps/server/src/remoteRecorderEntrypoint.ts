import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { Recorder } from './Recorder';
import { SiteScout } from './SiteScout';
import type { Beat } from './cinematics/types';
import type { DummyIdentity } from './cinematics/dummyIdentity';

/**
 * Runs inside the Daytona sandbox, next to the app being demoed.
 *
 * Two modes, because the walkthrough has to be planned between them. Scouting
 * and recording both need to reach the app on localhost — the sandbox's public
 * preview URL needs a token and is not reliably reachable from within — but the
 * director that turns one into the other runs on the server, holding the user's
 * LLM key. So the server drives: scout here, plan there, record here.
 */

function createLogger() {
  const logPath = process.env.RECORDER_LOG_PATH ?? '/tmp/pitchbox-recorder.log';
  const stream = createWriteStream(logPath, { flags: 'a' });
  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    stream.write(`[${timestamp}] ${message}\n`);
  };
  return { log, close: () => stream.end() };
}

function getTargetUrl(): string {
  const url = process.env.RECORDER_TARGET_URL;
  if (!url || !url.trim()) {
    throw new Error('RECORDER_TARGET_URL is required.');
  }
  return url.trim();
}

function getDurationMs(): number {
  const raw = process.env.RECORDER_DURATION_MS ?? '';
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 5_000;
}

/** Read a JSON file the server uploaded, or undefined if there isn't one. */
async function readJsonFile<T>(path: string | undefined): Promise<T | undefined> {
  if (!path) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const logger = createLogger();
  const targetUrl = getTargetUrl();

  try {
    if (process.env.RECORDER_MODE === 'scout') {
      const outputPath = process.env.RECORDER_SITEMAP_PATH;
      if (!outputPath) throw new Error('RECORDER_SITEMAP_PATH is required in scout mode.');
      const identity = await readJsonFile<DummyIdentity>(process.env.RECORDER_IDENTITY_PATH);
      if (!identity) throw new Error('RECORDER_IDENTITY_PATH is required in scout mode.');

      logger.log(`Scouting ${targetUrl}`);
      const siteMap = await new SiteScout().explore(targetUrl, identity);
      // Written to a file rather than stdout: a site map of a large app runs to
      // tens of kilobytes, and the caller already downloads files from here.
      await writeFile(outputPath, JSON.stringify(siteMap), 'utf-8');
      logger.log(`Scouted ${siteMap.screens.length} screen(s).`);
      process.stdout.write(JSON.stringify({ screens: siteMap.screens.length, notes: siteMap.notes }));
      return;
    }

    const durationMs = getDurationMs();
    const beats = (await readJsonFile<Beat[]>(process.env.RECORDER_BEATS_PATH)) ?? [];
    const identity = await readJsonFile<DummyIdentity>(process.env.RECORDER_IDENTITY_PATH);

    logger.log(`Starting recording for ${targetUrl} (${durationMs}ms, ${beats.length} beats)`);

    const recorder = new Recorder({
      scroll: {
        stepPx: 220,
        delayMs: 1_100,
        maxScrollMs: Math.max(10_000, durationMs),
        preScrollWaitMs: 1_500,
        tailWaitMs: 2_000,
      },
    });

    // The duration is passed through now. Without it the capture ended whenever
    // scrolling happened to finish, which in this sandbox was immediately — so
    // every repo recording was a still frame held under the narration.
    const result = await recorder.record(targetUrl, { targetDurationMs: durationMs, beats, identity });
    logger.log(`Recording completed for ${targetUrl}. Session: ${result.sessionId}`);
    process.stdout.write(JSON.stringify(result));
  } finally {
    logger.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
