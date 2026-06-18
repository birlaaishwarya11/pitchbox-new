'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const SERVER_BASE = process.env.NEXT_PUBLIC_SERVER_BASE || 'http://localhost:3001';

type Status = 'CREATED' | 'PLANNING' | 'RESEARCHING' | 'SCRIPT_DRAFT' | 'GENERATING' | 'FUSING' | 'READY' | 'ERROR';

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
  input: { githubUrl?: string; branch?: string; userPrompt: string; targetDurationSec: number };
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

const STAGE_ORDER: Status[] = ['PLANNING', 'RESEARCHING', 'SCRIPT_DRAFT', 'GENERATING', 'FUSING', 'READY'];

export default function PipelinePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inputs
  const [userPrompt, setUserPrompt] = useState(SAMPLE_PROMPTS[0].value);
  const [githubUrl, setGithubUrl] = useState('');
  const [targetDurationSec, setTargetDurationSec] = useState(90);
  const [skipRecording, setSkipRecording] = useState(true);

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
      const r = await fetch(`${SERVER_BASE}/api/pipeline/${id}/status`);
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
      const r = await fetch(`${SERVER_BASE}/api/pipeline/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userPrompt,
          githubUrl: githubUrl.trim() || undefined,
          targetDurationSec,
          skipRecording,
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
      const r = await fetch(`${SERVER_BASE}/api/pipeline/${session.id}/feedback`, {
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
      const r = await fetch(`${SERVER_BASE}/api/pipeline/${session.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skipRecording }),
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
      const r = await fetch(`${SERVER_BASE}/api/pipeline/${session.id}/reiterate`, { method: 'POST' });
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
          <p className="text-xs uppercase tracking-widest text-zinc-500">Pipeline</p>
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
            targetDurationSec={targetDurationSec}
            setTargetDurationSec={setTargetDurationSec}
            skipRecording={skipRecording}
            setSkipRecording={setSkipRecording}
            onStart={handleStart}
          />
        )}

        {session && <ProgressBar status={session.status} />}

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
            skipRecording={skipRecording}
            setSkipRecording={setSkipRecording}
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
  targetDurationSec: number;
  setTargetDurationSec: (v: number) => void;
  skipRecording: boolean;
  setSkipRecording: (v: boolean) => void;
  onStart: () => void;
}) {
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
          <label className="text-xs text-zinc-400">GitHub URL (optional)</label>
          <input
            value={props.githubUrl}
            onChange={(e) => props.setGithubUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="w-full rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm font-mono"
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

      <label className="flex items-center gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={props.skipRecording}
          onChange={(e) => props.setSkipRecording(e.target.checked)}
        />
        Skip Daytona screen recording (use slate-only fallback for the final video)
      </label>

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

function ProgressBar({ status }: { status: Status }) {
  const idx = STAGE_ORDER.indexOf(status);
  return (
    <div className="flex items-center gap-2 text-xs">
      {STAGE_ORDER.map((stage, i) => (
        <span
          key={stage}
          className={`px-2 py-1 rounded border ${
            i < idx
              ? 'border-emerald-700 text-emerald-300'
              : i === idx
                ? 'border-amber-600 text-amber-300 animate-pulse'
                : 'border-zinc-800 text-zinc-500'
          }`}
        >
          {i + 1}. {stage}
        </span>
      ))}
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
        <p><b className="text-rose-300">DON'T:</b> {research.donts.join(' · ')}</p>
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
  skipRecording: boolean;
  setSkipRecording: (v: boolean) => void;
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
                  {v.feedbackUsed && <> · feedback: "{v.feedbackUsed}"</>}
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
            <input
              type="checkbox"
              checked={props.skipRecording}
              onChange={(e) => props.setSkipRecording(e.target.checked)}
            />
            slate-only
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
