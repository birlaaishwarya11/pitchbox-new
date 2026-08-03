# ADR 0008: Environment variables for the app under test

- Status: Accepted
- Date: 2026-08-03
- Deciders: aishwaryabirla, Claude

## Context

ADR 0007 made a repo recording walk the product rather than tour its landing
page. That exposed the step before it: the product has to *run*.

Nothing in the pipeline could give the cloned repo any configuration. The sandbox
ran `npm install` and `npm run dev` with nothing but `PORT` and `HOST`, so any
project needing a `DATABASE_URL`, a publishable API key or a feature flag either
crashed on boot or rendered its own error page. The recording then captured
whatever that produced.

Three failures made this concrete on a real Daytona run of this repository:

1. **No way to supply configuration.** With no Supabase variables, the Next.js
   app served an error overlay. The readiness check — `curl -fsS` against the
   port — got HTTP 200 from that overlay and declared the app ready.
2. **The readiness check was a status code.** A dev server answers 200 while
   rendering a stack trace, so a completely broken app passed.
3. **Failures explained nothing.** The error was `App did not become ready inside
   Daytona sandbox.` A separate case died with `Setup step "Install workspace
   dependencies" exited with code 137` — which is the OOM killer, and reads as an
   arbitrary number. A third produced `ffmpeg exited with code 234`, with no way
   to find out that not a single screenshot had succeeded.

These are all the same problem: a long, expensive, remote run that fails without
saying why.

## Decision Drivers

- A project that cannot start cannot be demoed. This is a prerequisite, not a
  feature.
- The values are production credentials. They must not leak into a response, a
  log, telemetry, or a model prompt.
- Failure has to be self-diagnosing. Ten minutes of sandbox time must not end in
  a number.
- Bound the blast radius: an arbitrary blob is travelling from an HTTP body into
  a shell environment.

## Considered Options

### 1. Do nothing; only record apps that boot with no configuration

Rejected. It quietly restricts the product to toy repositories, and gives no
signal that this is why a run failed.

### 2. Accept a `.env` file upload

Rejected as the primary interface: it implies storage and a lifecycle for
something that should exist only for the duration of one run.

### 3. Per-run `appEnv`, held in memory, bounded — **chosen**

Accepted either as an object or as `.env`-style text, validated at the edge,
injected into the sandbox, and never persisted.

## Decision

**`appEnv` on the request, memory for the run, and nowhere else.** It is kept in
a map beside the session rather than on it. `PipelineSession` is serialised
wholesale into every `GET /api/pipeline/:id` response, so a field on
`session.input` would hand the caller's database password back over HTTP and put
it in any log line that dumps a session. Only names are ever logged.

**Injected two ways, because one is not enough — and never through Daytona's
per-command `env` map.** Written to `.env.local` in the clone for frameworks that
load files, and exported inside the uploaded build and start scripts, with each
value shell-quoted, for anything reading `process.env`.

The per-command `env` parameter looked like the obvious channel and is unusable:
Daytona splices those values into a shell command without quoting them, so a
credential containing a quote, a `$` or a space — which real credentials
routinely do — breaks the command itself. It surfaced as
`sh: 1: Syntax error: Unterminated quoted string` from the start command, with the
app simply never starting. A deliberately shell-hostile test value
(`quote"dollar$space brace} ok`) is what exposed it; a well-behaved test value
would have shipped this. `.env.local` specifically: it is the
Node convention for machine-local overrides, takes precedence in Next.js and
Vite, and is gitignored by default, so writing it cannot clobber a committed
`.env`. It is uploaded as a file rather than echoed through a shell — a secret
containing a quote or a `$` would otherwise arrive mangled or expanded, which
does not look like a corrupted secret so much as a wrong one. The same reasoning
applies to the commands themselves: build and start are uploaded as scripts and
invoked as a single token, because nothing hand-quoted survives the trip.

**Validated at the edge, with limits.** 40 variables, 4096 characters per value,
16 KB total, `[A-Za-z_][A-Za-z0-9_]*` names. `PORT`, `HOST`, `PATH`,
`NODE_OPTIONS`, the loader variables and the `RECORDER_*` / `PUPPETEER_*` /
`DAYTONA_*` / `PBX_*` prefixes are refused: the first two are the contract the
recorder uses to find the app, and the rest would let a request reconfigure the
recorder or get code run by a later command. A rejection is a `400` naming the
variable, so a bad value costs a round trip rather than a ten-minute sandbox that
fails at the end.

**Readiness means "the app rendered", not "the port answered".** Before
exploring, the scout checks whether the entry page is a Next.js, Vite or Remix
error overlay, and a repo run fails with that overlay's own text. Frameworks name
the variable they are missing, which is more useful than anything this code could
infer.

**Every command in the sandbox is checked for its exit code.** This was the root
cause behind most of the above. `sandbox.process.executeCommand` resolves on a
non-zero exit — it reports the code rather than throwing — and only the deployer's
setup steps ever inspected it. Every other command was effectively
fire-and-forget: a failed build, a start command that never launched, and most
damagingly a readiness loop that spent its full 120 seconds failing, all returned
as success and the run continued. That is why a repo whose app never started
reported "a browser could not load the page" rather than naming the real problem,
and why the readiness diagnostic written for exactly this case had never once
fired. Commands now go through a helper that throws with the command's output;
the readiness loop opts out of throwing so it can report the *app's* log instead
of the loop's silence.

**Build and start are uploaded as scripts.** Checking exit codes revealed that
the start command had been failing with
`sh: 1: Syntax error: Unterminated quoted string` — so the app was never started
on this path at all, and the readiness loop then failed silently for two minutes
afterwards.

The cause was the environment, not the command: a later run with a quote-free
`bash /tmp/pitchbox-start.sh` reproduced the identical error, which is what
isolated it to the `env` map. Moving the commands into uploaded files is
hardening rather than the fix — it removes a whole class of quoting hazard from a
string that is assembled here and interpreted somewhere else — and it is where the
properly quoted `export` lines now live.

**A backgrounded start command is verified separately.** Its exit code says
nothing even when the shell is valid — a missing binary and an instant crash both
look like success — so the process is checked for liveness three seconds later,
and a dead one fails with what it printed before exiting.

**Every remote failure now carries its evidence.** The readiness timeout returns
the last 40 lines of `/tmp/pitchbox-app.log`, the names supplied, and a cause
guessed from the log (a named variable, `EADDRINUSE`, a missing module, an
unreachable service). Setup steps translate exit 137 into "killed, almost
certainly out of memory" and include their output. ffmpeg's stderr tail is
retained and reported instead of a bare exit code, and a capture that produced
zero frames says exactly that rather than leaving ffmpeg to fail on an empty
stream.

**The recorder runtime is installed before the app is started.** It used to be
installed after, and it installs Puppeteer — a heavy install running alongside a
live dev server. On a small sandbox the pair exceeds the memory limit and the OOM
killer takes the largest process, which is the dev server. Because the readiness
check had already passed, the app looked healthy and then silently vanished: the
browser could not connect, and the app log was empty because a SIGKILLed process
loses its buffered stdout. Nothing in that step depends on the app being up, so
it simply goes first.

**Sandboxes are released.** There was no cleanup at all, which is why the account
holds sandboxes dating back a year. Deleted on success; kept 60 minutes on
failure so the logs inside can still be read, then auto-deleted.
`PITCHBOX_KEEP_SANDBOX=true` overrides. The auto-delete interval is also set at
creation, so a sandbox cannot outlive a server that crashes mid-run.

**A considered diagnosis is never swallowed.** Walkthrough planning catches its
own failures and degrades to a plain recording, which is right for an unexpected
error and wrong for a deliberate one: the first version of the error-overlay check
threw a diagnosis straight into that catch, and the run continued to fail further
downstream with a less useful message. `DaytonaDeploymentError` is now re-thrown;
everything else still degrades.

**Repo recordings are not retried.** A repo run is provision, clone, apt,
install, build, start, scout, record. Its failures — a missing variable, a wrong
start command, a port that never opens — are deterministic, so a second attempt
spends another ten minutes and another sandbox to reach the same error and delays
the diagnostic. The URL path keeps its retry, where flakiness is real.

## Consequences

**Callers must supply configuration for anything non-trivial.** This is
inherent, and the failure now says so plainly instead of producing a slate.

**The values exist in the sandbox filesystem for the life of the run.** That is
the point — the app has to read them — and it is why the sandbox is single-tenant
and short-lived. `.env.local` is deleted with the sandbox.

**Large repositories can still exhaust a default sandbox.** This repository's own
`npm install` was OOM-killed at 137 on a real Daytona run — both concurrently and
sequentially. The error now names the cause, and `DAYTONA_SANDBOX_IMAGE` plus
`DAYTONA_SANDBOX_CPU` / `_MEMORY_GIB` / `_DISK_GIB` provide the lever, because
only image-based creation accepts a resource allocation. Unset, creation is
unchanged. The setup commands were made root-tolerant for the same reason —
`sudo` is absent from most base images, so hardcoding it would have made every
custom image fail on the first apt step.

**`PORT` and `HOST` cannot be overridden.** Deliberate, and the rejection message
points at `sandboxPort` instead.

## References

- ADR 0007 — recording the product rather than the landing page, which this is a
  prerequisite for.
- ADR 0005 — auth and usage limits, for the existing per-user caps on sandbox
  spend.
- `apps/server/src/security/appEnv.ts`, `apps/server/src/SandboxRecorder.ts`.
