# ADR 0010: Secrets the demo types on camera

- Status: Accepted
- Date: 2026-08-03
- Deciders: aishwaryabirla, Claude

## Context

ADR 0007 stopped Pitchbox holding anyone's credentials: a person signs in
themselves, in a browser they drive. That covers getting *into* a product. It
does not cover the demo that needs a credential to do anything once inside.

Pitchbox's own demo is the example. The pipeline page does nothing without an LLM
key pasted into a field. The same shape appears everywhere — an API key in a
settings screen, a licence code, a webhook token. Until now the only values the
walkthrough could type came from `dummyIdentity`, which invents plausible
rubbish. A fake key produces a failed request on camera, so the demo shows the
product not working.

`appEnv` (ADR 0008) is not this. That configures the app so it will *boot*, and
is injected into a sandbox's environment. These are values entered through the
UI, during the recording, in front of the lens.

Three distinct ways this can leak, and they fail differently:

1. **Into the model.** The planner and director are LLM agents. Anything put in a
   prompt to plan a beat has left the building.
2. **Into the video.** The deliverable is a screen recording. A value typed into
   a `type="text"` field is filmed, and the video gets shared.
3. **Into everything else.** `PipelineSession` is serialised into every poll of a
   run. Error messages get logged and stored. A provider quoting a rejected key
   in its 401 is a real thing that happens.

## Decision Drivers

- A value must not reach an LLM even incidentally, because that is irreversible.
- The product has to receive the *real* credential, or the demo is pointless — so
  this cannot be solved by not typing it.
- Masking must survive a controlled React input, which re-renders on every
  keystroke.
- No read-back path. A UI that can display a secret is a UI that can leak one.

## Considered Options

1. **Reuse `appEnv`.** Wrong layer: it sets environment variables for a boot, and
   says nothing about which field to type what into.
2. **Let the director place literal values.** Simplest to implement and
   disqualified outright — it requires putting the value in a prompt.
3. **Named references, resolved at the keystroke.** Chosen.

## Decision

**A secret is referenced by name everywhere except the keystroke that types it.**

- The web UI collects name/value rows and `POST`s them once. Values are cleared
  from React state as soon as they are accepted; nothing displays them again.
- Values live in `secretsBySession`, a Map beside the session — never on it, so no
  API response can serialise one. `redactSession` derives `secretNames` instead.
- The planner and director are given **names only**, and instructed to write
  `{{secret:NAME}}`, reusing the `{{token}}` mechanism already there for the dummy
  persona. A plan is therefore safe to store, show, edit and re-send to a model.
- `Recorder` substitutes the value at the keystroke and nowhere earlier, and
  passes it per call rather than holding it: that instance is shared by every run
  on the server, so a field would hand one run's credentials to the next.
- The field is masked **before** typing and never unmasked. Restoring it would put
  the value on screen, which is the whole thing being avoided. Masked dots are the
  correct picture of "a key was entered here".
- Masking is a stylesheet rule keyed off an attribute, carrying `!important` —
  not `type="password"`. A controlled React input resets the `type` prop on each
  keystroke and unmasked the rest of the value; React never sees the rule.
- If the field cannot be found or masked, the recorder **refuses to type** rather
  than filming the value.
- `redactSecrets` scrubs values from anything heading for a log or the session, for
  the paths too diffuse to audit individually.
- The API is merge-and-delete, not replace. A caller cannot read a value back, so
  it cannot resend one it saved earlier; replace semantics silently dropped every
  existing secret each time another was added.

Also fixed here, because it is the same concern: `SessionStore` gained an
`onDestroy` hook and the orchestrator now purges its side maps when a session is
evicted. Nothing did before, so `appEnv` and secrets — real credentials — outlived
their runs and sat in memory until the process restarted.

## Consequences

- **Verified, not asserted.** Masking was proven at the pixel level: two different
  secrets of equal length, typed into a `type="text"` field with a handler that
  rewrites `type` on every keystroke, produce byte-identical screenshots when
  masked and differing ones when not, while the DOM still holds the real value.
- **What this cannot promise.** If the product itself renders the value back after
  accepting it — echoes the key in a header, a toast, a confirmation — that is on
  screen and Pitchbox has no say. Masking covers the field being typed into, not
  the app's own output.
- **A user can still defeat it** by pasting a raw value into the walkthrough text
  box instead of the secrets editor. That text is stored on the session and sent
  to the model. The editor's copy points at `{{secret:NAME}}`; the affordance is
  the mitigation, and there is no way to detect an arbitrary string is a
  credential.
- Secrets are per-run and in-memory. A server restart loses them, which is the
  correct trade for never persisting a credential to disk.
- Sandbox (GitHub-repo) runs do not receive walkthrough secrets: the recorder runs
  inside Daytona and would need the values written into the sandbox. Not attempted
  here; `appEnv` remains the route for repo configuration.

## References

- ADR 0007 — record the product, not the landing page (manual sign-in)
- ADR 0008 — environment variables for the app under test (`appEnv`)
- `apps/server/src/security/secrets.ts`, `apps/server/src/Recorder.ts`
- `apps/server/src/cinematics/pageScript.ts` (`installSecretMask`)
