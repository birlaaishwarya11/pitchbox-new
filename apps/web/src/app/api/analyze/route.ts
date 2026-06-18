import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_SERVER_URL = 'http://localhost:3001';
// Analysis clones the repo + runs Claude — give it plenty of headroom.
const UPSTREAM_TIMEOUT_MS = 5 * 60_000;

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).cause as { code?: string } | undefined;
  const inner = code?.code ?? (error as NodeJS.ErrnoException).code;
  return (
    inner === 'ECONNREFUSED' ||
    inner === 'ENOTFOUND' ||
    inner === 'UND_ERR_CONNECT_TIMEOUT' ||
    inner === 'UND_ERR_SOCKET' ||
    error.name === 'AbortError'
  );
}

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!body?.githubUrl) {
    return NextResponse.json({ error: 'GitHub URL is required' }, { status: 400 });
  }

  const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || DEFAULT_SERVER_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(`${serverUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({
      error: `Upstream returned ${response.status} with a non-JSON body`,
    }));

    if (!response.ok) {
      return NextResponse.json(
        { error: data.error || 'Analysis failed', code: data.code },
        { status: response.status },
      );
    }

    return NextResponse.json(data);
  } catch (error: any) {
    if (isConnectionError(error)) {
      return NextResponse.json(
        {
          error: `Backend server unreachable at ${serverUrl}. Start it with "npm run dev:server".`,
          code: 'BACKEND_UNAVAILABLE',
        },
        { status: 503 },
      );
    }

    console.error('Analyze proxy error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal server error' },
      { status: 500 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
