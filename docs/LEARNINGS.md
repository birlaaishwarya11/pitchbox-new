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
