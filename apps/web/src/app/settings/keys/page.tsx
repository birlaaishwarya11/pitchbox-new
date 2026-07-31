'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const SERVER_BASE = process.env.NEXT_PUBLIC_SERVER_BASE || 'http://localhost:3001';

let _supabase: ReturnType<typeof createClient> | null = null;
function sb() {
  return (_supabase ??= createClient());
}

/**
 * These routes reject API keys by design (a key must not mint more keys), so
 * this page always authenticates with the browser session token.
 */
async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await sb().auth.getSession();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (data.session?.access_token) headers.set('Authorization', `Bearer ${data.session.access_token}`);
  return fetch(`${SERVER_BASE}${path}`, { ...init, headers });
}

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  // Held in memory only — the server cannot show it again.
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/keys');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setKeys((await res.json()).keys ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await authFetch('/api/keys', { method: 'POST', body: JSON.stringify({ name: name.trim() || undefined }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setFreshKey(body.key);
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this key? Anything using it stops working immediately.')) return;
    try {
      const res = await authFetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-zinc-200">
      <h1 className="text-2xl font-semibold text-white">API keys</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Use Pitchbox from Claude Code or Claude Desktop instead of this UI. MCP clients start from a config file and
        cannot sign in through a browser, so they authenticate with one of these keys.
      </p>

      {/* Shown once, immediately after creation. */}
      {freshKey && (
        <div className="mt-6 rounded-lg border border-emerald-700/60 bg-emerald-950/40 p-4">
          <p className="text-sm font-medium text-emerald-300">Copy this key now — it will not be shown again.</p>
          <p className="mt-1 text-xs text-emerald-200/70">
            Only a hash is stored, so we genuinely cannot recover it. Lose it and you revoke it and make another.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-black/50 px-3 py-2 font-mono text-xs text-emerald-100">
              {freshKey}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(freshKey);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="shrink-0 rounded bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button onClick={() => setFreshKey(null)} className="mt-3 text-xs text-emerald-300/70 underline">
            I&apos;ve saved it — dismiss
          </button>
        </div>
      )}

      <div className="mt-8 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name (e.g. laptop, work desktop)"
          className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
        />
        <button
          onClick={() => void create()}
          disabled={creating}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </div>

      {error && <p className="mt-4 rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}

      <div className="mt-8">
        {loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-zinc-500">No keys yet. Create one to use Pitchbox from an MCP client.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-200">
                    {k.name}
                    {k.revoked_at && <span className="ml-2 text-xs text-red-400">revoked</span>}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-zinc-500">{k.prefix}…</p>
                  <p className="mt-0.5 text-xs text-zinc-600">
                    Created {new Date(k.created_at).toLocaleDateString()}
                    {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}` : ' · never used'}
                  </p>
                </div>
                {!k.revoked_at && (
                  <button
                    onClick={() => void revoke(k.id)}
                    className="shrink-0 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-red-700 hover:text-red-300"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-10 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-400">
        <p className="font-medium text-zinc-300">Setting up the MCP server</p>
        <p className="mt-2">
          Full instructions are in <code className="text-zinc-300">skills/pitchbox/INSTALL.md</code>. You will also need
          your own LLM and ElevenLabs keys — Pitchbox never bills its own.
        </p>
      </div>
    </main>
  );
}
