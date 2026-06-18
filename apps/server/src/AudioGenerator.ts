import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AudioGenerationOptions {
  voiceId?: string;
  modelId?: string;
  outputFormat?: 'mp3_44100_128' | 'mp3_44100_192' | 'mp3_22050_32';
  outputDir: string;
}

export interface AudioGenerationResult {
  filePath: string;
  fileName: string;
  voiceId: string;
  modelId: string;
  bytes: number;
  durationEstimateMs: number;
}

export class AudioGeneratorError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AudioGeneratorError';
  }
}

const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

export class AudioGenerator {
  private readonly client: ElevenLabsClient;

  constructor(apiKey?: string) {
    if (!apiKey) {
      throw new AudioGeneratorError('ElevenLabs API key is required');
    }
    this.client = new ElevenLabsClient({ apiKey });
  }

  async generate(text: string, options: AudioGenerationOptions): Promise<AudioGenerationResult> {
    const voiceId = options.voiceId || process.env.VOICE_ID || DEFAULT_VOICE_ID;
    const modelId = options.modelId || DEFAULT_MODEL_ID;
    const outputFormat = options.outputFormat || 'mp3_44100_128';

    if (!text || !text.trim()) {
      throw new AudioGeneratorError('Cannot generate audio for empty text');
    }

    try {
      const audio = await this.client.textToSpeech.convert(voiceId, {
        text,
        modelId,
        outputFormat,
      });

      const buffer = await streamToBuffer(audio);
      await mkdir(options.outputDir, { recursive: true });
      const fileName = `${randomUUID()}.mp3`;
      const filePath = path.join(options.outputDir, fileName);
      await writeFile(filePath, buffer);

      return {
        filePath,
        fileName,
        voiceId,
        modelId,
        bytes: buffer.byteLength,
        durationEstimateMs: estimateDurationMs(text),
      };
    } catch (error) {
      throw new AudioGeneratorError(
        error instanceof Error ? `ElevenLabs TTS failed: ${error.message}` : 'ElevenLabs TTS failed',
        error,
      );
    }
  }
}

async function streamToBuffer(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];

  if (Symbol.asyncIterator in stream) {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
  } else {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function estimateDurationMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  // ~150 wpm spoken = 2.5 wps
  return Math.round((words / 2.5) * 1000);
}
