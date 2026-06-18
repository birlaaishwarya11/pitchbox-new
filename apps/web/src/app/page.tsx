import Link from 'next/link';

const STEPS = [
  {
    n: 1,
    title: 'Analyze & plan',
    body: 'Point Pitchbox at a prompt (and optionally a repo). It decides the angle, audience, and hook, and researches what works for your use case.',
  },
  {
    n: 2,
    title: 'Script & record',
    body: 'It writes a tight voiceover script you can revise, and screen-records your live app or deployed URL in parallel.',
  },
  {
    n: 3,
    title: 'Narrate & assemble',
    body: 'ElevenLabs narrates the script, then everything is fused into a finished, shareable MP4 — no editing required.',
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto px-6 py-20 md:py-28">
        {/* Hero */}
        <section className="text-center space-y-6">
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Pitchbox</p>
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight">
            Turn any project into a{' '}
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-fuchsia-400">
              narrated demo video
            </span>
          </h1>
          <p className="text-base md:text-lg text-zinc-400 max-w-2xl mx-auto">
            Give Pitchbox a prompt and a URL. It plans the demo, writes the script, records the app,
            adds a voiceover, and assembles a finished video — with you in the loop at every step.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <Link
              href="/pipeline"
              className="rounded-lg bg-zinc-100 text-zinc-950 text-sm font-medium px-5 py-2.5 hover:bg-white transition"
            >
              Launch the pipeline →
            </Link>
            <Link
              href="/test"
              className="rounded-lg border border-zinc-800 text-zinc-300 text-sm px-5 py-2.5 hover:border-zinc-600 transition"
            >
              Test the building blocks
            </Link>
          </div>
        </section>

        {/* How it works */}
        <section className="mt-20 md:mt-28">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-700 text-sm text-zinc-300">
                  {s.n}
                </div>
                <h2 className="text-lg font-semibold">{s.title}</h2>
                <p className="text-sm text-zinc-400 leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Control note */}
        <section className="mt-16 text-center">
          <p className="text-sm text-zinc-500 max-w-2xl mx-auto">
            You choose which stages run, watch each agent work on a live board, review and revise the
            script before anything is generated, and download the final MP4.
          </p>
          <div className="mt-6">
            <Link
              href="/pipeline"
              className="inline-block rounded-lg bg-indigo-500 text-white text-sm font-medium px-5 py-2.5 hover:bg-indigo-400 transition"
            >
              Get started
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
