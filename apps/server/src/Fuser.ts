import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FuseInput {
  audioPath: string;
  videoPath?: string;
  outputDir: string;
  // Optional title text rendered onto the slate when no video is provided.
  slateTitle?: string;
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

    const audioStat = await safeStat(input.audioPath);
    if (!audioStat) throw new FuserError(`Audio file missing: ${input.audioPath}`);

    const fileName = `${randomUUID()}.mp4`;
    const filePath = path.join(input.outputDir, fileName);

    if (input.videoPath) {
      const videoStat = await safeStat(input.videoPath);
      if (!videoStat) throw new FuserError(`Video file missing: ${input.videoPath}`);
      await runMux(input.videoPath, input.audioPath, filePath);
      const out = await stat(filePath);
      return {
        filePath,
        fileName,
        durationMs: await ffprobeDurationMs(filePath),
        bytes: out.size,
        mode: 'mux',
      };
    }

    await runSlate(input.audioPath, filePath, input.slateTitle ?? 'Pitchbox demo');
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

async function runMux(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  // Re-encode audio to AAC (ffmpeg defaults), copy video stream. -shortest cuts at the
  // shorter of the two, which is usually correct for demo videos where the recording
  // and the voiceover are independently captured. Adjust if you want loop-video-on-long-vo.
  const args = [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    outputPath,
  ];
  await runFfmpeg(args);
}

async function runSlate(audioPath: string, outputPath: string, title: string): Promise<void> {
  // Render a 1280x720 dark slate with the title centered and the voiceover as audio.
  // Uses lavfi color source and drawtext. Duration is derived from the audio length.
  const safe = title.replace(/[\\:'"]/g, ' ').slice(0, 80);
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x0b0b10:s=1280x720:r=30',
    '-i',
    audioPath,
    '-vf',
    `drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='${safe}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
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

