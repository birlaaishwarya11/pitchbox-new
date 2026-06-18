# Pitchbox — Debugging Learnings

A short, honest log of what broke, what I assumed wrong, and what fixed it while
getting the pipeline working end-to-end. Written so the next person can skip the
same traps.

---

## 1. "Key is set" ≠ "key works"
**Assumed:** the `.env` had all keys, so we were good.
**Reality:** the ElevenLabs key had been pasted into the `VOICE_ID` field, and
`ELEVENLABS_API_KEY` was still a placeholder. That one mix-up disabled the whole
pipeline (audio is required to boot the orchestrator).
**Lesson:** smoke-test each key with a real API call, in its own field — don't
trust that a value exists.

## 2. `temperature` is rejected by newer Claude models
**Assumed:** `temperature: 0.4` is harmless boilerplate.
**Reality:** Opus 4.7 / 4.8 return `400 — "temperature is deprecated for this
model."` Every LLM call failed instantly.
**Lesson:** don't send `temperature` to current Opus models. When a call 400s,
read the message — it told us exactly what to remove.

## 3. Parsing JSON out of LLM text is a trap
**Assumed:** "ask for JSON, then `JSON.parse` the reply" is fine.
**Reality:** it failed three different ways:
- a prose preamble before the JSON ("Here's the research… { … }"),
- raw newlines **inside** string values (invalid JSON),
- the JSON cut off because it hit `max_tokens`.
**Lesson:** use **structured tool output** — force the model to answer via a
tool call with a schema, and the SDK hands back a validated object. No parsing,
no truncation surprises. Also keep outputs short and give enough `max_tokens`.

## 4. `networkidle` hangs on modern web apps
**Assumed:** wait for the network to go idle before recording, so the page is
"ready."
**Reality:** single-page apps keep connections open (realtime, analytics,
websockets), so "network idle" never happens and navigation hangs.
**Lesson:** wait for `domcontentloaded`, then do a **short, best-effort** idle
wait that's allowed to fail. Never block forever on a perfect signal.

## 5. `page.screenshot()` can block with no timeout
**Assumed:** the screenshot loop would always make progress.
**Reality:** on a busy page the renderer can stall a single screenshot
indefinitely; the loop never reached its exit check.
**Lesson:** add a **watchdog** — a timer that force-closes the browser so the
stuck call throws and the loop can unwind.

## 6. A Node process "close" race that hangs forever
**Assumed:** `process.once('close', …)` always fires.
**Reality:** if the process already exited *before* you attach the listener, the
event is gone — you wait forever. This is the bug that left a stage stuck on
"running" even though Chrome/ffmpeg had already died.
**Lesson:** check `exitCode` / `signalCode` first and handle the
already-exited case; and if you SIGKILL on a timeout, **resolve** instead of
waiting for an event that won't come.

## 7. Always put a ceiling on slow, external steps
**Lesson:** any step that shells out, drives a browser, or calls a flaky service
gets an **overall timeout** at the orchestrator level. One wedged step should
never stall the whole pipeline — on timeout, fall back (here: a title-card
"slate" video) and keep going.

## 8. Prove the cheap path before the hard one
**What worked:** a "no recording" slate path let us verify the entire AI chain
(plan → research → script → voiceover → assemble) in ~1 minute, before touching
the genuinely hard screen-recording leg. Most bugs surfaced there, cheaply.
**Lesson:** get the golden path green first; tackle the risky part second.

## 9. Dev-loop hygiene
- `tsx watch` restarts the server on every file save — that **kills any
  in-flight run**. Don't edit mid-test, then wonder why state vanished.
- A hung recorder leaves **orphaned Chrome/ffmpeg** processes. Kill them between
  attempts or they pile up.

## 10. "Do we need to deploy?" — check what's already live
**Finding:** the test site was already on Vercel. Its **public pages** are
recordable with no login, but the app itself sits behind a Supabase **auth
wall**. So you can capture the marketing pages for free; capturing the real app
needs test credentials.
**Lesson:** before building a deploy step, probe the existing URL — reachable?
behind a wall? That decides whether you record directly or have to deploy.

---
# Phase 1 + 2 (landing, dead-code retirement, multi-provider BYO)

## 11. Map shared-vs-dead before deleting
**Assumed:** the old "analyze" flow's helpers were all dead.
**Reality:** `DaytonaDeployer` looked dead but was **shared** with the live
`/api/record` path — deleting it would have broken recording.
**Lesson:** before a cleanup, trace every reference (a quick search pass) and
split into *safe-to-delete* vs *shared-keep*. Deletion is the easy part;
knowing the blast radius is the work.

## 12. Next.js caches generated route types in `.next`
**Symptom:** after deleting an API route, `tsc` failed pointing at a
`.next/types/.../route.ts` for the file I'd just removed.
**Lesson:** that error is a stale build artifact — `rm -rf .next` and re-check.
Don't chase a "missing module" that you deleted on purpose.

## 13. `drawtext` needs libfreetype — not in every ffmpeg
**Assumed:** ffmpeg's `drawtext` would render the slate title.
**Reality:** this ffmpeg build was compiled without libfreetype, so `drawtext`
silently failed and the slate fell back to a **black frame**.
**Lesson:** don't depend on optional ffmpeg features. We already ship headless
Chromium for recording — render the title card as HTML, screenshot it to PNG,
and loop that. Reuse the capability you already have.

## 14. One adapter covers many LLM providers
**Insight:** most providers (OpenAI, Google Gemini, Groq, Mistral, OpenRouter,
DeepSeek) speak the **OpenAI-compatible** `chat/completions` API. A single
adapter parameterized by base-URL handles all of them; only Anthropic needs its
own. ~2 adapters → 6+ providers.
**Lesson:** look for the common protocol before writing one client per vendor.

## 15. Cross-provider structured output = JSON-in-text, not tool-calling
**Assumed:** use the provider's structured/tool-call feature for JSON.
**Reality:** every provider does tool-calling differently; it doesn't port.
**Lesson:** for multi-provider, ask for plain JSON and parse it **robustly**
(strip prose/fences, repair raw control chars). One code path, every provider.

## 16. Don't commit keys — even in `.env.example`
**Found:** a real Daytona key was sitting in the tracked `apps/server/.env.example`.
`.gitignore` protected `.env`, but the *example* file shipped a live secret.
**Lesson:** example files must contain blank placeholders only. Scan tracked
files for key patterns (`sk-`, `dtn_`, …), and rotate anything that leaked —
even into local history.

## 17. The production build catches what `tsc` doesn't
**Reality:** `tsc --noEmit` passed, but `next build` **failed** on ESLint
(`react/no-unescaped-entities` — a literal `'`/`"` in JSX). Vercel runs the real
build, so it would have failed there too.
**Lesson:** run the actual production build before calling something
deploy-ready — type-check is necessary, not sufficient.

## 18. BYO keys → build clients per-request, not at boot
**Reality:** the pipeline originally built its LLM agents once at startup from a
server env key. Bring-your-own-key means constructing them **per session** from
the request's provider/key/model, kept in a `Map` keyed by session id.
**Lesson:** also handle "session expired after a restart" (the map is in
memory) with a clear error instead of a crash. And validate a key/model with a
tiny live call, mapping `401→invalid key`, `404→model not found`,
`429→rate limited` to human text.

---
# Phase 3 + 4 (sandboxed repo recording, hosting)

## 19. Don't edit watched files mid-test (again)
**What happened:** while a 2-minute Daytona run was in flight, I edited a server
file → `tsx watch` restarted → the in-memory session vanished → the run died.
This is learning #9, re-learned the hard way.
**Lesson:** when a long run is going, only touch *non-watched* files (docs,
Dockerfile). Batch your source edits for after it finishes.

## 20. Make the failure tell you why, before guessing
**What happened:** the sandbox recorder failed with a generic "couldn't parse
output." I almost guessed at fixes; instead I changed the error to capture the
in-sandbox `exitCode` + `stderr` + log file.
**Payoff:** three *distinct* root causes surfaced across runs — Xvfb noise in
stdout, missing Chromium, wrong URL — each obvious once the real error showed.
**Lesson:** spend the first iteration making the error legible. Diagnose, then
fix. Guessing burns the expensive cycles.

## 21. Record over localhost *inside* the sandbox, not the public proxy
**Assumed:** record the app via its external Daytona preview URL.
**Reality:** the recorder runs *inside* the sandbox; the external preview proxy
isn't reliably reachable from within. Navigation just failed.
**Lesson:** from inside the box, hit `http://127.0.0.1:<port>` — the app is
local to you. Use the public URL only for outside access.

## 22. A fresh sandbox has no browser — and no browser *libraries*
**Reality:** Puppeteer in the sandbox failed because the base image had neither
Chromium nor its shared libs. Installing the distro `chromium` package pulls in
both; then point Puppeteer at it and skip its bundled-Chromium download.
**Lesson:** "it works on my machine" hides all the system libs a headless
browser needs. A clean container/sandbox needs them installed explicitly.

## 23. Sandbox isolation IS the feature, not overhead
**Why Daytona matters:** recording a user's GitHub repo means *building and
running their code*. Doing that on the host is remote code execution waiting to
happen. The sandbox is the security boundary — untrusted repos run there, never
on the host. Recording a plain URL (just visiting a page) is safe on the host.
**Lesson:** match the isolation to the trust level of what you're executing.

## 24. Run TypeScript directly in prod when build-time assumptions break
**Reality:** the server bundles its in-sandbox recorder from `.ts` source at
runtime (esbuild). A `tsc → dist/` image drops those `.ts` files, breaking it.
**Lesson:** running via `tsx` in the container (no precompile) kept the source
present and sidestepped the whole class of "works in dev, missing in dist"
problems. Validate that your build artifact actually contains what runtime
reads.
