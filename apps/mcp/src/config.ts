/**
 * Configuration for the Pitchbox MCP server, read once from the environment.
 *
 * MCP servers are launched by the client (Claude Code / Claude Desktop) from a
 * static JSON config, so environment variables are the only channel available —
 * there is no interactive prompt and no place to store state between runs.
 *
 * Every key here stays in this process and is forwarded per-request. Nothing is
 * written to disk, and nothing is logged.
 */

export interface PitchboxConfig {
  serverBase: string;
  apiKey: string;
  llm?: { provider: string; apiKey: string; model: string };
  elevenLabsApiKey?: string;
}

export const CLIENT_NAME = 'pitchbox-mcp';
export const CLIENT_VERSION = '0.1.0';

/** Thrown for configuration problems that the user must fix in their MCP config. */
export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PitchboxConfig {
  const apiKey = env.PITCHBOX_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      'PITCHBOX_API_KEY is not set. Create a key at <your Pitchbox web app>/settings/keys and add it to your MCP config.',
    );
  }

  const serverBase = (env.PITCHBOX_SERVER_BASE?.trim() || 'http://localhost:3001').replace(/\/+$/, '');

  // Bring-your-own LLM. Only used when all three parts are present; a partial
  // config is a user mistake worth surfacing rather than silently ignoring.
  const provider = env.PITCHBOX_LLM_PROVIDER?.trim();
  const llmKey = env.PITCHBOX_LLM_KEY?.trim();
  const model = env.PITCHBOX_LLM_MODEL?.trim();
  const partial = [provider, llmKey, model].filter(Boolean).length;
  if (partial > 0 && partial < 3) {
    throw new ConfigError(
      'Incomplete LLM config. Set all three of PITCHBOX_LLM_PROVIDER, PITCHBOX_LLM_KEY and PITCHBOX_LLM_MODEL, or none.',
    );
  }

  return {
    serverBase,
    apiKey,
    llm: provider && llmKey && model ? { provider, apiKey: llmKey, model } : undefined,
    elevenLabsApiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
  };
}
