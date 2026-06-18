# ADR 0002: Demo-generation pipeline architecture

- Status: Accepted
- Date: 2026-04-25
- Deciders: aishwaryabirla, Claude

## Context

The user wants a pipeline that:

1. Accepts a free-form **purpose prompt** (e.g. "marketing", "hackathon
   submission", "YouTube demo", "LinkedIn", or special instructions /
   features to focus on) alongside a GitHub repo URL.
2. **Plans** how to explore the repo and what to feature, conditioned on the
   purpose.
3. Does **web research** for use-case-specific dos/don'ts (hackathon judges
   skim, LinkedIn rewards <60 s, YouTube wants strong first 5 s, etc.).
4. Generates a **script** in one agent and **audio** in another, then
   **fuses** them together onto a screen recording.
5. Gates on **user approval** of the script before any expensive media
   generation; supports unbounded iteration on the script.
6. After final video, lets the user **download / view / reiterate** — where
   "reiterate" rewinds back to the script-checkpoint and re-enters the
   approval loop.
7. **Session-only** state for now — no persistence.

## Decision

### Agent topology (single Node process, parallel where independent)

```
                       ┌────────────────┐
   user prompt ───────▶│   1. Planner   │── plan (focus, length, tone, must-haves)
   github url          └───────┬────────┘
                               ▼
   repo clone ──────▶┌─────────────────┐
   + analysis        │ 2. Researcher    │── findings (use-case dos/don'ts via WebSearch)
                     └───────┬─────────┘
                             ▼
                     ┌─────────────────┐
                     │ 3. Scripter      │◀───── user feedback (loop until approved)
                     └───────┬─────────┘
                             │ approved script
            ┌────────────────┼────────────────┐
            ▼                                 ▼
   ┌────────────────┐                ┌────────────────┐
   │ 4a. Audio Gen  │                │ 4b. Video Gen  │
   │  (ElevenLabs)  │                │ (existing      │
   │                │                │  Daytona+ffmpeg│
   │                │                │  recorder)     │
   └────────┬───────┘                └────────┬───────┘
            └────────────────┬────────────────┘
                             ▼
                     ┌────────────────┐
                     │ 5. Fusion      │── final mp4 (ffmpeg mux + optional duck/loop)
                     └────────────────┘
```

- **Planner / Researcher / Scripter** are Anthropic Messages API calls. The
  Researcher uses WebSearch as a tool (Anthropic native web-search tool), so
  it can pull live patterns instead of relying on training data.
- **Audio Gen** is an ElevenLabs SDK call (see ADR-0001).
- **Video Gen** reuses the existing `SandboxRecorder` / `Recorder` path — no
  rewrite.
- **Fusion** is `ffmpeg -i video.mp4 -i audio.mp3 -c:v copy -c:a aac -shortest`
  with timing fixes (loop video if audio is longer, or trim audio).

### State machine

```
CREATED  →  PLANNING  →  RESEARCHING  →  SCRIPT_DRAFT
                                              │
                                              ▼  (user submits feedback)
                                         SCRIPT_DRAFT  ⟲   (loop)
                                              │
                                              ▼  (user approves)
                                         GENERATING  (audio || video in parallel)
                                              │
                                              ▼
                                         FUSING
                                              │
                                              ▼
                                         READY  ──────────┐
                                              │           │
                                              │  ◀────────┘ (reiterate → SCRIPT_DRAFT,
                                              │              keeps plan + research,
                                              │              forks new script)
                                              ▼
                                          (download / view)
```

### Session storage

- **In-memory `Map<sessionId, Session>`** in the Node server process
  (`SessionStore` singleton). Lost on restart, fits the "no persistence" rule.
- Session shape:
  ```ts
  {
    id, createdAt, status,
    input: { githubUrl, branch?, userPrompt },
    plan?: PlanArtifact,
    research?: ResearchArtifact,
    scriptVersions: ScriptArtifact[],   // append-only; reiteration adds a new version
    approvedVersionId?: string,
    audioPath?, videoPath?, finalMp4Path?,
    error?,
  }
  ```
- TTL sweeper runs every 30 min and evicts sessions older than 2 h to bound
  memory. Generated mp3/mp4 files live under `recordings/sessions/<id>/` and
  are deleted with the session.

### API surface (new endpoints, all under `/api/pipeline`)

| Verb | Path | Purpose |
|------|------|---------|
| POST | `/api/pipeline/start`       | Body: `{ githubUrl, userPrompt, options? }` → `{ sessionId }`. Kicks off planner+researcher+scripter (background). |
| GET  | `/api/pipeline/:id/status`  | Polling endpoint. Returns `{ status, scriptVersions, error? }`. |
| POST | `/api/pipeline/:id/feedback`| Body: `{ feedback }` → triggers a new scripter pass. |
| POST | `/api/pipeline/:id/approve` | Approves the latest script version, kicks off audio + video in parallel, then fusion. |
| GET  | `/api/pipeline/:id/result`  | Returns final mp4 download URL when status is READY. |
| POST | `/api/pipeline/:id/reiterate` | Rewinds to SCRIPT_DRAFT (forks a new script version), preserves plan + research. |

Plus two **isolated test endpoints** for Phase A wiring:

| Verb | Path | Purpose |
|------|------|---------|
| POST | `/api/test/script` | Body: `{ userPrompt, projectContext? }` → script text. Tests Anthropic plumbing without repo clone. |
| POST | `/api/test/audio`  | Body: `{ text, voiceId? }` → audio file (mp3). Tests ElevenLabs plumbing. |

### Why not separate processes per agent

Single-process keeps deploy simple (one Express, one node_modules) and lets us
share the `SessionStore`. The agents are I/O-bound (LLM/HTTP), not CPU-bound,
so child processes buy nothing. We only fork out for `ffmpeg`, which already
shells out.

## Consequences

- New files in `apps/server/src/`: `SessionStore.ts`, `Planner.ts`,
  `Researcher.ts`, `PromptScriptGenerator.ts` (extends/replaces
  `ScriptGenerator.ts` for the prompt-driven path), `AudioGenerator.ts`,
  `Fuser.ts`, plus pipeline routes wired in `index.ts`.
- New `apps/web/src/app/test/page.tsx` for the Phase A test harness, then a
  multi-step UI for the full pipeline (input → script-review → result) once
  Phase A is green.
- Existing `/api/analyze` is untouched in Phase A and gets folded into the
  new `Scripter` stage in Phase B (it already does the codebase-analysis →
  Anthropic-script piece; we'll just thread `userPrompt` + research findings
  into its prompt builder).
- Required env: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, optional `VOICE_ID`,
  `DAYTONA_API_KEY` (only for the video-recording leg).

## Revisit when

- We add multi-user / shareable sessions → upgrade to Redis or sqlite.
- Long-running pipelines (>5 min) need queueing → add BullMQ or similar.
- Frontend wants live progress → swap polling for SSE or WebSocket.
