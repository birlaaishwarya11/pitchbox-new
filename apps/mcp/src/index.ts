#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CLIENT_NAME, CLIENT_VERSION, ConfigError, loadConfig } from './config';
import { PitchboxApiError, PitchboxClient } from './pitchboxClient';

/**
 * Pitchbox as an MCP server: generate a product demo video from an editor or
 * chat client, without opening the web UI.
 *
 * NOTE ON stdout: the stdio transport uses stdout for the protocol itself, so
 * nothing here may `console.log`. Diagnostics go to stderr only — a stray log
 * line corrupts the JSON-RPC stream and the client disconnects with a parse
 * error that is genuinely hard to trace back.
 */

const log = (msg: string) => process.stderr.write(`[${CLIENT_NAME}] ${msg}\n`);

/** Wrap a handler so failures come back as readable text, not a transport error. */
function toolResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

async function main(): Promise<void> {
  let client: PitchboxClient;
  try {
    client = new PitchboxClient(loadConfig());
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`configuration error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const server = new McpServer({ name: CLIENT_NAME, version: CLIENT_VERSION });

  // --- capabilities -------------------------------------------------------
  server.registerTool(
    'pitchbox_capabilities',
    {
      title: 'Check Pitchbox capabilities',
      description:
        'Show which LLM providers/models this Pitchbox server accepts and whether repo (sandbox) recording is available. ' +
        'Call this first if a video request fails, to find out what the server supports.',
      inputSchema: {},
    },
    async () => {
      try {
        const info = await client.listProviders();
        const lines = [
          `Sandbox (GitHub repo) recording: ${info.hasSandboxRecording ? 'available' : 'NOT available'}`,
          `Server-provided voice key: ${info.hasServerAudio ? 'yes' : 'no — you must set ELEVENLABS_API_KEY'}`,
          `Server-provided LLM key: ${info.hasServerDefault ? 'yes' : 'no — you must set PITCHBOX_LLM_*'}`,
          '',
          'Providers:',
          ...info.providers.map(
            (p) => `  ${p.id}${p.free ? ' (free tier)' : ''} — models: ${p.models.map((m) => m.id).join(', ')}`,
          ),
        ];
        return toolResult(lines.join('\n'));
      } catch (e) {
        return toolResult(e instanceof PitchboxApiError ? e.message : String(e), true);
      }
    },
  );

  // --- start --------------------------------------------------------------
  server.registerTool(
    'pitchbox_start_video',
    {
      title: 'Start a demo video',
      description:
        'Start generating a product demo video. Give either a GitHub repo URL (Pitchbox builds and screen-records it in a ' +
        'sandbox) or a deployed URL to record, plus a prompt describing the video you want. ' +
        'This returns immediately with a sessionId — the script is written in the background. ' +
        'Poll pitchbox_status until the status is SCRIPT_DRAFT, then review the script with the user before approving it.',
      inputSchema: {
        userPrompt: z
          .string()
          .describe('What the video should cover and who it is for, e.g. "90s walkthrough of the checkout flow for new users".'),
        githubUrl: z.string().optional().describe('GitHub repo to analyse and record. Requires sandbox recording on the server.'),
        recordUrl: z.string().optional().describe('A deployed/public URL to screen-record instead of a repo.'),
        branch: z.string().optional().describe('Branch to use with githubUrl.'),
        targetDurationSec: z.number().optional().describe('Target video length in seconds (default 90).'),
        skipRecording: z
          .boolean()
          .optional()
          .describe('Generate voiceover over a branded slate instead of a screen recording. Much faster.'),
        appStartCommand: z.string().optional().describe('Command that starts the app in the sandbox, e.g. "npm run dev".'),
        appBuildCommand: z.string().optional().describe('Build command to run before starting the app.'),
        sandboxPort: z.number().optional().describe('Port the app listens on inside the sandbox.'),
      },
    },
    async (args) => {
      if (!args.githubUrl && !args.recordUrl && !args.skipRecording) {
        return toolResult(
          'Provide githubUrl or recordUrl, or set skipRecording: true to generate a voiceover-only video.',
          true,
        );
      }
      try {
        const res = await client.startPipeline(args);
        return toolResult(
          [
            `Started. sessionId: ${res.sessionId}`,
            `Status: ${res.status}`,
            '',
            'The plan, research and first script draft are being generated now.',
            `Call pitchbox_status with sessionId "${res.sessionId}" until status is SCRIPT_DRAFT, then show the script to the user.`,
          ].join('\n'),
        );
      } catch (e) {
        return toolResult(e instanceof PitchboxApiError ? e.message : String(e), true);
      }
    },
  );

  // --- status -------------------------------------------------------------
  server.registerTool(
    'pitchbox_status',
    {
      title: 'Check video progress',
      description:
        'Check a Pitchbox session: current stage, any errors, and the latest script draft once it exists. ' +
        'Poll this after starting a video or approving a script. Stages can take minutes — space polls a few seconds apart.',
      inputSchema: { sessionId: z.string().describe('The sessionId returned by pitchbox_start_video.') },
    },
    async ({ sessionId }) => {
      try {
        const s = await client.status(sessionId);
        const stages = (s.stages ?? [])
          .map((st: any) => `  ${st.id}: ${st.status}${st.message ? ` — ${st.message}` : ''}`)
          .join('\n');
        const latest = (s.scriptVersions ?? [])[(s.scriptVersions?.length ?? 0) - 1];

        const parts = [`Status: ${s.status}`, stages ? `Stages:\n${stages}` : ''];
        if (s.error) parts.push(`Error: ${s.error}`);
        if (latest) {
          parts.push(
            '',
            `Script draft v${s.scriptVersions.length} (~${latest.estimatedDurationSec}s, ${latest.wordCount} words):`,
            latest.fullScript,
            '',
            'If the user is happy, call pitchbox_approve_script. Otherwise call pitchbox_revise_script with their feedback.',
          );
        }
        if (s.status === 'READY') parts.push('', 'Video is ready — call pitchbox_get_video.');
        return toolResult(parts.filter(Boolean).join('\n'));
      } catch (e) {
        return toolResult(e instanceof PitchboxApiError ? e.message : String(e), true);
      }
    },
  );

  // --- revise -------------------------------------------------------------
  server.registerTool(
    'pitchbox_revise_script',
    {
      title: 'Revise the script',
      description:
        'Rewrite the current script using the user\'s feedback, producing a new version. ' +
        'Use this before approving — once approved, the voiceover is generated and changes cost another run.',
      inputSchema: {
        sessionId: z.string(),
        feedback: z.string().describe('What to change, in the user\'s own words, e.g. "less jargon, mention pricing".'),
      },
    },
    async ({ sessionId, feedback }) => {
      try {
        const res = await client.feedback(sessionId, feedback);
        const v = res.version ?? {};
        return toolResult(
          [`New script version (~${v.estimatedDurationSec}s, ${v.wordCount} words):`, '', v.fullScript ?? ''].join('\n'),
        );
      } catch (e) {
        return toolResult(e instanceof PitchboxApiError ? e.message : String(e), true);
      }
    },
  );

  // --- approve ------------------------------------------------------------
  server.registerTool(
    'pitchbox_approve_script',
    {
      title: 'Approve the script and build the video',
      description:
        'Approve the current script and start the media stage: voiceover (billed to your ElevenLabs key) and, unless ' +
        'skipped, a screen recording. ONLY call this once the user has actually seen and approved the script — it spends ' +
        'the user\'s API credits and, for repo recording, counts against a daily limit.',
      inputSchema: {
        sessionId: z.string(),
        skipRecording: z
          .boolean()
          .optional()
          .describe('Skip the screen recording and use a branded slate instead. Faster and avoids the daily limit.'),
      },
    },
    async ({ sessionId, skipRecording }) => {
      try {
        await client.approve(sessionId, skipRecording === true);
        return toolResult(
          [
            'Approved. Generating voiceover' + (skipRecording ? ' over a slate.' : ' and screen recording.'),
            `Poll pitchbox_status with sessionId "${sessionId}" until status is READY, then call pitchbox_get_video.`,
          ].join('\n'),
        );
      } catch (e) {
        return toolResult(e instanceof PitchboxApiError ? e.message : String(e), true);
      }
    },
  );

  // --- result -------------------------------------------------------------
  server.registerTool(
    'pitchbox_get_video',
    {
      title: 'Get the finished video',
      description: 'Fetch the URL of the finished video once the session status is READY.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      try {
        const r = await client.result(sessionId);
        const final = client.absoluteUrl(r.finalVideo?.url) ?? client.absoluteUrl(r.audio?.url);
        if (!final) return toolResult('The session reports ready but returned no media URL.', true);
        return toolResult(
          [
            `Video ready: ${final}`,
            r.audio?.url ? `Audio only: ${client.absoluteUrl(r.audio.url)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } catch (e) {
        if (e instanceof PitchboxApiError && e.status === 409) {
          return toolResult('Not finished yet — keep polling pitchbox_status until it reports READY.', true);
        }
        return toolResult(e instanceof PitchboxApiError ? e.message : String(e), true);
      }
    },
  );

  await server.connect(new StdioServerTransport());
  log(`ready (v${CLIENT_VERSION})`);
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
