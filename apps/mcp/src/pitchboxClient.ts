import { CLIENT_NAME, CLIENT_VERSION, type PitchboxConfig } from './config';

/**
 * Thin HTTP client for the Pitchbox REST API.
 *
 * Deliberately not a generated SDK: the surface is six endpoints, and hand-
 * writing it keeps the error messages in language a model can act on ("your key
 * is invalid, here is where to get a new one") rather than raw status codes.
 */

export class PitchboxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PitchboxApiError';
  }
}

export class PitchboxClient {
  constructor(private readonly config: PitchboxConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.serverBase}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
          // Labels this traffic as MCP in the server's usage data. Untrusted by
          // the server — it grants nothing.
          'x-pitchbox-client': CLIENT_NAME,
          'x-pitchbox-client-version': CLIENT_VERSION,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // Almost always a wrong PITCHBOX_SERVER_BASE or a server that is asleep.
      throw new PitchboxApiError(
        `Could not reach the Pitchbox server at ${this.config.serverBase}. Check PITCHBOX_SERVER_BASE is correct and the server is running. (${
          e instanceof Error ? e.message : String(e)
        })`,
        0,
      );
    }

    const text = await res.text();
    let parsed: any = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON body — fall through to the status-based message below.
    }

    if (!res.ok) {
      const code = parsed?.code as string | undefined;
      throw new PitchboxApiError(this.explain(res.status, code, parsed?.error), res.status, code);
    }
    return parsed as T;
  }

  /** Turn a status/code into something the caller can actually act on. */
  private explain(status: number, code?: string, serverMessage?: string): string {
    if (status === 401) {
      return 'Your Pitchbox API key was rejected. Generate a new one at <your web app>/settings/keys and update PITCHBOX_API_KEY.';
    }
    if (status === 429) {
      return serverMessage ?? 'Daily limit reached for sandbox recording. Try again tomorrow.';
    }
    if (code === 'ELEVENLABS_KEY_REQUIRED') {
      return 'No ElevenLabs key. Set ELEVENLABS_API_KEY in your MCP config (get one at https://elevenlabs.io).';
    }
    if (code === 'DAYTONA_UNAVAILABLE') {
      return 'Recording a GitHub repo is not available on this server. Record a deployed URL instead, or skip recording.';
    }
    return serverMessage ?? `Pitchbox server error (HTTP ${status}).`;
  }

  listProviders(): Promise<{
    providers: { id: string; label: string; free: boolean; keysUrl: string; models: { id: string; label: string }[] }[];
    hasServerDefault: boolean;
    hasServerAudio: boolean;
    hasSandboxRecording: boolean;
  }> {
    return this.request('GET', '/api/providers');
  }

  startPipeline(input: Record<string, unknown>): Promise<{ sessionId: string; status: string }> {
    return this.request('POST', '/api/pipeline/start', {
      ...input,
      // Credentials come from config, never from the model's tool arguments —
      // so a prompt-injected instruction cannot swap in someone else's key.
      llm: this.config.llm,
      elevenLabsApiKey: this.config.elevenLabsApiKey,
    });
  }

  status(sessionId: string): Promise<any> {
    return this.request('GET', `/api/pipeline/${encodeURIComponent(sessionId)}/status`);
  }

  feedback(sessionId: string, feedback: string): Promise<any> {
    return this.request('POST', `/api/pipeline/${encodeURIComponent(sessionId)}/feedback`, { feedback });
  }

  approve(sessionId: string, skipRecording: boolean): Promise<any> {
    return this.request('POST', `/api/pipeline/${encodeURIComponent(sessionId)}/approve`, { skipRecording });
  }

  result(sessionId: string): Promise<any> {
    return this.request('GET', `/api/pipeline/${encodeURIComponent(sessionId)}/result`);
  }

  /** Absolute URL for a server-relative media path, for showing the user. */
  absoluteUrl(pathOrUrl?: string): string | undefined {
    if (!pathOrUrl) return undefined;
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.config.serverBase}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  }
}
