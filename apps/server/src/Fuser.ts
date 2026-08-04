import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FuseInput {
  /**
   * The narration. Optional: a run with no voiceover still has a demo worth
   * keeping, and a narration that failed to generate should not take the
   * recording down with it.
   */
  audioPath?: string;
  videoPath?: string;
  outputDir: string;
  /**
   * How long a silent slate should last. Ignored when there is audio (the
   * narration sets the length) or a recording (the capture does).
   */
  fallbackDurationMs?: number;
  // Optional title text rendered onto the slate when no video is provided.
  slateTitle?: string;
  // Optional pre-rendered slate image (PNG). When provided, it is looped as the
  // slate background instead of relying on ffmpeg drawtext (which needs
  // libfreetype and renders black when unavailable).
  slateImagePath?: string;
}

export interface FuseResult {
  filePath: string;
  fileName: string;
  durationMs: number;
  bytes: number;
  mode: 'mux' | 'slate';
}

export class FuserError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'FuserError';
  }
}

/**
 * Combines an audio mp3 with a video mp4 (when available) into a final mp4.
 *
 * Two modes:
 *   - "mux"   — real screen recording exists; we overlay the voiceover and
 *               trim/pad to the longer of the two streams.
 *   - "slate" — no recording (Daytona disabled); we render a 1280x720 black
 *               slide with the title text and burn the audio onto it. This
 *               keeps the pipeline end-to-end testable without sandboxing.
 */
export class Fuser {
  async fuse(input: FuseInput): Promise<FuseResult> {
    await mkdir(input.outputDir, { recursive: true });

    // A path that was given but does not exist is a bug worth reporting. No path
    // at all is a deliberate silent run.
    if (input.audioPath && !(await safeStat(input.audioPath))) {
      throw new FuserError(`Audio file missing: ${input.audioPath}`);
    }
    const audioPath = input.audioPath;

    const fileName = `${randomUUID()}.mp4`;
    const filePath = path.join(input.outputDir, fileName);

    if (input.videoPath) {
      const videoStat = await safeStat(input.videoPath);
      if (!videoStat) throw new FuserError(`Video file missing: ${input.videoPath}`);
      await runMux(input.videoPath, audioPath, filePath);
      const out = await stat(filePath);
      return {
        filePath,
        fileName,
        durationMs: await ffprobeDurationMs(filePath),
        bytes: out.size,
        mode: 'mux',
      };
    }

    // With neither audio nor video there is nothing to derive a length from, so
    // a silent slate needs one stated. 20s is a sane last resort.
    const silentMs = Math.max(1_000, input.fallbackDurationMs ?? 20_000);

    // Both slate builders draw their video from an endless source (a looped still,
    // or a lavfi colour field), so the length has to be stated explicitly.
    // `-shortest` alone was overshooting the narration by a couple of seconds and
    // leaving dead air at the end of every slate demo.
    const slateMs = audioPath ? await ffprobeDurationMs(audioPath) : silentMs;
    const boundedMs = slateMs > 0 ? slateMs : silentMs;

    const slateImage = input.slateImagePath ? await safeStat(input.slateImagePath) : null;
    if (input.slateImagePath && slateImage) {
      await runImageSlate(input.slateImagePath, audioPath, filePath, boundedMs);
    } else {
      await runSlate(audioPath, filePath, input.slateTitle ?? 'Pitchbox demo', boundedMs);
    }
    const out = await stat(filePath);
    return {
      filePath,
      fileName,
      durationMs: await ffprobeDurationMs(filePath),
      bytes: out.size,
      mode: 'slate',
    };
  }
}

async function runImageSlate(
  imagePath: string,
  audioPath: string | undefined,
  outputPath: string,
  durationMs: number,
): Promise<void> {
  // Loop a still PNG as the video track. A looped still has no length of its
  // own, so `durationMs` is what stops it encoding forever.
  const args = [
    '-y',
    '-loop',
    '1',
    '-i',
    imagePath,
    ...(audioPath ? ['-i', audioPath] : []),
    '-c:v',
    'libx264',
    '-tune',
    'stillimage',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    'scale=1280:720',
    '-t',
    (durationMs / 1000).toFixed(2),
    ...(audioPath ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    outputPath,
  ];
  await runFfmpeg(args);
}

async function runMux(videoPath: string, audioPath: string | undefined, outputPath: string): Promise<void> {
  // No narration: the recording *is* the deliverable, so hand it over as-is.
  // Copying rather than re-encoding keeps it lossless and near-instant.
  if (!audioPath) {
    await runFfmpeg(['-y', '-i', videoPath, '-map', '0:v:0', '-an', '-c:v', 'copy', outputPath]);
    return;
  }

  // The recording and the voiceover are captured independently and rarely match
  // in length. `-shortest` alone truncates to whichever is shorter, and since a
  // screen capture usually finishes before the narration does, that silently
  // cut the voiceover off mid-sentence — the video looked fine and the script
  // was simply missing its ending.
  //
  // The narration is the content, so audio length wins. When the video is
  // shorter it loops to cover the difference; `-shortest` then trims the loop
  // at the moment the audio ends.
  const videoMs = await ffprobeDurationMs(videoPath);
  const audioMs = await ffprobeDurationMs(audioPath);
  // Half a second of slack: a trivial difference is not worth re-encoding for.
  const needsLoop = videoMs > 0 && audioMs > videoMs + 500;

  const args = [
    '-y',
    // -stream_loop applies to the input that follows it.
    ...(needsLoop ? ['-stream_loop', '-1'] : []),
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    // Looping a copied stream produces broken timestamps, so re-encode in that
    // case only; the straightforward path still just copies the video.
    ...(needsLoop ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    outputPath,
  ];
  await runFfmpeg(args);
}

async function runSlate(
  audioPath: string | undefined,
  outputPath: string,
  title: string,
  durationMs: number,
): Promise<void> {
  // Render a 1280x720 dark slate with the title centered and the voiceover as
  // audio. The lavfi colour source is infinite, so `durationMs` is what bounds
  // it: the narration's length when there is one, the caller's target when not.
  const safe = title.replace(/[\\:'"]/g, ' ').slice(0, 80);
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x0b0b10:s=1280x720:r=30',
    ...(audioPath ? ['-i', audioPath] : []),
    '-vf',
    `drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='${safe}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-t',
    (durationMs / 1000).toFixed(2),
    ...(audioPath ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    outputPath,
  ];
  try {
    await runFfmpeg(args);
  } catch (e) {
    // drawtext can fail if libfreetype isn't compiled into ffmpeg. Retry without text.
    const fallback = args.filter((a, i, arr) => !(a === '-vf' || (i > 0 && arr[i - 1] === '-vf')));
    await runFfmpeg(fallback);
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new FuserError(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function ffprobeDurationMs(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (c) => {
      out += c.toString();
    });
    proc.on('error', () => resolve(0));
    proc.on('exit', () => {
      const sec = Number(out.trim());
      resolve(Number.isFinite(sec) ? Math.round(sec * 1000) : 0);
    });
  });
}

async function safeStat(p: string): Promise<{ size: number } | null> {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

