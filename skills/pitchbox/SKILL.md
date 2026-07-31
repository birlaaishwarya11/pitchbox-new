---
name: pitchbox
description: Generate a narrated product demo video from a GitHub repo or a deployed URL using Pitchbox. Use when the user asks for a demo video, product walkthrough, launch video, screen recording with voiceover, or "show this off" for a codebase or web app. Also use for revising a demo script or checking on a video that is still rendering.
---

# Pitchbox — product demo videos

Pitchbox turns a codebase or a deployed URL into a narrated demo video: it reads
the project, plans a story, writes a script, records the app, generates a
voiceover, and fuses them into an MP4.

## Before you start

Pitchbox is **bring-your-own-keys**. The user pays for their own LLM and
voiceover usage, so keys must already be in the MCP server's environment — you
cannot supply them through tool arguments, by design.

If a tool reports a missing key, tell the user which environment variable to set
and where to get the key. Do not try to work around it.

If the `pitchbox_*` tools are not available at all, the MCP server is not
installed — point the user at `skills/pitchbox/INSTALL.md` in the Pitchbox repo
rather than attempting raw HTTP calls.

## The workflow

Pitchbox is deliberately a **two-step, human-approved** process. The script is
written first and cheaply; only after the user approves it does anything
expensive happen. Respect that — it is the whole point of the design.

### 1. Start

Call `pitchbox_start_video` with a `userPrompt` describing the video, plus one of:

- `githubUrl` — Pitchbox builds and screen-records the app in a sandbox. The
  richest result, but the slowest, and it counts against a daily limit.
- `recordUrl` — screen-records an already-deployed URL. Faster, no daily limit.
- `skipRecording: true` — voiceover over a branded slate. Fastest; good for a
  first pass or when there is nothing runnable to show.

Write the `userPrompt` yourself from what the user asked for, and make it
specific about **audience and length**: "90-second walkthrough of the checkout
flow, aimed at first-time users" beats "make a demo video".

If you are working in a repo and the user has not named one, use that repo's
GitHub remote — but say which one you are using.

### 2. Poll until there is a script

Call `pitchbox_status` until the status is `SCRIPT_DRAFT`. Stages take minutes;
leave a few seconds between polls rather than hammering it. If a stage reports
`failed`, report the message to the user instead of retrying blindly.

### 3. Show the script and stop

When the draft arrives, **show the full script to the user and wait.** Do not
approve on their behalf. Approving spends their API credits and, for repo
recording, consumes one of their limited daily runs.

- If they want changes, call `pitchbox_revise_script` with their feedback in
  their own words. Repeat as needed — revisions are cheap, approval is not.
- Only once they clearly approve, call `pitchbox_approve_script`.

### 4. Deliver

After approval, poll `pitchbox_status` until `READY`, then call
`pitchbox_get_video` and give the user the URL.

## Choosing recording mode

| Situation | Use |
|---|---|
| User wants the real app on screen and has a repo | `githubUrl` |
| App is already deployed somewhere public | `recordUrl` (faster, uncapped) |
| Just need the narration, or nothing runs yet | `skipRecording: true` |
| `pitchbox_capabilities` says sandbox recording is unavailable | `recordUrl` or `skipRecording` |

When a repo needs a non-obvious command to run, pass `appBuildCommand`,
`appStartCommand` and `sandboxPort` — check the repo's README or `package.json`
scripts rather than guessing, and say what you used.

## Handling failures

- **Key rejected** — the user's `PITCHBOX_API_KEY` is wrong or revoked. They
  generate a new one at `<web app>/settings/keys`.
- **Daily limit reached** — only sandbox (repo) recording is capped. Offer
  `recordUrl` or `skipRecording: true`, which are not.
- **Sandbox unavailable** — the server has no Daytona key. Repo recording is
  impossible there; use the alternatives.
- **Session expired** — sessions live about two hours and are lost if the server
  restarts. Start a new one; the old `sessionId` is not recoverable.

## What not to do

- Do not approve a script the user has not seen.
- Do not put API keys in tool arguments — they come from the environment only.
- Do not poll in a tight loop.
- Do not promise a video is ready until `pitchbox_get_video` has returned a URL.
