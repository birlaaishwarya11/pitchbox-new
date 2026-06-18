// Registry of supported LLM providers. Most speak the OpenAI-compatible
// `chat/completions` API, so they share one adapter (parameterized by baseUrl);
// Anthropic uses its native adapter. `free` marks providers offering a free
// tier / free models, surfaced in the UI.

export type AdapterKind = 'anthropic' | 'openai-compat';

export interface ModelOption {
  id: string;
  label: string;
  free?: boolean;
}

export interface ProviderDef {
  id: string;
  label: string;
  adapter: AdapterKind;
  /** Base URL for openai-compat providers (ignored for anthropic). */
  baseUrl?: string;
  /** Whether the provider offers a free tier / free models. */
  free?: boolean;
  /** Where users get a key (shown as a help link in the UI). */
  keysUrl: string;
  models: ModelOption[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    adapter: 'anthropic',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    adapter: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
      { id: 'o1-mini', label: 'o1-mini' },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    adapter: 'openai-compat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    free: true,
    keysUrl: 'https://aistudio.google.com/app/apikey',
    models: [
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', free: true },
      { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash-Lite', free: true },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', free: true },
    ],
  },
  {
    id: 'groq',
    label: 'Groq (free, fast)',
    adapter: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    free: true,
    keysUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', free: true },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (instant)', free: true },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    adapter: 'openai-compat',
    baseUrl: 'https://api.mistral.ai/v1',
    free: true,
    keysUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'mistral-small-latest', label: 'Mistral Small', free: true },
      { id: 'open-mistral-nemo', label: 'Open Mistral Nemo', free: true },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    adapter: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    free: true,
    keysUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)', free: true },
      { id: 'google/gemini-2.0-flash-exp:free', label: 'Gemini 2.0 Flash exp (free)', free: true },
    ],
  },
];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
