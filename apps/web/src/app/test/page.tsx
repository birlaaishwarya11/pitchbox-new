'use client';

import { useState } from 'react';

const SERVER_BASE = process.env.NEXT_PUBLIC_SERVER_BASE || 'http://localhost:3001';

const SAMPLE_PROMPTS = [
  {
    label: 'Hackathon submission',
    value:
      'This is for a hackathon submission. Project is "Pitchbox" — generates auto-narrated demo videos from a GitHub URL. Judges will skim 50+ projects back-to-back, so hook in the first 5 seconds, focus on the magic moment (paste URL → finished video), under 90 seconds total.',
  },
  {
    label: 'Marketing landing-page hero',
    value:
      'Marketing voiceover for the Pitchbox landing page. Audience: founders and DevRel teams. Emphasise speed (minutes, not days) and that no editing skills are needed. Confident but not bro-y. ~60 seconds.',
  },
  {
    label: 'LinkedIn post',
    value:
      'LinkedIn launch post for Pitchbox. Punchy, first-person, ends with a "what would you point this at?" prompt. Under 45 seconds.',
  },
];

type ScriptResp = {
  status: 'ok';
  script: { fullScript: string; estimatedDurationSec: number; wordCount: number; model: string };
};

type AudioResp = {
  status: 'ok';
  audio: {
    url: string;
    fileName: string;
    bytes: number;
    voiceId: string;
    modelId: string;
    durationEstimateMs: number;
  };
};

export default function TestPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-10">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-widest text-zinc-500">Phase A — pipeline building blocks</p>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Pitchbox · agent test bench</h1>
          <p className="text-sm text-zinc-400 max-w-3xl">
            Two independent agents wired to the Express server on{' '}
            <code className="text-zinc-300">{SERVER_BASE}</code>. The full multi-agent pipeline (planner → researcher
            → script approval loop → fusion) lands in Phase B.
          </p>
        </header>

        <div className="grid md:grid-cols-2 gap-6">
          <ScriptCard />
          <AudioCard />
        </div>
      </div>
    </main>
  );
}

function ScriptCard() {
  const [userPrompt, setUserPrompt] = useState(SAMPLE_PROMPTS[0].value);
  const [projectContext, setProjectContext] = useState(
    'Pitchbox: paste any GitHub URL → it clones, analyses, runs in a Daytona sandbox, screen-records, and writes a voiceover script with Claude. Stack: Next.js + Express + Anthropic + ElevenLabs + Daytona.',
  );
  const [targetDurationSec, setTargetDurationSec] = useState(90);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScriptResp['script'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${SERVER_BASE}/api/test/script`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userPrompt, projectContext, targetDurationSec }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setResult((data as ScriptResp).script);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">1 · Script agent</h2>
        <p className="text-xs text-zinc-500">POST /api/test/script — Claude opus 4.7</p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs text-zinc-400">Purpose / instructions</label>
          <div className="flex gap-1">
            {SAMPLE_PROMPTS.map((p) => (
              <button
                key={p.label}
                onClick={() => setUserPrompt(p.value)}
                className="text-[10px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          rows={5}
          className="w-full rounded bg-zinc-950 border border-zinc-800 p-2 text-sm focus:border-zinc-600 outline-none"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-zinc-400">Project context (optional)</label>
        <textarea
          value={projectContext}
          onChange={(e) => setProjectContext(e.target.value)}
          rows={3}
          className="w-full rounded bg-zinc-950 border border-zinc-800 p-2 text-sm focus:border-zinc-600 outline-none"
        />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-xs text-zinc-400">Target seconds</label>
        <input
          type="number"
          min={20}
          max={300}
          value={targetDurationSec}
          onChange={(e) => setTargetDurationSec(Number(e.target.value))}
          className="w-24 rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm"
        />
        <button
          onClick={run}
          disabled={loading || !userPrompt.trim()}
          className="ml-auto rounded bg-zinc-100 text-zinc-950 text-sm font-medium px-4 py-1.5 hover:bg-white disabled:opacity-40"
        >
          {loading ? 'Generating…' : 'Generate script'}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950/40 text-red-200 text-xs p-3 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="text-[11px] text-zinc-500 flex gap-3">
            <span>{result.wordCount} words</span>
            <span>~{result.estimatedDurationSec}s</span>
            <span>{result.model}</span>
            <button
              onClick={() => navigator.clipboard.writeText(result.fullScript)}
              className="ml-auto text-zinc-300 hover:text-white"
            >
              copy
            </button>
          </div>
          <pre className="rounded bg-zinc-950 border border-zinc-800 p-3 text-sm whitespace-pre-wrap font-sans leading-relaxed">
            {result.fullScript}
          </pre>
        </div>
      )}
    </section>
  );
}

function AudioCard() {
  const [text, setText] = useState(
    "Pitchbox turns any GitHub repo into a narrated demo video. Paste a URL, pick a vibe, and you've got a hackathon submission, a LinkedIn clip, or a marketing teaser before your coffee gets cold.",
  );
  const [voiceId, setVoiceId] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AudioResp['audio'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${SERVER_BASE}/api/test/audio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voiceId: voiceId || undefined }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setResult((data as AudioResp).audio);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">2 · Audio agent</h2>
        <p className="text-xs text-zinc-500">POST /api/test/audio — ElevenLabs eleven_multilingual_v2</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-zinc-400">Text to speak</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          className="w-full rounded bg-zinc-950 border border-zinc-800 p-2 text-sm focus:border-zinc-600 outline-none"
        />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-xs text-zinc-400 w-20">Voice ID</label>
        <input
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          placeholder="leave empty for default"
          className="flex-1 rounded bg-zinc-950 border border-zinc-800 p-1.5 text-sm font-mono"
        />
        <button
          onClick={run}
          disabled={loading || !text.trim()}
          className="rounded bg-zinc-100 text-zinc-950 text-sm font-medium px-4 py-1.5 hover:bg-white disabled:opacity-40"
        >
          {loading ? 'Synthesising…' : 'Generate audio'}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950/40 text-red-200 text-xs p-3 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="text-[11px] text-zinc-500 flex gap-3">
            <span>{(result.bytes / 1024).toFixed(1)} KB</span>
            <span>~{(result.durationEstimateMs / 1000).toFixed(1)}s</span>
            <span className="font-mono">{result.voiceId}</span>
            <span>{result.modelId}</span>
          </div>
          <audio controls className="w-full" src={`${SERVER_BASE}${result.url}`} />
          <a
            href={`${SERVER_BASE}${result.url}`}
            download={result.fileName}
            className="inline-block text-xs text-zinc-300 hover:text-white underline"
          >
            download mp3
          </a>
        </div>
      )}
    </section>
  );
}
