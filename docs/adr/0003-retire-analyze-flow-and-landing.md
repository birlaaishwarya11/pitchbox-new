# ADR 0003: Retire the one-shot "analyze" flow; landing page funnels into the pipeline

- Status: Accepted
- Date: 2026-06-17
- Deciders: aishwaryabirla, Claude

## Context

Two parallel user-facing flows had grown up in the codebase:

1. **The old one-shot "analyze" flow** — the landing page (`apps/web/src/app/page.tsx`)
   was a wizard that posted to `POST /api/analyze`, which used `ScriptGenerator`
   (an older `claude-3-5-sonnet` agent) to produce a script in a single shot.
   A sibling test endpoint `POST /api/test/script` used `PromptScriptGenerator`.
2. **The real pipeline** — `PipelineOrchestrator` driving
   `Planner → Researcher → Scripter → AudioGenerator → Recorder → Fuser`,
   surfaced at `/pipeline` with a live agent board, stage selection,
   human-in-the-loop script review, and a final video.

Flow (1) was superseded by flow (2): it produced no video, used an older model,
duplicated script-generation logic, and the landing page sent users into a
dead-end instead of the working pipeline.

## Decision

Retire the one-shot analyze flow and make the landing page funnel into the
pipeline.

**Removed (dead):**
- `apps/server/src/ScriptGenerator.ts`, `apps/server/src/PromptScriptGenerator.ts`
- Server routes `POST /api/analyze` and `POST /api/test/script`
- Web route `apps/web/src/app/api/analyze/route.ts`
- The wizard body of `apps/web/src/app/page.tsx`

**Kept (shared with the live pipeline — explicitly *not* deleted):**
- `RepositoryCloner`, `CodebaseAnalyzer`, `FlowExtractor` — used by the
  pipeline's optional `analyze` stage.
- `DaytonaDeployer`, `SandboxRecorder`, `POST /api/record`, `POST /api/deploy` —
  used by the sandbox-recording path.
- `POST /api/test/audio` — a still-useful isolated TTS test bench.

**Landing page:** rewritten as a real landing page (hero + how-it-works + CTAs)
that links to `/pipeline`. We chose a **two-page** model (landing → pipeline)
rather than merging the hero into the pipeline page, to keep the pipeline page
focused on the working app and give marketing copy its own home.

## Consequences

- One script-generation path (`Scripter`) on the current model — less drift,
  less confusion.
- The landing page now sends users to the working pipeline instead of a dead
  one-shot endpoint.
- `apps/web/src/app/api/deploy/route.ts` remains because `POST /api/deploy`
  still exists; revisit if the deploy endpoint is later removed.
- Supersedes the script-generation portion of [ADR 0002](0002-pipeline-architecture.md);
  the rest of 0002 still stands.
