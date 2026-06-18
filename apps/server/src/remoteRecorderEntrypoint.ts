import { createWriteStream } from 'node:fs';
import { Recorder } from './Recorder';

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

async function main(): Promise<void> {
  const logger = createLogger();

  const targetUrl = getTargetUrl();
  const durationMs = getDurationMs();

  logger.log(`Starting recording for ${targetUrl} (duration: ${durationMs}ms)`);

  const recorder = new Recorder({
    scroll: {
      stepPx: 480,
      delayMs: 10,
      maxScrollMs: 10,
      preScrollWaitMs: 250,
      tailWaitMs: durationMs,
    },
  });

  try {
    const result = await recorder.record(targetUrl);
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

