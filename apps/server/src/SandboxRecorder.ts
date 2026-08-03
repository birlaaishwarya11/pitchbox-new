import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { type Sandbox } from '@daytonaio/sdk';

import {
  DaytonaDeploymentError,
  DaytonaDeployer,
  type DeployFromGithubInput,
  type DeploymentResult,
} from './DaytonaDeployer';
import { type RecordingResult } from './Recorder';
import { getRemoteRecorderBundle } from './remoteRecorderBundle';
import { parseJsonObject as extractJsonObject } from './llm/jsonParse';
import type { Beat, SiteMap } from './cinematics/types';
import type { DummyIdentity } from './cinematics/dummyIdentity';
import { describeAppEnv } from './security/appEnv';

export interface SandboxRecordingRequest extends DeployFromGithubInput {
  appPort?: number;
  recordDurationMs?: number;
  appStartCommand?: string;
  appBuildCommand?: string;
  /**
   * Turn the scouted app into a timed walkthrough.
   *
   * Supplied by the caller rather than done here because directing needs the
   * run's LLM key, which lives on the server and must not enter the sandbox.
   * Returning null — or omitting this entirely — records without interaction.
   */
  planWalkthrough?: (siteMap: SiteMap) => Promise<{ beats: Beat[]; identity: DummyIdentity } | null>;
  /** Persona the in-sandbox scout fills forms with while exploring. */
  scoutIdentity?: DummyIdentity;
  /**
   * Environment the repo needs in order to boot — database URLs, publishable
   * keys, feature flags. Injected into the build and start commands and written
   * to `.env.local`, because a project that cannot start cannot be recorded.
   *
   * Secret. Only the names are ever logged or surfaced in an error.
   */
  appEnv?: Record<string, string>;
}

export interface SandboxRecordingResult {
  deployment: DeploymentResult;
  recording: RecordingResult;
  previewUrl: string;
}

const DEFAULT_APP_PORT = 3000;
const DEFAULT_RECORDING_DURATION_MS = 5_000;
// Generic defaults so arbitrary repos work: skip the build (most dev servers
// don't need one) and run the common dev script. Callers can override both.
const DEFAULT_BUILD_COMMAND = '';
const DEFAULT_START_COMMAND = 'npm run dev';
const PID_FILE = '/tmp/pitchbox-app.pid';
const APP_LOG_FILE = '/tmp/pitchbox-app.log';
const START_SCRIPT_FILE = '/tmp/pitchbox-start.sh';
const APP_STATUS_FILE = '/tmp/pitchbox-app.status';
const BUILD_SCRIPT_FILE = '/tmp/pitchbox-build.sh';
const STOP_SCRIPT_FILE = '/tmp/pitchbox-stop.sh';
/**
 * Where caller-supplied environment is written inside the repo.
 *
 * `.env.local` rather than `.env`: it is the Node convention for machine-local
 * overrides, it takes precedence in Next.js and Vite, and it is gitignored by
 * default — so writing it will not clobber something the repository committed.
 */
const APP_ENV_FILE = '.env.local';
const RECORDER_RUNTIME_DIR = '/tmp/pitchbox-recorder-runtime';
const RECORDER_SCRIPT_NAME = 'recorder.mjs';
const RECORDER_LOG_FILE = '/tmp/pitchbox-recorder.log';
const SITEMAP_FILE = '/tmp/pitchbox-sitemap.json';
const BEATS_FILE = '/tmp/pitchbox-beats.json';
const IDENTITY_FILE = '/tmp/pitchbox-identity.json';
const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');

/** Single-quote a value for a shell script, escaping any embedded quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Quote a value for a `.env` file.
 *
 * Single quotes by default, because `.env` loaders treat a single-quoted value as
 * literal — no escape processing, no `$VAR` expansion — so what the app reads is
 * byte-for-byte what was supplied. Double quotes are the fallback for a value
 * containing a single quote, and they are lossier: loaders disagree about which
 * escapes they honour and some expand `$VAR` inside them.
 *
 * This file is the secondary channel regardless. The authoritative one is the
 * shell-quoted `export` in the uploaded start script, which was verified against
 * a value containing a quote, a `$` and spaces and delivered it exactly.
 */
function quoteEnvValue(value: string): string {
  if (!value.includes("'") && !value.includes('\n')) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$/g, '\\$')}"`;
}

/**
 * Read an app's own complaint out of its log.
 *
 * Frameworks are unusually good at naming the variable they are missing, and
 * repeating that name back is far more actionable than any generic advice this
 * code could offer.
 */
function missingEnvHint(log: string): string | undefined {
  if (!log) return undefined;

  const patterns: RegExp[] = [
    // "Missing X", "X is required", "environment variable X is not defined", …
    /(?:missing|required|undefined|not set|not defined|invalid)[^\n]{0,40}?\b(?:env(?:ironment)?\s+variable\s+)?["'`]?([A-Z][A-Z0-9_]{3,})["'`]?/i,
    /\b([A-Z][A-Z0-9_]{3,})\b[^\n]{0,30}?(?:is (?:missing|required|not set|not defined)|must be (?:set|provided))/,
    /process\.env\.([A-Z][A-Z0-9_]{3,})/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(log);
    if (match?.[1]) return `the app reported a problem with ${match[1]}.`;
  }

  if (/EADDRINUSE/.test(log)) return 'the port was already in use inside the sandbox.';
  if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(log)) {
    return 'a dependency was missing — the project may need a build step (`appBuildCommand`).';
  }
  if (/ECONNREFUSED|getaddrinfo|ENOTFOUND/.test(log)) {
    return 'the app could not reach a service it depends on, such as a database.';
  }
  return undefined;
}

/**
 * Run a command in the sandbox and fail if it fails.
 *
 * `sandbox.process.executeCommand` resolves for a non-zero exit — it reports the
 * code rather than throwing — and only the deployer's setup steps ever checked
 * it. Every other command in this file was therefore fire-and-forget: a failed
 * build, a start command that never launched, and most damagingly a readiness
 * loop that timed out all returned as success and the run carried on to fail
 * somewhere less informative.
 *
 * That is why a repo whose app never started reported "a browser could not load
 * the page" instead of "your start command exited immediately, here is what it
 * said".
 */
async function exec(
  sandbox: Sandbox,
  label: string,
  command: string,
  options: { cwd?: string; env?: Record<string, string>; timeoutSec?: number; allowFailure?: boolean } = {},
): Promise<{ exitCode: number; output: string }> {
  const execution = await sandbox.process.executeCommand(
    command,
    options.cwd,
    options.env,
    options.timeoutSec ?? 120,
  );
  const exitCode = execution.exitCode ?? 0;
  const output = ((execution as any)?.artifacts?.stdout ?? execution.result ?? '').toString();

  if (exitCode !== 0 && !options.allowFailure) {
    const tail = output.trim().split(/\r?\n/).slice(-25).join('\n');
    throw new DaytonaDeploymentError(
      'SANDBOX_SETUP_FAILED',
      [
        `${label} failed inside the sandbox (exit ${exitCode}).`,
        exitCode === 137 ? 'It was killed, which almost always means the sandbox ran out of memory.' : undefined,
        tail ? `Output:\n${tail}` : 'It produced no output.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  return { exitCode, output };
}

export class SandboxRecorder {
  constructor(private readonly deployer: DaytonaDeployer) {}

  async recordRepository(request: SandboxRecordingRequest): Promise<SandboxRecordingResult> {
    const appEnv = request.appEnv ?? {};
    console.log(`[sandbox] app environment supplied: ${describeAppEnv(appEnv)}`);

    // Set on the sandbox itself as well as on the individual commands: a dev
    // server spawns children, and inheriting from the sandbox is the only way
    // every process ends up with the same configuration.
    const deployment = await this.deployer.deployFromGithub({ ...request, envVars: appEnv });
    const sandbox = await this.deployer.getSandboxById(deployment.sandboxId);
    const repoPath = deployment.repoPath;
    const appPort = request.appPort ?? DEFAULT_APP_PORT;
    console.log(`[sandbox ${sandbox.id}] recording ${deployment.githubUrl} at ${repoPath}`);

    await this.writeAppEnvFile(sandbox, repoPath, appEnv);
    await this.buildAppInSandbox(sandbox, repoPath, request.appBuildCommand, appEnv);

    // Before the app is started, deliberately.
    //
    // This installs Puppeteer, which is a heavy install, and it used to run
    // after the app was already up. On a small sandbox the two together exceed
    // the memory limit, and the OOM killer takes the largest process — the dev
    // server. The readiness check had already passed by then, so the app looked
    // healthy and then silently vanished; the browser could not connect, and the
    // app log was empty because a SIGKILLed process loses its buffered stdout.
    // Nothing depends on the app being up here, so it simply goes first.
    await this.prepareRecorderRuntime(sandbox);

    await this.startAppInSandbox(sandbox, repoPath, appPort, request.appStartCommand, appEnv);

    try {
      await this.waitForLocalHttp(sandbox, appPort, appEnv);
      const preview = await sandbox.getPreviewLink(appPort);
      // The recorder runs INSIDE the sandbox, so it records the app over
      // localhost — the external preview proxy URL is for outside access and is
      // not reliably reachable from within the sandbox.
      const localUrl = `http://127.0.0.1:${appPort}`;
      const walkthrough = await this.planWalkthroughInSandbox(sandbox, localUrl, request);
      const remoteRecording = await this.captureRecordingInSandbox(
        sandbox,
        localUrl,
        request.recordDurationMs ?? DEFAULT_RECORDING_DURATION_MS,
        walkthrough,
      );
      const recording = await this.persistSandboxRecording(sandbox, remoteRecording);

      await this.stopAppInSandbox(sandbox);
      // Nothing left to learn from a sandbox whose recording came back, and one
      // left running bills the operator indefinitely. There was no cleanup here
      // at all, which is why the account has a decade of stale sandboxes in it.
      await this.disposeSandbox(sandbox, 'succeeded');

      return {
        deployment,
        recording,
        previewUrl: preview.url,
      };
    } catch (error) {
      await this.stopAppInSandbox(sandbox);
      // Kept alive briefly on failure, because this is exactly when someone
      // wants to look inside it. The id is logged so they can.
      await this.disposeSandbox(sandbox, 'failed');
      console.warn(
        `[sandbox ${sandbox.id}] recording failed. App log: ${APP_LOG_FILE}, recorder log: ${RECORDER_LOG_FILE}.`,
      );
      throw error;
    }
  }

  /**
   * Release a sandbox once its run is over.
   *
   * Deleted outright on success. On failure it is kept for a window instead, so
   * the app log inside it can still be read, then auto-deleted so a bad run does
   * not become a permanent line on the bill. `PITCHBOX_KEEP_SANDBOX=true` keeps
   * everything, for when a run needs taking apart by hand.
   */
  private async disposeSandbox(sandbox: Sandbox, outcome: 'succeeded' | 'failed'): Promise<void> {
    if (process.env.PITCHBOX_KEEP_SANDBOX === 'true') {
      console.log(`[sandbox ${sandbox.id}] kept (PITCHBOX_KEEP_SANDBOX=true), run ${outcome}.`);
      return;
    }

    if (outcome === 'failed') {
      const keepMinutes = Number.parseInt(process.env.PITCHBOX_FAILED_SANDBOX_TTL_MIN ?? '60', 10) || 60;
      try {
        await sandbox.setAutoDeleteInterval(keepMinutes);
        console.log(`[sandbox ${sandbox.id}] kept for ${keepMinutes}m for inspection, then auto-deleted.`);
        return;
      } catch (error) {
        console.warn(`[sandbox ${sandbox.id}] could not set an auto-delete interval:`, error);
      }
    }

    try {
      await sandbox.delete();
      console.log(`[sandbox ${sandbox.id}] deleted.`);
    } catch (error) {
      console.warn(`[sandbox ${sandbox.id}] could not be deleted — it may keep billing:`, error);
    }
  }

  /**
   * Write caller-supplied environment into the repo.
   *
   * Passing the variables to the build and start commands covers anything that
   * reads `process.env`, but a framework that only loads `.env` files — or a
   * child process the dev server spawns — sees nothing. Writing the file too is
   * what makes `next dev` and `vite` actually pick them up.
   *
   * Uploaded as a file rather than echoed through a shell: a secret containing a
   * quote or a `$` would otherwise be mangled or, worse, expanded.
   */
  private async writeAppEnvFile(
    sandbox: Sandbox,
    repoPath: string,
    appEnv: Record<string, string>,
  ): Promise<void> {
    const names = Object.keys(appEnv);
    if (!names.length) return;

    const body = names.map((name) => `${name}=${quoteEnvValue(appEnv[name])}`).join('\n');
    const remotePath = path.posix.join(repoPath, APP_ENV_FILE);
    try {
      await sandbox.fs.uploadFile(Buffer.from(`${body}\n`, 'utf-8'), remotePath);
      console.log(`[sandbox] wrote ${names.length} variable(s) to ${APP_ENV_FILE}`);
    } catch (error) {
      // Not fatal: the same values still reach the process environment below.
      console.warn(`[sandbox] could not write ${APP_ENV_FILE}; relying on the process environment only:`, error);
    }
  }

  private async buildAppInSandbox(
    sandbox: Sandbox,
    repoPath: string,
    appBuildCommand: string | undefined,
    appEnv: Record<string, string>,
  ): Promise<void> {
    const command = appBuildCommand ?? DEFAULT_BUILD_COMMAND;
    const trimmed = command.trim();

    if (!trimmed) {
      return;
    }

    // A file, and quoted exports, for exactly the same reasons as the start
    // command: neither the build command nor its environment survives being
    // spliced into a shell string.
    const buildBody = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      // Executed with the working directory already set to the repo — see the
      // start script for why this must not `cd` again.
      ...Object.entries(appEnv).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
      trimmed,
      '',
    ].join('\n');

    try {
      await sandbox.fs.uploadFile(Buffer.from(buildBody, 'utf-8'), BUILD_SCRIPT_FILE);
      await exec(sandbox, `The build command \`${trimmed}\``, `bash ${BUILD_SCRIPT_FILE}`, {
        cwd: repoPath,
        timeoutSec: 600,
      });
    } catch (error) {
      if (error instanceof DaytonaDeploymentError) throw error;
      throw new DaytonaDeploymentError(
        'SANDBOX_SETUP_FAILED',
        `Failed to build the app inside the sandbox with \`${trimmed}\`. ` +
          `Environment supplied: ${describeAppEnv(appEnv)}.`,
        error,
      );
    }
  }

  private async startAppInSandbox(
    sandbox: Sandbox,
    repoPath: string,
    port: number,
    appStartCommand: string | undefined,
    appEnv: Record<string, string>,
  ): Promise<void> {
    const command = appStartCommand ?? DEFAULT_START_COMMAND;

    // Uploaded as a script rather than nested inside `bash -lc '…'`.
    //
    // The previous form built one long single-quoted string containing a
    // background `&` and a redirect and handed it to the sandbox to run. That
    // quoting does not survive the trip: it came back as
    // `sh: 1: Syntax error: Unterminated quoted string`, meaning the app was
    // never actually started on this path at all. Nobody noticed, because the
    // exit code was not checked — the readiness loop simply failed quietly for
    // its full two minutes afterwards and the run carried on regardless.
    //
    // A file has no quoting to survive: the command to run becomes one token.
    const startBody = [
      '#!/usr/bin/env bash',
      // No `-e`: the failure that matters is the app dying, and that is checked
      // explicitly below rather than by aborting this wrapper.
      'set -u',
      // No `cd`: the command below is executed with its working directory
      // already set to the repo. `repoPath` is relative to the sandbox home, so
      // cd'ing to it from inside itself looked for a nested copy and failed.
      `export PORT=${port} VITE_PORT=${port} HOST=0.0.0.0`,
      // Exported here, with proper quoting, rather than handed to the sandbox as
      // an env map. Daytona interpolates those values into a shell command
      // without quoting them, so a credential containing a quote, a `$` or a
      // space — which real credentials routinely do — breaks the command itself:
      // `sh: 1: Syntax error: Unterminated quoted string`, and the app never
      // starts. A quoted `export` in a file has no such problem.
      ...Object.entries(appEnv).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
      `nohup ${command} >${APP_LOG_FILE} 2>&1 &`,
      `echo $! > ${PID_FILE}`,
      // The liveness probe lives here rather than in a follow-up command, for
      // the same reason as the rest of this script: a probe built out of nested
      // quotes can fail to parse, and a probe that fails to parse would report a
      // healthy app as dead. Reading a file back has no quoting at all.
      'sleep 3',
      `if kill -0 "$(cat ${PID_FILE})" 2>/dev/null; then`,
      `  echo alive > ${APP_STATUS_FILE}`,
      'else',
      `  echo dead > ${APP_STATUS_FILE}`,
      'fi',
      '',
    ].join('\n');

    try {
      await sandbox.fs.uploadFile(Buffer.from(startBody, 'utf-8'), START_SCRIPT_FILE);
      // Caller values first, then ours: PORT and HOST are the contract the
      // recorder relies on to find the app, so they win. `parseAppEnv` already
      // refuses those names, and this makes the precedence explicit anyway.
      // No `env` here on purpose — see the exports in the script above.
      await exec(sandbox, `The start command \`${command}\``, `bash ${START_SCRIPT_FILE}`, {
        cwd: repoPath,
        timeoutSec: 120,
      });
    } catch (error) {
      if (error instanceof DaytonaDeploymentError) throw error;
      throw new DaytonaDeploymentError(
        'SANDBOX_SETUP_FAILED',
        `Failed to start the app inside the sandbox with \`${command}\`. ` +
          `Environment supplied: ${describeAppEnv(appEnv)}.`,
        error,
      );
    }

    // The command is backgrounded, so its exit code says nothing about whether
    // the app actually launched — a missing binary or an instant crash both look
    // like success. The script above recorded whether the process was still
    // there three seconds later, because "your start command exited immediately,
    // here is what it printed" is the single most useful thing to say when it did.
    const status = await this.readSandboxFile(sandbox, APP_STATUS_FILE);

    if (!/alive/.test(status)) {
      const tail = await this.appLogTail(sandbox, 30);
      const hint = missingEnvHint(tail);
      throw new DaytonaDeploymentError(
        'SANDBOX_SETUP_FAILED',
        [
          `The app exited immediately after starting with \`${command}\`.`,
          `Environment supplied: ${describeAppEnv(appEnv)}.`,
          hint ? `Likely cause: ${hint}` : undefined,
          tail
            ? `What it printed before exiting:\n${tail}`
            : 'It printed nothing at all, which usually means the command itself could not be run — ' +
              'check that the script exists in package.json and that its binary was installed.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }
  }

  /**
   * Wait for the app to answer on its port, and explain properly if it never
   * does.
   *
   * This is the failure that actually happens to people, and it used to report
   * nothing but "App did not become ready inside Daytona sandbox." — true, and
   * useless. Almost every instance is a missing environment variable, and the
   * app has already said so in its own log. So the log tail comes back with the
   * error, along with the names that were supplied, which together turn a dead
   * end into an obvious fix.
   */
  private async waitForLocalHttp(
    sandbox: Sandbox,
    port: number,
    appEnv: Record<string, string>,
  ): Promise<void> {
    const waitScript = [
      'bash -lc',
      `'set -euo pipefail; for attempt in {1..60}; do if curl -fsS http://127.0.0.1:${port} >/dev/null 2>&1; then exit 0; fi; sleep 2; done; exit 1'`,
    ].join(' ');

    // `allowFailure` because the non-zero exit *is* the signal here, and this
    // needs to report the app's log rather than the curl loop's silence.
    const { exitCode } = await exec(sandbox, 'The readiness check', waitScript, {
      timeoutSec: 180,
      allowFailure: true,
    });
    if (exitCode === 0) return;

    {
      const log = await this.readSandboxFile(sandbox, APP_LOG_FILE);
      const tail = log.trim().split(/\r?\n/).slice(-40).join('\n');
      const hint = missingEnvHint(log);

      throw new DaytonaDeploymentError(
        'SANDBOX_SETUP_FAILED',
        [
          `The app never answered on port ${port} within 120s, so there was nothing to record.`,
          `Environment supplied: ${describeAppEnv(appEnv)}.`,
          hint ? `Likely cause: ${hint}` : undefined,
          tail ? `Last lines of the app log:\n${tail}` : 'The app log was empty — the start command may have exited immediately.',
          'Fix by passing the variables the project needs as `appEnv`, or correcting `appStartCommand` / `sandboxPort`.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }
  }

  /**
   * Stop the app. Uploaded as a script, like the others.
   *
   * This was the last place still nesting quotes inside `bash -lc '…'`, which is
   * the construction that silently failed for the start command. It matters less
   * here — a sandbox that is about to be deleted takes the process with it — but
   * a failed run keeps its sandbox for an hour, and leaving a dev server running
   * in it for no reason is exactly the kind of waste this pass was about.
   */
  private async stopAppInSandbox(sandbox: Sandbox): Promise<void> {
    const body = [
      '#!/usr/bin/env bash',
      `if [ -f ${PID_FILE} ]; then`,
      `  kill "$(cat ${PID_FILE})" 2>/dev/null || true`,
      `  rm -f ${PID_FILE}`,
      'fi',
      'exit 0',
      '',
    ].join('\n');

    try {
      await sandbox.fs.uploadFile(Buffer.from(body, 'utf-8'), STOP_SCRIPT_FILE);
      await exec(sandbox, 'Stopping the app', `bash ${STOP_SCRIPT_FILE}`, {
        timeoutSec: 30,
        allowFailure: true,
      });
    } catch (error) {
      console.warn('Failed to stop sandbox app process', error);
    }
  }

  /**
   * Scout the app from inside the sandbox, then let the caller direct it.
   *
   * Scouting happens in here rather than against the public preview URL for two
   * reasons: a private sandbox's preview needs an access token, and the app is
   * reachable on plain localhost from this side anyway.
   *
   * Any failure returns undefined and the recording proceeds without a
   * walkthrough — a worse video than it could have been, but the same one this
   * path produced before, which is the right thing to fall back to.
   */
  private async planWalkthroughInSandbox(
    sandbox: Sandbox,
    localUrl: string,
    request: SandboxRecordingRequest,
  ): Promise<{ beats: Beat[]; identity: DummyIdentity } | undefined> {
    if (!request.planWalkthrough || !request.scoutIdentity) return undefined;

    try {
      await sandbox.fs.uploadFile(
        Buffer.from(JSON.stringify(request.scoutIdentity), 'utf-8'),
        IDENTITY_FILE,
      );
      await sandbox.process.executeCommand(
        `node ${RECORDER_SCRIPT_NAME}`,
        RECORDER_RUNTIME_DIR,
        {
          RECORDER_MODE: 'scout',
          // Scouting takes no frames, so the capture mode is irrelevant here.
          RECORDER_CAPTURE_MODE: 'screenshot',
          PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
          RECORDER_TARGET_URL: localUrl,
          RECORDER_SITEMAP_PATH: SITEMAP_FILE,
          RECORDER_IDENTITY_PATH: IDENTITY_FILE,
          RECORDER_LOG_PATH: RECORDER_LOG_FILE,
        },
        300,
      );

      const raw = await this.readSandboxFile(sandbox, SITEMAP_FILE);
      const siteMap = raw ? (JSON.parse(raw) as SiteMap) : undefined;

      // The app answered on its port but rendered its own crash report. There
      // is no point recording that, and the overlay text is the most useful
      // thing anyone gets out of this run — so fail loudly with it rather than
      // shipping a 40-second video of a stack trace.
      if (siteMap?.appError) {
        throw new DaytonaDeploymentError(
          'SANDBOX_SETUP_FAILED',
          [
            'The app started and answered on its port, but the page is an application error, not the app.',
            `Environment supplied: ${describeAppEnv(request.appEnv ?? {})}.`,
            `What the page said:\n${siteMap.appError}`,
            'A dev server returns HTTP 200 while rendering this, which is why the readiness check passed.',
            'Most often this is a missing environment variable — pass what the project needs as `appEnv`.',
          ].join('\n\n'),
        );
      }

      if (!siteMap?.screens?.length) {
        // Not a degraded walkthrough — the scout could not load the entry page
        // at all, which means the recorder is about to fail on the same page.
        // Failing here, with the app's log, beats failing there without it.
        const tail = await this.appLogTail(sandbox);
        throw new DaytonaDeploymentError(
          'SANDBOX_SETUP_FAILED',
          [
            `The app answered the readiness check but a browser could not load ${localUrl}.`,
            `Environment supplied: ${describeAppEnv(request.appEnv ?? {})}.`,
            `Scout notes: ${siteMap?.notes?.join(' | ') || 'none'}`,
            tail
              ? `Last lines of the app log:\n${tail}`
              : 'The app log is empty — the start command may have exited immediately.',
            'The app most likely started, answered once, then exited. Check `appStartCommand` and `sandboxPort`.',
          ].join('\n\n'),
        );
      }

      const planned = await request.planWalkthrough(siteMap);
      if (!planned?.beats.length) return undefined;

      await sandbox.fs.uploadFile(Buffer.from(JSON.stringify(planned.beats), 'utf-8'), BEATS_FILE);
      await sandbox.fs.uploadFile(Buffer.from(JSON.stringify(planned.identity), 'utf-8'), IDENTITY_FILE);
      return planned;
    } catch (error) {
      // A DaytonaDeploymentError raised in here is a considered diagnosis — the
      // app is showing an error page, or a browser cannot reach it at all — and
      // recording anyway would bury it under a less useful downstream failure.
      // Only genuinely unexpected problems degrade to a plain recording.
      if (error instanceof DaytonaDeploymentError) throw error;
      console.warn('[sandbox] walkthrough planning failed; recording without one:', error);
      return undefined;
    }
  }

  private async captureRecordingInSandbox(
    sandbox: Sandbox,
    previewUrl: string,
    recordDurationMs: number,
    walkthrough?: { beats: Beat[]; identity: DummyIdentity },
  ): Promise<RecordingResult> {
    const duration = Math.max(1_000, recordDurationMs);

    const execution = await sandbox.process.executeCommand(
      `node ${RECORDER_SCRIPT_NAME}`,
      RECORDER_RUNTIME_DIR,
      {
        // X11 capture, not headless screenshots.
        //
        // `page.screenshot` hangs indefinitely in this sandbox — both compositor
        // and renderer strategies, every frame, while the same Chromium navigates
        // and runs scripts fine. ffmpeg grabbing the X display never asks the
        // browser for a frame, so it sidesteps the problem entirely. Xvfb is
        // already installed during sandbox setup for exactly this.
        RECORDER_CAPTURE_MODE: 'xvfb',
        RECORDER_ENABLE_XVFB: 'true',
        PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
        RECORDER_TARGET_URL: previewUrl,
        RECORDER_DURATION_MS: `${duration}`,
        RECORDER_LOG_PATH: RECORDER_LOG_FILE,
        ...(walkthrough
          ? { RECORDER_BEATS_PATH: BEATS_FILE, RECORDER_IDENTITY_PATH: IDENTITY_FILE }
          : {}),
      },
      900,
    );

    const stdout = (execution.artifacts?.stdout ?? execution.result ?? '').trim();
    const parsed = extractJsonObject(stdout);
    if (parsed) {
      return this.reviveRecording(parsed);
    }

    // Parsing failed — surface the real reason from the sandbox for diagnosis.
    // The app's log is included because the commonest cause of a recorder that
    // cannot navigate is an app that stopped serving, and that fact lives in the
    // app's log rather than the recorder's.
    const stderr = (execution as any)?.artifacts?.stderr ?? '';
    const exitCode = (execution as any)?.exitCode;
    const log = await this.readSandboxFile(sandbox, RECORDER_LOG_FILE);
    const appTail = await this.appLogTail(sandbox, 30);
    const detail = [
      `exitCode=${exitCode}`,
      stdout ? `recorder stdout=${stdout.slice(0, 800)}` : 'recorder stdout=<empty>',
      stderr ? `recorder stderr=${String(stderr).slice(-800)}` : '',
      log ? `recorder log=${log.slice(-800)}` : '',
      appTail ? `app log:\n${appTail}` : 'app log=<empty>',
    ]
      .filter(Boolean)
      .join('\n');
    throw new DaytonaDeploymentError(
      'SANDBOX_SETUP_FAILED',
      `In-sandbox recorder did not return a recording.\n${detail}`,
    );
  }

  /**
   * The tail of the app's own log, fetched at the moment of failure.
   *
   * Timing is the whole point. Daytona stops an idle sandbox and `/tmp` is a
   * tmpfs, so by the time anyone opens the sandbox to look, the log is gone —
   * a failed run kept for inspection had nothing left to inspect. Reading it
   * here, while the sandbox is still warm, is the only reliable moment.
   */
  private async appLogTail(sandbox: Sandbox, lines = 40): Promise<string> {
    const log = await this.readSandboxFile(sandbox, APP_LOG_FILE);
    if (!log.trim()) return '';
    return log.trim().split(/\r?\n/).slice(-lines).join('\n');
  }

  private async readSandboxFile(sandbox: Sandbox, remotePath: string): Promise<string> {
    try {
      const buf = await sandbox.fs.downloadFile(remotePath);
      return buf.toString('utf-8');
    } catch {
      return '';
    }
  }

  private reviveRecording(payload: RecordingResult): RecordingResult {
    return {
      ...payload,
      startedAt: new Date(payload.startedAt),
      endedAt: new Date(payload.endedAt),
    };
  }

  private async persistSandboxRecording(
    sandbox: Sandbox,
    remoteRecording: RecordingResult,
  ): Promise<RecordingResult> {
    const remotePath = remoteRecording.localPath;
    const buffer = await sandbox.fs.downloadFile(remotePath);
    const localPath = await this.writeRecordingFile(remoteRecording.sessionId, buffer);

    await sandbox.fs.deleteFile(remotePath, false).catch(() => undefined);

    return {
      ...remoteRecording,
      localPath,
      storage: {
        type: 'local',
        uri: localPath,
        metadata: remoteRecording.storage?.metadata,
      },
    };
  }

  private async writeRecordingFile(sessionId: string, buffer: Buffer): Promise<string> {
    const sessionDir = path.join(RECORDINGS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const destination = path.join(sessionDir, `${sessionId}.mp4`);
    await writeFile(destination, buffer);
    return destination;
  }

  private async prepareRecorderRuntime(sandbox: Sandbox): Promise<void> {
    await exec(sandbox, 'Creating the recorder runtime directory', `mkdir -p ${RECORDER_RUNTIME_DIR}`, {
      timeoutSec: 30,
    });
    await this.installRecorderDependencies(sandbox);
    await this.uploadRecorderScript(sandbox);
  }

  private async installRecorderDependencies(sandbox: Sandbox): Promise<void> {
    // Skip Puppeteer's bundled-Chromium download — we use the system Chromium
    // installed during sandbox setup (its libraries are guaranteed present).
    const installScript = [
      'bash -lc',
      `'cd ${RECORDER_RUNTIME_DIR} && set -euo pipefail; ` +
        'export PUPPETEER_SKIP_DOWNLOAD=true; ' +
        'if [ ! -f package.json ]; then npm init -y >/dev/null 2>&1; fi; ' +
        'npm install --silent puppeteer xvfb' +
        "'",
    ].join(' ');

    await exec(sandbox, "Installing the recorder's own dependencies", installScript, { timeoutSec: 600 });
  }

  private async uploadRecorderScript(sandbox: Sandbox): Promise<void> {
    const bundle = await getRemoteRecorderBundle();
    const remotePath = path.posix.join(RECORDER_RUNTIME_DIR, RECORDER_SCRIPT_NAME);
    await sandbox.fs.uploadFile(Buffer.from(bundle, 'utf-8'), remotePath);
  }
}

