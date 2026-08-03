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

type Status = 'CREATED' | 'PLANNING' | 'RESEARCHING' | 'SCRIPT_DRAFT' | 'AWAITING_LOGIN' | 'FLOW_REVIEW' | 'GENERATING' | 'FUSING' | 'READY' | 'ERROR';

type LlmCfg = { provider: string; apiKey: string; model: string };
type ProviderInfo = {
  id: string;
  label: string;
  free: boolean;
  keysUrl: string;
  models: { id: string; label: string; free?: boolean }[];
};

type StageId = 'analyze' | 'plan' | 'research' | 'script' | 'login' | 'flow' | 'record' | 'voiceover' | 'fuse';
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

type FlowPlanVersion = {
  id: string;
  versionNumber: number;
  createdAt: string;
  text: string;
  feedbackUsed?: string;
  editedByUser?: boolean;
  parentVersionId?: string;
};

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
  flowPlanVersions: FlowPlanVersion[];
  approvedFlowPlanId?: string;
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
  // Pasted as .env text, sent as-is; the server parses and bounds it.
  const [appEnv, setAppEnv] = useState('');
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
  // Bring-your-own ElevenLabs key. Kept in component state only, never written
  // to localStorage — same treatment as the LLM key.
  const [elevenLabsKey, setElevenLabsKey] = useState('');

  // Feedback box
  const [feedback, setFeedback] = useState('');
  const [iterating, setIterating] = useState(false);
  // The flow plan is edited in place, so the textarea holds a draft that starts
  // from the latest version and is only sent when the user acts on it.
  const [flowDraft, setFlowDraft] = useState('');
  const [flowFeedback, setFlowFeedback] = useState('');
  const [flowBusy, setFlowBusy] = useState(false);
  const flowDirty = useRef(false);
  const [loginViewer, setLoginViewer] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

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
          appEnv: appEnv.trim() || undefined,
          targetDurationSec,
          selectedStages: selectedStageIds(),
          skipRecording: !recordSelected,
          llm: llm ?? undefined,
          elevenLabsApiKey: elevenLabsKey.trim() || undefined,
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

  // The draft follows the newest version unless the user has started typing over
  // it — losing someone's edits because a poll landed would be unforgivable.
  const latestFlow = session?.flowPlanVersions?.[session.flowPlanVersions.length - 1];
  useEffect(() => {
    if (latestFlow && !flowDirty.current) setFlowDraft(latestFlow.text);
  }, [latestFlow?.id]);

  const flowPost = async (body: Record<string, unknown>) => {
    if (!session) return;
    setError(null);
    setFlowBusy(true);
    try {
      const r = await authFetch(`${SERVER_BASE}/api/pipeline/${session.id}/flow`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      flowDirty.current = false;
      setFlowDraft(data.version.text);
      if (data.session) setSession(data.session);
      setFlowFeedback('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFlowBusy(false);
    }
  };

  const handleFlowRevise = () => flowPost({ feedback: flowFeedback });
  const handleFlowSaveEdits = () => flowPost({ text: flowDraft });

  const handleFlowApprove = async () => {
    if (!session) return;
    setError(null);
    setFlowBusy(true);
    try {
      // Any unsaved edits are the intent, so they are committed before approving
      // rather than silently discarded.
      if (flowDirty.current && flowDraft.trim() && flowDraft !== latestFlow?.text) {
        await flowPost({ text: flowDraft });
      }
      const r = await authFetch(`${SERVER_BASE}/api/pipeline/${session.id}/flow/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skipRecording: !recordSelected }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSession(data.session ?? data);
      startPolling(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFlowBusy(false);
    }
  };

  // Ask for a browser to sign into as soon as the run parks for it, so the user
  // is not left looking at a spinner wondering what it wants.
  useEffect(() => {
    if (session?.status !== 'AWAITING_LOGIN' || loginViewer || loginBusy) return;
    let cancelled = false;
    (async () => {
      setLoginBusy(true);
      try {
        const r = await authFetch(`${SERVER_BASE}/api/pipeline/${session.id}/login/start`, { method: 'POST' });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        // The server may return an absolute URL, because the viewer's websocket
        // cannot go through the /api proxy and must reach the API origin directly.
        const viewer: string = data.viewerUrl ?? '';
        if (!cancelled) setLoginViewer(/^https?:\/\//.test(viewer) ? viewer : `${SERVER_BASE}${viewer}`);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoginBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.status, session?.id]);

  const loginPost = async (action: 'confirm' | 'cancel') => {
    if (!session) return;
    setError(null);
    setLoginBusy(true);
    try {
      const r = await authFetch(`${SERVER_BASE}/api/pipeline/${session.id}/login/${action}`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLoginViewer(null);
      setSession(data);
      startPolling(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(false);
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
            appEnv={appEnv}
            setAppEnv={setAppEnv}
            setSandboxPort={setSandboxPort}
            targetDurationSec={targetDurationSec}
            setTargetDurationSec={setTargetDurationSec}
            selectedOptional={selectedOptional}
            toggleOptional={toggleOptional}
            onLlmChange={setLlm}
            elevenLabsKey={elevenLabsKey}
            setElevenLabsKey={setElevenLabsKey}
            onStart={handleStart}
          />
        )}

        {session && <AgentBoard stages={session.stages} status={session.status} />}

        {session &&
          session.status !== 'READY' &&
          session.status !== 'SCRIPT_DRAFT' &&
          session.status !== 'AWAITING_LOGIN' &&
          session.status !== 'FLOW_REVIEW' &&
          session.status !== 'ERROR' && <PreparingCard session={session} />}

        {session && session.status === 'AWAITING_LOGIN' && (
          <LoginGateCard
            session={session}
            viewerUrl={loginViewer}
            busy={loginBusy}
            onConfirm={() => loginPost('confirm')}
            onSkip={() => loginPost('cancel')}
          />
        )}

        {session && session.status === 'FLOW_REVIEW' && (
          <FlowReviewCard
            session={session}
            draft={flowDraft}
            setDraft={(v) => {
              flowDirty.current = true;
              setFlowDraft(v);
            }}
            feedback={flowFeedback}
            setFeedback={setFlowFeedback}
            busy={flowBusy}
            onRevise={handleFlowRevise}
            onSaveEdits={handleFlowSaveEdits}
            onApprove={handleFlowApprove}
          />
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
  appEnv: string;
  setAppEnv: (v: string) => void;
  setSandboxPort: (v: number | '') => void;
  targetDurationSec: number;
  setTargetDurationSec: (v: number) => void;
  selectedOptional: Set<StageId>;
  toggleOptional: (id: StageId) => void;
  onLlmChange: (llm: LlmCfg | null) => void;
  elevenLabsKey: string;
  setElevenLabsKey: (v: string) => void;
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
            <div className="sm:col-span-2 space-y-1.5">
              <label className="text-xs text-zinc-400">Environment variables (optional)</label>
              <textarea
                value={props.appEnv}
                onChange={(e) => props.setAppEnv(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder={'DATABASE_URL=postgres://…\nNEXT_PUBLIC_API_URL=https://…'}
                className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-xs font-mono"
              />
              <p className="text-[10px] text-zinc-500">
                Paste your <span className="font-mono">.env</span> — most projects will not boot without one, and an app
                that never starts cannot be recorded. Written to{' '}
                <span className="font-mono">.env.local</span> in the sandbox and passed to the build and start commands.
                Sent per-run, never stored, never logged, and never shown in a response. Max 40 variables, 16&nbsp;KB
                total. <span className="font-mono">PORT</span> and <span className="font-mono">HOST</span> are set for
                you.
              </p>
            </div>
            <p className="text-[10px] text-zinc-500 sm:col-span-2">
              The repo is built &amp; run inside an isolated Daytona sandbox, then recorded. Set the dev command + port your app listens on.
            </p>
          </div>
        )}
      </div>

      {/* Model provider (bring your own key). */}
      <ProviderConfig onChange={props.onLlmChange} />

      {/* Voiceover key (bring your own). Sent per-run and never stored. */}
      <VoiceConfig value={props.elevenLabsKey} onChange={props.setElevenLabsKey} />

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

/**
 * Bring-your-own ElevenLabs key for the voiceover.
 *
 * Held in React state and sent with the run — deliberately never persisted to
 * localStorage, matching how the LLM key is handled: a key in localStorage
 * outlives the session and is readable by any script on the page.
 */
function VoiceConfig({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [hasServerAudio, setHasServerAudio] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`${SERVER_BASE}/api/providers`)
      .then((r) => r.json())
      .then((d) => setHasServerAudio(!!d.hasServerAudio))
      .catch(() => setHasServerAudio(false));
  }, []);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Voiceover key</p>
        <a
          href="https://elevenlabs.io"
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-indigo-400 underline"
        >
          Get an ElevenLabs key
        </a>
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="ElevenLabs API key"
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600"
      />
      {hasServerAudio === false && !value.trim() && (
        <p className="text-[11px] text-amber-400">
          Required — this server has no voice key of its own, so the run will fail without yours.
        </p>
      )}
      <p className="text-[10px] text-zinc-600">Used for this run only. Never stored, never logged.</p>
    </div>
  );
}

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

/**
 * The walkthrough review gate.
 *
 * Shows what Pitchbox worked out the product is for and exactly what it intends
 * to do on camera — including every value it will type — in a box the user can
 * rewrite. Nothing is recorded until they confirm, because the alternative is
 * finding out what the demo did after the video exists.
 */
/**
 * The sign-in gate.
 *
 * A real browser, running on the server, embedded here for the user to drive.
 * They sign in however the site asks — password, OAuth, SSO, a code from their
 * phone — and Pitchbox never sees a credential. The browser they use is the one
 * that then gets explored and filmed, so whatever they reach is what the demo
 * shows.
 */
function LoginGateCard(props: {
  session: Session;
  viewerUrl: string | null;
  busy: boolean;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const stage = props.session.stages.find((s) => s.id === 'login');
  const failed = stage?.status === 'failed';

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <h2 className="text-sm font-medium">Sign in to the site being recorded</h2>
      <p className="text-[11px] text-zinc-500">
        This is a real browser running on the server. Sign in however the site asks — password, Google,
        SSO, a code from your phone. Pitchbox never sees your credentials. Whatever you reach here is
        what gets explored and recorded.
      </p>

      {failed && (
        <p className="text-xs text-amber-400">
          Could not open a browser ({stage?.message}). Continue without signing in and the demo will
          cover whatever is reachable publicly.
        </p>
      )}

      {props.viewerUrl ? (
        <iframe
          src={props.viewerUrl}
          title="Sign in to the site being recorded"
          className="w-full rounded border border-zinc-800 bg-black"
          style={{ height: 460 }}
          // The frame drives a browser holding the user's session; nothing in it
          // needs access to this page.
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      ) : (
        !failed && <p className="text-xs text-zinc-400">Opening a browser for you…</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={props.onSkip}
          disabled={props.busy}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900 disabled:opacity-50"
        >
          Continue without signing in
        </button>
        <button
          onClick={props.onConfirm}
          disabled={props.busy || (!props.viewerUrl && !failed)}
          className="ml-auto rounded bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {props.busy ? 'Working…' : "I'm signed in"}
        </button>
      </div>
    </section>
  );
}

function FlowReviewCard(props: {
  session: Session;
  draft: string;
  setDraft: (v: string) => void;
  feedback: string;
  setFeedback: (v: string) => void;
  busy: boolean;
  onRevise: () => void;
  onSaveEdits: () => void;
  onApprove: () => void;
}) {
  const versions = props.session.flowPlanVersions ?? [];
  const latest = versions[versions.length - 1];
  const flowStage = props.session.stages.find((s) => s.id === 'flow');
  const planning = !latest && flowStage?.status === 'running';

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-medium">Review the walkthrough</h2>
        {latest && (
          <span className="text-[11px] text-zinc-500">
            v{latest.versionNumber}
            {latest.editedByUser ? ' · your edits' : ''}
          </span>
        )}
      </div>

      <p className="text-[11px] text-zinc-500">
        This is what Pitchbox will actually do on screen, and everything it will type. Edit it directly,
        or describe what you want changed — then approve to record.
      </p>

      {planning && <p className="text-xs text-zinc-400">Exploring the product and working out the flow…</p>}

      {flowStage?.status === 'failed' && (
        <p className="text-xs text-amber-400">
          Could not propose a flow ({flowStage.message}). Approving will let Pitchbox decide for itself.
        </p>
      )}

      {latest && (
        <textarea
          value={props.draft}
          onChange={(e) => props.setDraft(e.target.value)}
          rows={16}
          spellCheck={false}
          className="w-full rounded bg-zinc-950 border border-zinc-800 p-2.5 text-xs font-mono leading-relaxed"
        />
      )}

      <div className="space-y-1.5">
        <label className="text-xs text-zinc-400">Changes you want</label>
        <input
          value={props.feedback}
          onChange={(e) => props.setFeedback(e.target.value)}
          placeholder="search for the nearest coffee shop, scroll to the end then back up, then update the search"
          className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={props.onRevise}
          disabled={props.busy || !props.feedback.trim()}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900 disabled:opacity-50"
        >
          {props.busy ? 'Working…' : 'Apply changes'}
        </button>
        <button
          onClick={props.onSaveEdits}
          disabled={props.busy || !props.draft.trim()}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-900 disabled:opacity-50"
        >
          Save my edits
        </button>
        <button
          onClick={props.onApprove}
          disabled={props.busy}
          className="ml-auto rounded bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          Approve &amp; record
        </button>
      </div>
    </section>
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
