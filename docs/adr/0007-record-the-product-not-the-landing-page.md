# ADR 0007: Record the product being used, not the landing page

- Status: Accepted
- Date: 2026-08-02
- Deciders: aishwaryabirla, Claude

## Context

Every finished video was a tour of the front page.

The recorder navigated to one URL, scrolled to the bottom, and stopped. ADR 0002
added a shot planner on top of that — an agent that harvested elements from the
page and returned camera moves timed to the voiceover — which improved how the
front page was *shot* without changing the fact that the front page was all
anyone ever saw. Meanwhile the script, written from the repo summary, happily
narrated signing up and creating a project, over footage of a hero headline.

Two further problems were visible in the same output.

**The camera lurched.** Three defects compounded. It measured the subject with a
CSS transform transition still in flight, so `getBoundingClientRect` returned
scaled geometry and every shot aimed slightly wrong. It teleported with
`scrollTo` and then animated the zoom, which reads as a cut followed by a push
rather than a move. And it reset to zoom 1 before every shot, so the picture
pumped in and out between subjects. The permitted range went to 1.8, which on a
1280×720 frame crops away the context that tells a viewer where they are.

**Voiceover was bought twice.** It is the one stage billed per run. Re-cutting
the video without touching a word of the script — a retry, a new take, a
reiterate that ended up back where it started — paid ElevenLabs again for
identical audio, because `reiterate` discarded the previous file outright.

## Decision Drivers

- A demo must show the product working. That is the entire value of the artifact.
- No dead air. A frozen frame while a model decides what to click is worse than
  a flat scroll.
- Camera moves must land on the narration, which means the plan has to be timed
  before the take, not discovered during it.
- Degrade, never fail. A target that cannot be explored should still produce the
  video it produces today.
- Never spend a user's money twice for the same output.

## Considered Options

### 1. Live agent driving the browser during capture

The model looks at the current screen and decides the next action while frames
are being recorded. Handles screens nothing could predict.

Rejected: each decision is a multi-second round trip, and the frame is frozen
for all of it. On a 90-second video with eight decisions, a third of the runtime
is the model thinking. The action sequence also cannot be timed against a
voiceover that already exists.

### 2. Scout pass, then timed replay — **chosen**

Before any frame is captured, a headless pass drives the app: it finds the
signup entry point, fills the form with a throwaway persona, submits it, and
follows same-origin routes from wherever that lands. It returns a map of every
screen it reached, with selectors. One model call turns that map plus the
approved script into a timed beat list, and the beats are replayed
deterministically while frames are captured.

### 3. Scout, replay, and repair live when a selector goes missing

Option 2 plus a model call mid-take to re-pick a target that stopped resolving.
Rejected for now: it reintroduces exactly the stall option 2 exists to remove,
to fix a case that a skipped beat already handles acceptably.

## Decision

**Split discovery from performance.** `SiteScout` explores; `Director` plans;
`Recorder` replays. The old `Cinematographer` is gone — framing and action are
planned together, because the push-in onto a button and the click of that button
are one moment in the video, and keeping them in separate lists is how they
drift apart.

**Two dummy personas per run, derived from the session id.** The scout signs up
to find out what is behind the login, which means that account exists by the
time the camera rolls; the take needs its own, or the signup performed on screen
collides with the one scouting just created. Values are deliberately, visibly
fake — `example.com` is reserved by RFC 2606 and `555-01xx` by the NANP — because
they end up in a video the user is about to publish. Plans reference `{{email}}`
tokens rather than literals, so the recorder substitutes the right persona.

**The camera is one eased transform.** Scroll, translate and scale interpolate
together in a single rAF loop. Measurement happens with the transform cleared
and layout flushed inside one task, so nothing paints and the geometry is true.
Zoom is clamped to 1.3 and additionally capped so the subject always fits the
frame. Real scrolling is kept for the coarse pan on purpose: scroll-linked
reveals never fire if the page is only translated, and half a landing page would
stay invisible.

**Mouse input and screen capture stand off from each other, without a queue.**
A `page.screenshot()` in flight while a press/release pair is dispatched eats the
click — the command resolves, the pointer visibly lands on the button, and
nothing happens. This silently froze the first working walkthrough on the
landing page with no error to notice.

The obvious fix, a single mutex over both, was worse than the bug. A screenshot
taken during a document swap can block indefinitely, and a shared queue turns
that into a deadlock: the click waits behind the hung frame, the next frame waits
behind the click, and the recording holds one image until the watchdog kills the
browser 40 seconds later. Measured on the sandbox path, that produced a 2.5fps
slideshow and a click failing with "Session closed". So input never queues — it
signals intent, which stops new frames being started, waits at most 400ms for
anything already running, and then goes regardless. Frames carry their own
deadline, and the capture gives up only after 25 seconds with nothing good,
rather than after a fixed number of failures — a count-based limit turned a slow
page into a truncated recording.

Keyboard input stays outside entirely: typing holds the channel for a second or
more, and the whole point of typing on camera is watching it arrive.

**Screen capture picks its strategy at run time.** Puppeteer reads frames from
the compositor surface by default, which is ~13x faster where it works — 24ms a
frame against 313ms locally — and hangs indefinitely inside the Daytona sandbox,
which has no compositor surface to read back from. The same Chromium there
navigates and runs scripts perfectly, so the failure is specific to
`Page.captureScreenshot`. Pinning either value would give up the fast path or
give up the sandbox, so the first frame carries a short deadline and doubles as a
probe: if it fails, capture switches to the renderer for the rest of the run. This
is also what was behind the original unexplained `ffmpeg exited with code 234` —
not one frame had ever reached the encoder.

**Where no capture strategy works, ffmpeg grabs an X display instead.** Inside
the Daytona sandbox neither compositor nor renderer capture returns a frame, so
the repo path grabs an Xvfb display with ffmpeg, which never asks the browser for
anything. That path previously only scrolled — it now runs the same beats — and it
needs no capture gate, since with no screenshots in flight there is nothing for a
mouse event to collide with. Three things had to be fixed to make it work at all:
Xvfb is spawned directly, because the `xvfb` npm wrapper allocates a display but
does not report its number there; a non-zero ffmpeg exit is no longer treated as
failure, because ffmpeg returns 255 when interrupted, which is exactly how the
capture is stopped, and the output file is checked instead; and the browser runs
chromeless, because grabbing a display captures the window furniture too and the
first successful recording had a tab strip and an automation banner in shot.

**Voiceover is keyed by a hash of the script.** Reused when the text is
identical and the file is still on disk; re-recorded otherwise.

**Navigation is found by behaviour, not by markup.** An app that routes through
`onClick` and `navigate()` renders no `<a href>` at all, so a link crawl reports
a one-page product — which is most React apps. Buttons are therefore candidates
too, both for finding the way in and for spreading out afterwards. Two traps
came with that. A `<button>` with no `type` attribute reports `type="submit"`,
because that is the HTML default, so filtering submits rejected every nav control
in the app; being inside a `<form>` is what actually makes a button a submit.
And in a formless app the control that submits a form is indistinguishable from
a nav control, so buttons reading as actions — "Add check", "Create", "Save" —
are left to the code that understands them as forms.

**Consent walls are dismissed before anything else happens.** A cookie overlay is
opaque to everything downstream: the scout's clicks land on a backdrop and the
recording opens on a modal instead of the product. The guess is kept narrow — a
container must read like a consent notice by its own id/class or by mentioning
cookies or tracking in its text, and only then is an accept-shaped control inside
it clicked. "Continue" and "OK" are ordinary words in an ordinary app.

**The page's own background is preserved.** The camera used to hard-set
`html { background: #0b0b0f }` so letterbox areas read as deliberate. But `body`
is transparent unless a page says otherwise — Tailwind's preflight sets no body
background — and that near-black then showed straight through the content, so
every recording of such a page was dark text on a black field. The colour is now
copied from the page when it has one and otherwise left at the browser's white.

**The sandbox path scouts itself.** For a GitHub repo, only code inside the
Daytona sandbox can reach the app over localhost — the public preview URL needs
an access token — so the scout runs there and hands its map back to be directed
here, where the run's LLM key lives and where it stays.

## Consequences

**The scout mutates the target.** It submits real forms, so it creates whatever
the app creates: an account, a project, a contact request. Each run leaves two
dummy accounts behind, one from scouting and one from the take. This is the
unavoidable cost of showing a product rather than a page, and it is why the
persona is unmistakably fake. Destructive controls — sign out, delete, checkout,
subscribe — are never clicked.

**A run takes about two minutes longer.** Scouting is bounded to seven screens
and 110 seconds, enforced as a hard deadline around the whole pass rather than a
check between steps — one hanging navigation would otherwise sail straight
through it. Whatever was harvested before the deadline is still returned; a
partial map beats none. The map is cached per session, so a recording retry or a
script iteration does not re-explore; only the director re-runs when the words
change.

**The repo path's ceiling went from 12 to 18 minutes.** Scouting happens inside
the recording stage's own timeout, on top of provision, clone, install, build,
start and wait-for-HTTP. Twelve minutes covered the old sequence with little to
spare, so leaving it would have turned scouted repo runs into timeouts falling
back to a slate — a regression that would have looked like flakiness.

**Apps with a captcha, an email confirmation step, or an invite wall stay
outside.** The scout records why in its notes and the walkthrough covers what is
reachable. Recording still succeeds.

**Every new failure mode degrades to the old behaviour.** No scout, no director,
no script, a failed exploration, an unusable plan — all produce an empty beat
list, and the recorder falls back to scrolling.

**`reiterate` no longer clears `session.audio`.** It carries the hash of the
script it was read from, which is what makes the reuse decision safe.

## References

- ADR 0008 — environment for the app under test, the prerequisite this decision
  exposed: a repo walkthrough is only possible once the repo actually runs.
- ADR 0002 — pipeline architecture, which introduced the shot planner this
  supersedes.
- ADR 0005 — auth and usage limits, for why voiceover spend is the stage that
  matters.
- `apps/server/src/SiteScout.ts`, `apps/server/src/Director.ts`,
  `apps/server/src/cinematics/pageScript.ts`.
