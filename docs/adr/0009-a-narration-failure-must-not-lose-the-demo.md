# ADR 0009: A narration failure must not lose the demo

- Status: Accepted
- Date: 2026-08-03
- Deciders: aishwaryabirla, Claude

## Context

Two gates were added for a human to steer a run: sign in to the target yourself
(ADR 0007's consequence — Pitchbox holds no credentials), and confirm the
proposed walkthrough before anything is recorded. Both were implemented on the
server, deployed, and verified in the container.

Neither ever fired in production.

`STAGE_DEFS` in `apps/server/src/pipelineStages.ts` is the canonical stage list,
and the web front end keeps its own copy in `STAGE_META` to render the
pre-launch selection panel. The two new stages were added to the server list and
not to the client's. The client sends `selectedStages`, and
`SessionStore.create` marks any stage *absent* from that set as `skipped` —
so `login` and `flow` were created skipped on every single run, and `approve()`
skipped past both gates without a word. The feature was live and unreachable.

The same run then failed a second way. The voiceover stage got a 401 from
ElevenLabs (a rejected key) and threw, which put the whole run in `ERROR` at
stage `GENERATING`. The recording had already succeeded by that point: sandbox
time spent, a walkthrough completed. All of it was discarded because a
text-to-speech call was unauthorised, and the reported error was a wall of
provider JSON with a request id — which reads like a Pitchbox fault.

There was also no way to run the pipeline without paying for narration.
`voiceover` was `optional: false`, and `fuse` declared `dependsOn: ['voiceover']`,
so `resolveSelectedStages` pulled narration in transitively even if a caller
tried to deselect it.

## Decision Drivers

- A stage list duplicated across two packages will drift, and drifting silently
  disables features rather than breaking loudly.
- The expensive, already-completed work in a run is the recording. Narration is
  the cheap, retryable part.
- Narration costs real money on the user's own ElevenLabs key. Exercising the
  pipeline must not require spending it.
- An error a user can act on beats an accurate transcript of a provider's reply.

## Considered Options

1. **Fix the client list; keep narration fatal.** Smallest change. Leaves a
   rejected key still able to destroy a completed recording, and still no way to
   test without spending.
2. **Generate the stage list from a shared package.** Removes the class of bug
   permanently. A build-wiring change across two apps, disproportionate to a
   one-line omission, and the client list carries UI-only fields (hints,
   grouping) the server has no use for.
3. **Fix the client list, make narration optional and non-fatal.** Chosen.

## Decision

**Narration is optional, and a narration failure degrades the output instead of
failing the run.**

- `login`, `flow` and `voiceover` are in the client's `STAGE_META`, and all three
  are selected by default. The comment there records why their absence was not
  merely cosmetic.
- `voiceover` becomes `optional: true`. `fuse` now declares `dependsOn: []`;
  naming `voiceover` there made it a transitive dependency of a required stage,
  which defeated the toggle.
- `Fuser` accepts no `audioPath`. With a recording it hands the capture over
  losslessly (`-c:v copy -an`); with no recording it renders a silent slate
  bounded by `fallbackDurationMs`.
- A TTS failure marks the `voiceover` stage `failed` with the reason and lets the
  run continue to `fuse`. The run reaches `READY` with a silent video.
- A 401 from ElevenLabs is reported as a rejected key, with the remedy (check the
  key, or turn the Voiceover stage off) instead of the provider's JSON.

Fixed in passing, because it lived in a function being changed: both slate
builders drew video from an endless source (a looped still, a lavfi colour
field) and relied on `-shortest` to bound it, which overshot the narration by
~2s. A 3.0s voice track produced a 5.1s slate with dead air at the end. Both now
pass an explicit `-t`. Verified exact across all six audio/video/slate
combinations.

## Consequences

- A run can now reach `READY` with a stage marked `failed`. "Done" no longer
  implies every stage succeeded, and the UI must show the silent outcome rather
  than only the final video — otherwise a missing voiceover looks like a bug in
  the player.
- Someone with a bad key gets a silent demo instead of an error. That is the
  intended trade, but it makes a misconfigured key quieter; the failed stage and
  the server log are where it surfaces.
- The two stage lists still exist independently. This ADR does not fix that
  class of bug — option 2 remains available if it recurs. The mitigation for
  now is that both lists are short and adjacent in review.
- Manual sign-in remains limited to a pasted `recordUrl`. A GitHub-repo run
  builds the app inside a Daytona sandbox, and the login browser runs on the
  server, which cannot reach the sandbox's localhost. Closing that needs the
  login browser to run *inside* the sandbox and is not attempted here.

## References

- ADR 0007 — record the product, not the landing page
- ADR 0008 — environment variables for the app under test
- `apps/server/src/pipelineStages.ts`, `apps/web/src/app/pipeline/page.tsx`
- `apps/server/src/Fuser.ts`, `apps/server/src/PipelineOrchestrator.ts`
