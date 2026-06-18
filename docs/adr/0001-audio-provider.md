# ADR 0001: Audio provider for demo voiceover

- Status: Accepted
- Date: 2026-04-25
- Deciders: aishwaryabirla, Claude

## Context

The pitchbox pipeline needs to render a voiceover audio track from a demo
script and mux it onto a screen recording. The voiceover is rendered offline
(batch) per generation request, not streamed in real time. The repo already
ships a Python POC (`backend/voiceover.py`) that uses ElevenLabs; the
production runtime (`apps/server`, Node/Express) has no TTS integration yet.

We surveyed the current 2026 landscape:

| Provider     | Latency (TTFA) | Naturalness   | Cost            | Languages | Notes |
|--------------|----------------|---------------|-----------------|-----------|-------|
| ElevenLabs   | ~150 ms (Flash 75 ms) | Highest (44.98 % "natural" hits in third-party eval) | $$$ | 70+ | Official Node SDK, voice cloning, multilingual_v2 |
| Cartesia Sonic | ~90 ms         | High          | ~1/5 of ElevenLabs | 15        | Best $/quality if cost dominates |
| OpenAI TTS   | ~200 ms        | Lower (78 % "low naturalness" hits) | $$ | Many     | Best if already on OpenAI stack |
| LiveKit      | n/a (realtime orchestration framework) | n/a | n/a | n/a | NOT a TTS provider — orchestrates WebRTC voice agents and *plugs into* a TTS like ElevenLabs. Wrong tool for offline render. |

## Decision

Use **ElevenLabs** as the TTS provider via the official
`@elevenlabs/elevenlabs-js` Node SDK.

## Reasoning

1. Offline batch rendering, not realtime. LiveKit's value prop (turn-taking,
   interruption, WebRTC sessions) is irrelevant — it would only add a wrapper
   around a TTS we still have to choose.
2. Demo videos are watched, not transacted on. Voice naturalness is the
   single biggest perceived-quality lever; ElevenLabs leads on it.
3. Already partly integrated: API key slot exists in `.env`, the Python POC
   demonstrates the model + voice settings we'll port (`eleven_multilingual_v2`,
   voice id `JBFqnCBsd6RMkjVDRZzb`).
4. Cartesia is tempting on price; revisit if we hit cost pressure or need to
   batch-render many variants. Switching cost is bounded — the AudioGenerator
   abstraction will keep the provider behind one interface.

## Consequences

- Add dependency: `@elevenlabs/elevenlabs-js` in `apps/server/package.json`.
- Required env vars: `ELEVENLABS_API_KEY` (existing slot), optional `VOICE_ID`
  (defaults to `JBFqnCBsd6RMkjVDRZzb`).
- The Python `backend/voiceover.py` becomes a reference, not a runtime path.
  We will not call it from the Node server.
- The `AudioGenerator` interface should keep `generate(script: string) →
  { mp3Buffer, durationMs }` so a Cartesia/OpenAI swap stays a one-file change.

## Revisit when

- ElevenLabs monthly bill grows past a meaningful threshold.
- We need realtime/streaming voice (would push us toward LiveKit + TTS plugin).
- Voice cloning of a specific human (founder/PM) becomes a requirement —
  ElevenLabs supports this; Cartesia's offering is narrower today.
