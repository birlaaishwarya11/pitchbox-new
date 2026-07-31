'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const SERVER_BASE = process.env.NEXT_PUBLIC_SERVER_BASE || 'http://localhost:3001';

// Lazily construct the browser Supabase client (only on first use, i.e. in the
// browser) so it never runs during server-side prerender.
let _supabase: ReturnType<typeof createClient> | null = null;
function sb() {
  return (_supabase ??= createClient());
}

/** fetch() with the Supabase access token attached; the server verifies it. */
async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

type Status = 'CREATED' | 'PLANNING' | 'RESEARCHING' | 'SCRIPT_DRAFT' | 'GENERATING' | 'FUSING' | 'READY' | 'ERROR';

type LlmCfg = { provider: string; apiKey: string; model: string };
type ProviderInfo = {
  id: string;
  label: string;
  free: boolean;
  keysUrl: string;
  models: { id: string; label: string; free?: boolean }[];
};

type StageId = 'analyze' | 'plan' | 'research' | 'script' | 'record' | 'voiceover' | 'fuse';
type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
type StageState = {
  id: StageId;
  label: string;
  status: StageStatus;
  message?: string;
  startedAt?: string;
  endedAt?: string;
};

// Mirrors the backend STAGE_DEFS (apps/server/src/pipelineStages.ts) for the
// pre-launch selection panel. Required stages always run; optional ones toggle.
const STAGE_META: {
  id: StageId;
  label: string;
  group: 'Analyze' | 'Script' | 'Generate';
  optional: boolean;
  hint: string;
}[] = [
  { id: 'analyze', label: 'Analyze project', group: 'Analyze', optional: true, hint: 'Clone + inspect the repo (needs a GitHub URL)' },
  { id: 'plan', label: 'Plan', group: 'Script', optional: false, hint: 'Decide the angle, audience, hook' },
  { id: 'research', label: 'Research', group: 'Script', optional: true, hint: 'Use-case dos & don’ts' },
  { id: 'script', label: 'Write script', group: 'Script', optional: false, hint: 'Draft the voiceover script' },
  { id: 'record', label: 'Screen recording', group: 'Generate', optional: true, hint: 'Capture a live/public URL' },
  { id: 'voiceover', label: 'Voiceover', group: 'Generate', optional: false, hint: 'ElevenLabs narration' },
  { id: 'fuse', label: 'Assemble video', group: 'Generate', optional: false, hint: 'Mux audio onto the capture/slate' },
];

type ScriptVersion = {
  id: string;
  versionNumber: number;
  createdAt: string;
  fullScript: string;
  estimatedDurationSec: number;
  wordCount: number;
  feedbackUsed?: string;
  parentVersionId?: string;
};

type Session = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: Status;
  input: { githubUrl?: string; branch?: string; recordUrl?: string; userPrompt: string; targetDurationSec: number };
  stages: StageState[];
  plan?: {
    audience: string;
    primaryGoal: string;
    toneAndStyle: string;
    targetDurationSec: number;
    mustCover: string[];
    avoid: string[];
    openingHook: string;
    closingMove: string;
    notes: string;
  };
  research?: {
    summary: string;
    dos: string[];
    donts: string[];
    examplesOrPatterns: string[];
    citations: { title: string; url: string }[];
  };
  scriptVersions: ScriptVersion[];
  approvedVersionId?: string;
  audio?: { url: string };
  video?: { url: string };
  finalVideo?: { url: string; fileName: string };
  error?: { stage: string; message: string };
};

export default function PipelinePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inputs
  const [userPrompt, setUserPrompt] = useState(SAMPLE_PROMPTS[0].value);
  const [githubUrl, setGithubUrl] = useState('');
  const [recordUrl, setRecordUrl] = useState('');
  const [appStartCommand, setAppStartCommand] = useState('');
  const [sandboxPort, setSandboxPort] = useState<number | ''>('');
  const [targetDurationSec, setTargetDurationSec] = useState(90);
  // Which optional stages to run. Required stages always run.
  const [selectedOptional, setSelectedOptional] = useState<Set<StageId>>(
    () => new Set<StageId>(['research', 'record']),
  );
  const recordSelected = selectedOptional.has('record');

  const toggleOptional = (id: StageId) =>
    setSelectedOptional((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const selectedStageIds = (): StageId[] => {
    const ids = STAGE_META.filter((s) => !s.optional).map((s) => s.id);
    return [...ids, ...selectedOptional];
  };

  // Signed-in user (for the header + sign out).
  const [userEmail, setUserEmail] = useState<string | null>(null);
  useEffect(() => {
    sb().auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null));
  }, []);
  const handleSignOut = async () => {
    await sb().auth.signOut();
    window.location.href = '/login';
  };

  // Bring-your-own LLM config (null = use the server default, if any).
  const [llm, setLlm] = useState<LlmCfg | null>(null);

  // Feedback box
  const [feedback, setFeedback] = useState('');
  const [iterating, setIterating] = useState(false);

  // Polling
  const pollHandle = useRef<NodeJS.Timeout | null>(null);

  const stopPolling = useCallback(() => {
    if (pollHandle.current) {
      clearInterval(pollHandle.current);
      pollHandle.current = null;
    }
  }, []);

  const refresh = useCallback(async (id: string) => {
    try {
      const r = await authFetch(`${SERVER_BASE}/api/pipeline/${id}/status`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSession(data);
      if (data.status === 'READY' || data.status === 'ERROR') stopPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      stopPolling();
    }
  }, [stopPolling]);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      pollHandle.current = setInterval(() => refresh(id), 1500);
    },
    [refresh, stopPolling],
  );

  useEffect(() => stopPolling, [stopPolling]);

  const handleStart = async () => {
    setError(null);
    setSession(null);
    try {
      const r = await authFetch(`${SERVER_BASE}/api/pipeline/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userPrompt,
          githubUrl: githubUrl.trim() || undefined,
          recordUrl: recordUrl.trim() || undefined,
          appStartCommand: appStartCommand.trim() || undefined,
          sandboxPort: typeof sandboxPort === 'number' ? sandboxPort : undefined,
          targetDurationSec,
          selectedStages: selectedStageIds(),
          skipRecording: !recordSelected,
          llm: llm ?? undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const id = data.sessionId as string;
      await refresh(id);
      startPolling(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleFeedback = async () => {
    if (!session || !feedback.trim()) return;
    setIterating(true);
    setError(null);
    try {
      const r = await authFetch(`${SERVER_BASE}/api/pipeline/${session.id}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      await refresh(session.id);
      setFeedback('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIterating(false);
    }
  };

  const handleApprove = async () => {
    if (!session) return;
    setError(null);
    try {
      const r = await authFetch(`${SERVER_BASE}/api/pipeline/${session.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skipRecording: !recordSelected }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSession(data);
      startPolling(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleReiterate = async () => {
    if (!session) return;
    setError(null);
    try {
      const r = await authFetch(`${SERVER_BASE}/api/pipeline/${session.id}/reiterate`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSession(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleReset = () => {
    stopPolling();
    setSession(null);
    setError(null);
    setFeedback('');
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-10">
      <div className="max-w-5xl mx-auto space-y-8">
        <header className="space-y-2">
          <div className="flex items-start justify-between gap-4">
            <p className="text-xs uppercase tracking-widest text-zinc-500">Pipeline</p>
            {userEmail && (
              <div className="flex items-center gap-3 text-xs text-zinc-400">
                <span className="hidden sm:inline">{userEmail}</span>
                <button onClick={handleSignOut} className="underline hover:text-white">
                  Sign out
                </button>
              </div>
            )}
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Pitchbox · demo video pipeline</h1>
          <p className="text-sm text-zinc-400 max-w-3xl">
            Plan → research → script → approval → audio + video → fusion. Session-only state, no persistence.
          </p>
        </header>

        {error && (
          <div className="rounded border border-red-900 bg-red-950/40 text-red-200 text-sm p-3 whitespace-pre-wrap">
            {error}
          </div>
        )}

        {!session && (
          <InputCard
            userPrompt={userPrompt}
            setUserPrompt={setUserPrompt}
            githubUrl={githubUrl}
            setGithubUrl={setGithubUrl}
            recordUrl={recordUrl}
            setRecordUrl={setRecordUrl}
            appStartCommand={appStartCommand}
            setAppStartCommand={setAppStartCommand}
            sandboxPort={sandboxPort}
            setSandboxPort={setSandboxPort}
            targetDurationSec={targetDurationSec}
            setTargetDurationSec={setTargetDurationSec}
            selectedOptional={selectedOptional}
            toggleOptional={toggleOptional}
            onLlmChange={setLlm}
            onStart={handleStart}
          />
        )}

        {session && <AgentBoard stages={session.stages} status={session.status} />}

        {session && session.status !== 'READY' && session.status !== 'SCRIPT_DRAFT' && session.status !== 'ERROR' && (
          <PreparingCard session={session} />
        )}

        {session && session.status === 'SCRIPT_DRAFT' && (
          <ScriptReviewCard
            session={session}
            feedback={feedback}
            setFeedback={setFeedback}
            iterating={iterating}
            onFeedback={handleFeedback}
            onApprove={handleApprove}
            recordSelected={recordSelected}
            toggleRecord={() => toggleOptional('record')}
          />
        )}

        {session && session.status === 'READY' && (
          <ResultCard session={session} onReiterate={handleReiterate} onReset={handleReset} />
        )}

        {session && session.status === 'ERROR' && (
          <div className="rounded-xl border border-red-900 bg-red-950/30 p-5 space-y-2">
            <h2 className="text-lg font-semibold text-red-200">Pipeline error</h2>
            <p className="text-sm text-red-300">
              <span className="text-red-500">stage:</span> {session.error?.stage}
            </p>
            <pre className="text-xs whitespace-pre-wrap">{session.error?.message}</pre>
            <button onClick={handleReset} className="text-xs underline text-zinc-300 hover:text-white">
              start over
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

const SAMPLE_PROMPTS = [
  {
    label: 'Hackathon submission',
    value:
      'This is for a hackathon submission. Project is "Pitchbox" — generates auto-narrated demo videos from a GitHub URL. Judges skim 50+ projects back-to-back, so hook in the first 5 seconds, focus on the magic moment (paste URL → finished video), under 90 seconds total.',
  },
  {
    label: 'Marketing landing-page hero',
    value:
      'Marketing voiceover for the Pitchbox landing page. Audience: founders and DevRel teams. Emphasise speed (minutes, not days) and that no editing skills are needed. Confident but not bro-y. ~60 seconds.',
  },
  {
    label: 'LinkedIn launch',
    value:
      'LinkedIn launch post for Pitchbox. Punchy, first-person, ends with a "what would you point this at?" prompt. Under 45 seconds.',
  },
];

function InputCard(props: {
  userPrompt: string;
  setUserPrompt: (v: string) => void;
  githubUrl: string;
  setGithubUrl: (v: string) => void;
  recordUrl: string;
  setRecordUrl: (v: string) => void;
  appStartCommand: string;
  setAppStartCommand: (v: string) => void;
  sandboxPort: number | '';
  setSandboxPort: (v: number | '') => void;
  targetDurationSec: number;
  setTargetDurationSec: (v: number) => void;
  selectedOptional: Set<StageId>;
  toggleOptional: (id: StageId) => void;
  onLlmChange: (llm: LlmCfg | null) => void;
  onStart: () => void;
}) {
  const analyzeOn = props.selectedOptional.has('analyze');
  const recordOn = props.selectedOptional.has('record');
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Tell us what you want</h2>
        <p className="text-xs text-zinc-500">Free-form purpose, focus areas, special instructions — be specific.</p>
      </div>

      <div className="flex gap-1 flex-wrap">
        {SAMPLE_PROMPTS.map((p) => (
          <button
            key={p.label}
            onClick={() => props.setUserPrompt(p.value)}
            className="text-[10px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          >
            {p.label}
          </button>
        ))}
      </div>

      <textarea
        value={props.userPrompt}
        onChange={(e) => props.setUserPrompt(e.target.value)}
        rows={6}
        placeholder="What's this video for? Who's watching? What should we emphasise? What should we avoid?"
        className="w-full rounded bg-zinc-950 border border-zinc-800 p-2 text-sm focus:border-zinc-600 outline-none"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">Public URL to record {recordOn ? '' : '(recording off)'}</label>
          <input
            value={props.recordUrl}
            onChange={(e) => props.setRecordUrl(e.target.value)}
            placeholder="https://your-app.vercel.app"
            className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm font-mono disabled:opacity-40"
            disabled={!recordOn}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">Target seconds</label>
          <input
            type="number"
            min={20}
            max={300}
            value={props.targetDurationSec}
            onChange={(e) => props.setTargetDurationSec(Number(e.target.value))}
            className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-zinc-400">
          GitHub URL {analyzeOn && recordOn ? '(Analyze + sandbox recording)' : analyzeOn ? '(used by Analyze)' : recordOn ? '(sandbox recording)' : '(optional)'}
        </label>
        <input
          value={props.githubUrl}
          onChange={(e) => props.setGithubUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm font-mono"
        />
        {recordOn && props.githubUrl.trim() && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <input
              value={props.appStartCommand}
              onChange={(e) => props.setAppStartCommand(e.target.value)}
              placeholder="start command (default: npm run dev)"
              className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-xs font-mono"
            />
            <input
              type="number"
              value={props.sandboxPort}
              onChange={(e) => props.setSandboxPort(e.target.value ? Number(e.target.value) : '')}
              placeholder="port (default: 3000)"
              className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-xs"
            />
            <p className="text-[10px] text-zinc-500 sm:col-span-2">
              The repo is built &amp; run inside an isolated Daytona sandbox, then recorded. Set the dev command + port your app listens on.
            </p>
          </div>
        )}
      </div>

      {/* Model provider (bring your own key). */}
      <ProviderConfig onChange={props.onLlmChange} />

      {/* Stage-selection panel: pick which agents run before launch. */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 space-y-2">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Stages to run</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {STAGE_META.map((s) => {
            const on = !s.optional || props.selectedOptional.has(s.id);
            return (
              <label
                key={s.id}
                className={`flex items-start gap-2 rounded border p-2 text-xs ${
                  on ? 'border-zinc-700 bg-zinc-900/60' : 'border-zinc-800 bg-transparent opacity-60'
                } ${s.optional ? 'cursor-pointer' : 'cursor-default'}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!s.optional}
                  onChange={() => s.optional && props.toggleOptional(s.id)}
                  className="mt-0.5"
                />
                <span>
                  <span className="text-zinc-200 font-medium">{s.label}</span>
                  {!s.optional && <span className="ml-1 text-[10px] text-zinc-500">required</span>}
                  <span className="block text-[10px] text-zinc-500">{s.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {recordOn && !props.recordUrl.trim() && (
          <p className="text-[11px] text-amber-400">Screen recording is on but no URL set — it’ll fall back to a slate.</p>
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={props.onStart}
          disabled={!props.userPrompt.trim()}
          className="rounded bg-zinc-100 text-zinc-950 text-sm font-medium px-4 py-1.5 hover:bg-white disabled:opacity-40"
        >
          Start pipeline
        </button>
      </div>
    </section>
  );
}

const CUSTOM_MODEL = '__custom__';

function ProviderConfig({ onChange }: { onChange: (llm: LlmCfg | null) => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [hasServerDefault, setHasServerDefault] = useState(false);
  const [providerId, setProviderId] = useState('anthropic');
  const [modelChoice, setModelChoice] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }>({ state: 'idle' });

  const provider = providers.find((p) => p.id === providerId);
  const model = modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice;

  useEffect(() => {
    fetch(`${SERVER_BASE}/api/providers`)
      .then((r) => r.json())
      .then((d) => {
        setProviders(d.providers ?? []);
        setHasServerDefault(!!d.hasServerDefault);
        const first = (d.providers ?? [])[0];
        if (first) {
          setProviderId(first.id);
          setModelChoice(first.models[0]?.id ?? CUSTOM_MODEL);
        }
      })
      .catch(() => undefined);
  }, []);

  // Report the resolved config up: a complete BYO config, or null (server default).
  useEffect(() => {
    if (apiKey.trim() && model && providerId) {
      onChange({ provider: providerId, apiKey: apiKey.trim(), model });
    } else {
      onChange(null);
    }
    setTest({ state: 'idle' });
  }, [providerId, model, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPickProvider = (id: string) => {
    setProviderId(id);
    const p = providers.find((x) => x.id === id);
    setModelChoice(p?.models[0]?.id ?? CUSTOM_MODEL);
    setCustomModel('');
  };

  const runTest = async () => {
    if (!apiKey.trim() || !model) return;
    setTest({ state: 'testing' });
    try {
      const r = await fetch(`${SERVER_BASE}/api/validate-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: providerId, apiKey: apiKey.trim(), model }),
      });
      const d = await r.json();
      setTest(d.ok ? { state: 'ok' } : { state: 'fail', message: d.message || 'Validation failed' });
    } catch (e) {
      setTest({ state: 'fail', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Model provider</p>
        {hasServerDefault && (
          <span className="text-[10px] text-zinc-500">leave key blank to use the server default</span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">Provider</label>
          <select
            value={providerId}
            onChange={(e) => onPickProvider(e.target.value)}
            className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.free ? ' — free' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">Model</label>
          <select
            value={modelChoice}
            onChange={(e) => setModelChoice(e.target.value)}
            className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm"
          >
            {(provider?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.free ? ' (free)' : ''}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>Other (enter exact model name)…</option>
          </select>
        </div>
      </div>

      {modelChoice === CUSTOM_MODEL && (
        <input
          value={customModel}
          onChange={(e) => setCustomModel(e.target.value)}
          placeholder="exact-model-name (must match the provider's API)"
          className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm font-mono"
        />
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs text-zinc-400">API key</label>
          {provider && (
            <a href={provider.keysUrl} target="_blank" rel="noreferrer" className="text-[10px] text-indigo-400 underline">
              get a key ↗
            </a>
          )}
        </div>
        <div className="flex gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasServerDefault ? 'optional — uses server default if blank' : 'paste your API key'}
            className="flex-1 rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => setShowKey((s) => !s)}
            className="rounded border border-zinc-800 text-zinc-400 text-xs px-2 hover:text-zinc-200"
          >
            {showKey ? 'hide' : 'show'}
          </button>
          <button
            type="button"
            onClick={runTest}
            disabled={!apiKey.trim() || !model || test.state === 'testing'}
            className="rounded border border-zinc-700 text-zinc-200 text-xs px-3 hover:border-zinc-500 disabled:opacity-40"
          >
            {test.state === 'testing' ? 'Testing…' : 'Test key'}
          </button>
        </div>
        {test.state === 'ok' && <p className="text-[11px] text-emerald-400">✓ Key and model are valid.</p>}
        {test.state === 'fail' && <p className="text-[11px] text-rose-400">✗ {test.message}</p>}
        {!apiKey.trim() && !hasServerDefault && (
          <p className="text-[11px] text-amber-400">No server default — a key is required to run.</p>
        )}
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<StageStatus, { dot: string; border: string; text: string; label: string }> = {
  pending: { dot: 'bg-zinc-600', border: 'border-zinc-800', text: 'text-zinc-400', label: 'Pending' },
  running: { dot: 'bg-amber-400 animate-pulse', border: 'border-amber-600/70', text: 'text-amber-200', label: 'Running' },
  done: { dot: 'bg-emerald-400', border: 'border-emerald-700/70', text: 'text-emerald-200', label: 'Done' },
  failed: { dot: 'bg-rose-500', border: 'border-rose-700/70', text: 'text-rose-200', label: 'Failed' },
  skipped: { dot: 'bg-zinc-700', border: 'border-zinc-800', text: 'text-zinc-600', label: 'Skipped' },
};

const GROUPS: { key: 'Analyze' | 'Script' | 'Generate'; title: string }[] = [
  { key: 'Analyze', title: '1 · Analyze project' },
  { key: 'Script', title: '2 · Script generation' },
  { key: 'Generate', title: '3 · Generate video' },
];

function elapsed(s: StageState): string | null {
  if (!s.startedAt) return null;
  const end = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
  const ms = end - new Date(s.startedAt).getTime();
  if (ms < 0) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function AgentBoard({ stages, status }: { stages: StageState[]; status: Status }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Agents</h2>
        <span className="text-[11px] text-zinc-500">
          {status === 'READY' ? 'complete' : status === 'ERROR' ? 'stopped' : 'live · polling 1.5s'}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {GROUPS.map((g) => {
          const groupStages = stages.filter((st) => STAGE_META.find((m) => m.id === st.id)?.group === g.key);
          if (groupStages.length === 0) return null;
          return (
            <div key={g.key} className="space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-zinc-500">{g.title}</p>
              <div className="space-y-2">
                {groupStages.map((st) => (
                  <StageCard key={st.id} stage={st} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StageCard({ stage }: { stage: StageState }) {
  const s = STATUS_STYLE[stage.status];
  const t = elapsed(stage);
  return (
    <div className={`rounded-lg border ${s.border} bg-zinc-950/60 p-3`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} />
        <span className="text-sm text-zinc-200 font-medium">{stage.label}</span>
        <span className={`ml-auto text-[10px] ${s.text}`}>{s.label}</span>
      </div>
      {stage.message && (
        <p className="mt-1 text-[11px] text-zinc-400 break-words line-clamp-2">{stage.message}</p>
      )}
      {t && stage.status !== 'pending' && stage.status !== 'skipped' && (
        <p className="mt-1 text-[10px] text-zinc-600">{t}</p>
      )}
    </div>
  );
}

function PreparingCard({ session }: { session: Session }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
      <h2 className="text-lg font-semibold">Working…</h2>
      <p className="text-sm text-zinc-400">
        {LABEL[session.status] ?? session.status}. Polling every 1.5s.
      </p>
      {session.plan && (
        <details className="text-xs text-zinc-500" open>
          <summary className="cursor-pointer">Plan</summary>
          <PlanView plan={session.plan} />
        </details>
      )}
      {session.research && (
        <details className="text-xs text-zinc-500" open>
          <summary className="cursor-pointer">Research</summary>
          <ResearchView research={session.research} />
        </details>
      )}
    </section>
  );
}

const LABEL: Partial<Record<Status, string>> = {
  CREATED: 'Booting',
  PLANNING: 'Planning the demo angle',
  RESEARCHING: 'Researching use-case patterns',
  GENERATING: 'Generating audio + (optional) recording',
  FUSING: 'Fusing audio onto video',
};

function PlanView({ plan }: { plan: NonNullable<Session['plan']> }) {
  return (
    <ul className="space-y-1 text-xs text-zinc-400 mt-2">
      <li><b className="text-zinc-300">Audience:</b> {plan.audience}</li>
      <li><b className="text-zinc-300">Goal:</b> {plan.primaryGoal}</li>
      <li><b className="text-zinc-300">Tone:</b> {plan.toneAndStyle}</li>
      <li><b className="text-zinc-300">Length:</b> ~{plan.targetDurationSec}s</li>
      <li><b className="text-zinc-300">Must cover:</b> {plan.mustCover.join(' · ')}</li>
      <li><b className="text-zinc-300">Avoid:</b> {plan.avoid.join(' · ')}</li>
      <li><b className="text-zinc-300">Hook:</b> {plan.openingHook}</li>
      <li><b className="text-zinc-300">Close:</b> {plan.closingMove}</li>
    </ul>
  );
}

function ResearchView({ research }: { research: NonNullable<Session['research']> }) {
  return (
    <div className="space-y-1.5 mt-2 text-xs text-zinc-400">
      <p>{research.summary}</p>
      {research.dos.length > 0 && (
        <p><b className="text-emerald-300">DO:</b> {research.dos.join(' · ')}</p>
      )}
      {research.donts.length > 0 && (
        <p><b className="text-rose-300">DON&apos;T:</b> {research.donts.join(' · ')}</p>
      )}
      {research.citations.length > 0 && (
        <p>
          <b className="text-zinc-300">Sources:</b>{' '}
          {research.citations.map((c, i) => (
            <a key={i} href={c.url} target="_blank" rel="noreferrer" className="underline mr-2">
              {c.title || c.url}
            </a>
          ))}
        </p>
      )}
    </div>
  );
}

function ScriptReviewCard(props: {
  session: Session;
  feedback: string;
  setFeedback: (v: string) => void;
  iterating: boolean;
  onFeedback: () => void;
  onApprove: () => void;
  recordSelected: boolean;
  toggleRecord: () => void;
}) {
  const latest = props.session.scriptVersions[props.session.scriptVersions.length - 1];
  if (!latest) return null;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Review the script</h2>
        <span className="text-[11px] text-zinc-500">
          v{latest.versionNumber} · {latest.wordCount} words · ~{latest.estimatedDurationSec}s
        </span>
      </div>

      {props.session.plan && (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">Plan + research used</summary>
          <PlanView plan={props.session.plan} />
          {props.session.research && <ResearchView research={props.session.research} />}
        </details>
      )}

      <pre className="rounded bg-zinc-950 border border-zinc-800 p-3 text-sm whitespace-pre-wrap font-sans leading-relaxed">
        {latest.fullScript}
      </pre>

      {props.session.scriptVersions.length > 1 && (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">Previous versions ({props.session.scriptVersions.length - 1})</summary>
          <div className="space-y-3 mt-2">
            {props.session.scriptVersions.slice(0, -1).reverse().map((v) => (
              <div key={v.id} className="rounded border border-zinc-800 p-2">
                <div className="text-[10px] text-zinc-500 mb-1">
                  v{v.versionNumber} · {v.wordCount} words
                  {v.feedbackUsed && <> · feedback: &quot;{v.feedbackUsed}&quot;</>}
                </div>
                <pre className="text-[11px] whitespace-pre-wrap font-sans">{v.fullScript}</pre>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="space-y-2">
        <label className="text-xs text-zinc-400">Suggest changes (or approve below)</label>
        <textarea
          value={props.feedback}
          onChange={(e) => props.setFeedback(e.target.value)}
          rows={3}
          placeholder='e.g. "tighten the opening", "drop the deployment line", "more first-person"'
          className="w-full rounded bg-zinc-950 border border-zinc-800 p-2 text-sm focus:border-zinc-600 outline-none"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={props.onFeedback}
            disabled={!props.feedback.trim() || props.iterating}
            className="rounded border border-zinc-700 text-zinc-200 text-sm px-3 py-1.5 hover:border-zinc-500 disabled:opacity-40"
          >
            {props.iterating ? 'Revising…' : 'Send feedback → revise'}
          </button>
          <label className="flex items-center gap-2 text-xs text-zinc-400 ml-auto">
            <input type="checkbox" checked={props.recordSelected} onChange={props.toggleRecord} />
            screen recording
          </label>
          <button
            onClick={props.onApprove}
            className="rounded bg-emerald-500 text-zinc-950 text-sm font-medium px-4 py-1.5 hover:bg-emerald-400"
          >
            Approve & generate
          </button>
        </div>
      </div>
    </section>
  );
}

function ResultCard({ session, onReiterate, onReset }: { session: Session; onReiterate: () => void; onReset: () => void }) {
  const final = session.finalVideo;
  if (!final) return null;
  const url = `${SERVER_BASE}${final.url}`;
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Your demo is ready</h2>
        <span className="text-[11px] text-zinc-500">{final.fileName}</span>
      </div>
      <video controls src={url} className="w-full rounded border border-zinc-800 bg-black" />
      <div className="flex flex-wrap gap-2">
        <a
          href={url}
          download={final.fileName}
          className="rounded bg-zinc-100 text-zinc-950 text-sm font-medium px-3 py-1.5 hover:bg-white"
        >
          Download mp4
        </a>
        <button
          onClick={onReiterate}
          className="rounded border border-zinc-700 text-zinc-200 text-sm px-3 py-1.5 hover:border-zinc-500"
        >
          Reiterate (back to script)
        </button>
        <button
          onClick={onReset}
          className="rounded border border-zinc-800 text-zinc-400 text-sm px-3 py-1.5 hover:text-zinc-200"
        >
          Start over (new session)
        </button>
      </div>
      {session.audio && (
        <div className="text-xs text-zinc-500">
          Audio track:{' '}
          <a href={`${SERVER_BASE}${session.audio.url}`} className="underline">
            download mp3
          </a>
        </div>
      )}
    </section>
  );
}
