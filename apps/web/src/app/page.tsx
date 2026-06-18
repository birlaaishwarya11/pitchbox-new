'use client';

import { useState } from 'react';

type EnvVar = { key: string; value: string };
type Provider = 'anthropic' | 'openai' | 'gemini';
type UrlMode = 'github' | 'deployed';

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
};

const PROVIDER_MODELS: Record<Provider, string[]> = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o1'],
  gemini: ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-pro'],
};

const CUSTOM_MODEL = '__custom__';

export default function Home() {
  const [step, setStep] = useState<'landing' | 'provider' | 'inputs' | 'env' | 'result'>('landing');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [modelChoice, setModelChoice] = useState<string>(PROVIDER_MODELS.anthropic[0]);
  const [customModel, setCustomModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [urlMode, setUrlMode] = useState<UrlMode>('github');
  const [githubUrl, setGithubUrl] = useState('');
  const [deployedUrl, setDeployedUrl] = useState('');
  const [envVars, setEnvVars] = useState<EnvVar[]>([{ key: '', value: '' }]);
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const isValidUrl = (value: string) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  };

  const handleProviderChange = (next: Provider) => {
    setProvider(next);
    setModelChoice(PROVIDER_MODELS[next][0]);
    setCustomModel('');
  };

  const resolvedModel = modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice;

  const handleProviderNext = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!apiKey.trim()) {
      setError('Please enter your API key.');
      return;
    }
    if (!resolvedModel) {
      setError('Please choose or enter a model name.');
      return;
    }
    setStep('inputs');
  };

  const handleInputsNext = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (urlMode === 'github') {
      if (!isValidUrl(githubUrl)) {
        setError('Please enter a valid GitHub URL.');
        return;
      }
      setStep('env');
    } else {
      if (!isValidUrl(deployedUrl)) {
        setError('Please enter a valid deployed project URL.');
        return;
      }
      void handleSubmit(e);
    }
  };

  const updateEnvVar = (index: number, field: 'key' | 'value', value: string) => {
    setEnvVars(prev => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const addEnvVar = () => setEnvVars(prev => [...prev, { key: '', value: '' }]);
  const removeEnvVar = (index: number) =>
    setEnvVars(prev => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setResponse(null);

    const env = envVars.reduce<Record<string, string>>((acc, { key, value }) => {
      const trimmed = key.trim();
      if (trimmed) acc[trimmed] = value;
      return acc;
    }, {});

    try {
      const payload: Record<string, unknown> = {
        ai: { provider, model: resolvedModel, apiKey },
      };
      if (urlMode === 'github') {
        payload.githubUrl = githubUrl;
        payload.env = env;
      } else {
        payload.deployedUrl = deployedUrl;
      }

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setResponse(data);
      setStep('result');
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const reset = () => {
    setStep('landing');
    setProvider('anthropic');
    setModelChoice(PROVIDER_MODELS.anthropic[0]);
    setCustomModel('');
    setApiKey('');
    setShowApiKey(false);
    setUrlMode('github');
    setGithubUrl('');
    setDeployedUrl('');
    setEnvVars([{ key: '', value: '' }]);
    setResponse(null);
    setError(null);
  };

  return (
    <main className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-5xl sm:text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-purple-500 mb-4">
            Pitchbox
          </h1>
          <p className="text-lg text-slate-600 dark:text-slate-400">
            Turn any GitHub repository into an auto-generated demo video.
          </p>
        </div>

        {step === 'landing' && (
          <>
            <section className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8 mb-8">
              <h2 className="text-2xl font-semibold mb-3 text-slate-800 dark:text-slate-200">
                What it does
              </h2>
              <p className="text-slate-600 dark:text-slate-400 mb-6">
                Pitchbox clones your repository, analyzes the codebase to identify features and user
                flows, deploys the app to a sandbox, records a walkthrough of your deployed project,
                and generates a narrated demo script — all from a GitHub URL.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-2">
                <Step n={1} title="Analyze" body="Clone the repo and detect tech stack, features, and user flows." />
                <Step n={2} title="Record" body="Walk through the deployed app and capture a screen recording." />
                <Step n={3} title="Pitch" body="Generate a demo script and voiceover ready to share." />
              </div>
            </section>

            <section className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8 mb-8">
              <h2 className="text-2xl font-semibold mb-3 text-slate-800 dark:text-slate-200">
                How to set it up
              </h2>
              <ol className="list-decimal list-inside space-y-2 text-slate-600 dark:text-slate-400">
                <li>
                  Install dependencies from the repo root: <Code>npm install</Code>
                </li>
                <li>
                  Add an <Code>ANTHROPIC_API_KEY</Code> to <Code>.env</Code> for script generation.
                </li>
                <li>
                  (Optional) Add Daytona credentials to <Code>.env</Code> if you want sandbox
                  recording.
                </li>
                <li>
                  Start everything: <Code>npm run dev</Code> — web on{' '}
                  <Code>localhost:3000</Code>, server on <Code>localhost:3001</Code>.
                </li>
                <li>Paste your GitHub URL and your deployed project URL below to get started.</li>
              </ol>
            </section>

            <div className="text-center">
              <button
                onClick={() => setStep('provider')}
                className="bg-gradient-to-r from-indigo-600 to-purple-500 hover:from-indigo-700 hover:to-purple-600 text-white font-semibold py-4 px-10 rounded-lg shadow-lg hover:shadow-xl transition-all"
              >
                Get started
              </button>
            </div>
          </>
        )}

        {step === 'provider' && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8">
            <StepIndicator current={1} />
            <h2 className="text-2xl font-semibold mb-2 text-slate-800 dark:text-slate-200">
              AI Provider
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
              Pitchbox uses your own API key to run the analysis and script-generation agents.
            </p>

            <form onSubmit={handleProviderNext} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Provider
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(Object.keys(PROVIDER_LABELS) as Provider[]).map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => handleProviderChange(p)}
                      className={`py-3 px-4 rounded-lg border-2 text-sm font-medium transition ${
                        provider === p
                          ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                          : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {PROVIDER_LABELS[p]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="model" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Model
                </label>
                <select
                  id="model"
                  value={modelChoice}
                  onChange={e => setModelChoice(e.target.value)}
                  className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                >
                  {PROVIDER_MODELS[provider].map(m => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value={CUSTOM_MODEL}>Custom…</option>
                </select>
                {modelChoice === CUSTOM_MODEL && (
                  <input
                    type="text"
                    value={customModel}
                    onChange={e => setCustomModel(e.target.value)}
                    placeholder="custom-model-name"
                    className="mt-2 w-full font-mono text-sm px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                  />
                )}
              </div>

              <div>
                <label htmlFor="apiKey" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  API Key *
                </label>
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    id="apiKey"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder={
                      provider === 'anthropic'
                        ? 'sk-ant-...'
                        : provider === 'openai'
                          ? 'sk-...'
                          : 'AIza...'
                    }
                    className="w-full font-mono text-sm px-4 py-3 pr-20 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(s => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                  >
                    {showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                  Your key is sent only to the local Pitchbox server and is not stored.
                </p>
              </div>

              {error && <ErrorBox message={error} />}

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setStep('landing')}
                  className="px-6 py-3 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                >
                  ← Back
                </button>
                <button
                  type="submit"
                  className="bg-gradient-to-r from-indigo-600 to-purple-500 hover:from-indigo-700 hover:to-purple-600 text-white font-semibold py-3 px-8 rounded-lg shadow"
                >
                  Next: Project URLs →
                </button>
              </div>
            </form>
          </div>
        )}

        {step === 'inputs' && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8">
            <StepIndicator current={2} />
            <h2 className="text-2xl font-semibold mb-2 text-slate-800 dark:text-slate-200">
              Project URL
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
              Pick one — analyze the source from a GitHub repo, or record a walkthrough of an
              already-deployed app.
            </p>

            <div className="grid grid-cols-2 gap-2 mb-6">
              <button
                type="button"
                onClick={() => setUrlMode('github')}
                className={`py-3 px-4 rounded-lg border-2 text-sm font-medium transition ${
                  urlMode === 'github'
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 text-slate-700 dark:text-slate-300'
                }`}
              >
                GitHub repo
              </button>
              <button
                type="button"
                onClick={() => setUrlMode('deployed')}
                className={`py-3 px-4 rounded-lg border-2 text-sm font-medium transition ${
                  urlMode === 'deployed'
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 text-slate-700 dark:text-slate-300'
                }`}
              >
                Deployed URL
              </button>
            </div>

            <form onSubmit={handleInputsNext} className="space-y-6">
              {urlMode === 'github' ? (
                <Field
                  label="GitHub URL"
                  id="githubUrl"
                  type="url"
                  value={githubUrl}
                  onChange={setGithubUrl}
                  placeholder="https://github.com/username/repository"
                  required
                />
              ) : (
                <Field
                  label="Deployed Project URL"
                  id="deployedUrl"
                  type="url"
                  value={deployedUrl}
                  onChange={setDeployedUrl}
                  placeholder="https://your-app.vercel.app"
                  required
                />
              )}

              {error && <ErrorBox message={error} />}

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setStep('provider')}
                  className="px-6 py-3 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                >
                  ← Back
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="bg-gradient-to-r from-indigo-600 to-purple-500 hover:from-indigo-700 hover:to-purple-600 text-white font-semibold py-3 px-8 rounded-lg shadow disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <Spinner /> Generating...
                    </>
                  ) : urlMode === 'github' ? (
                    'Next: .env values →'
                  ) : (
                    'Generate pitch'
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {step === 'env' && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8">
            <StepIndicator current={3} />
            <h2 className="text-2xl font-semibold mb-2 text-slate-800 dark:text-slate-200">
              Environment Variables
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
              Add the <Code>.env</Code> values needed to run{' '}
              <span className="font-mono text-xs break-all">{githubUrl}</span>. Leave empty if none
              are required.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              {envVars.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    value={row.key}
                    onChange={e => updateEnvVar(i, 'key', e.target.value)}
                    placeholder="KEY"
                    className="flex-1 font-mono text-sm px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                  />
                  <input
                    type="text"
                    value={row.value}
                    onChange={e => updateEnvVar(i, 'value', e.target.value)}
                    placeholder="value"
                    className="flex-[2] font-mono text-sm px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={() => removeEnvVar(i)}
                    disabled={envVars.length === 1}
                    className="px-3 text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Remove row"
                  >
                    ✕
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={addEnvVar}
                className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                + Add another variable
              </button>

              {error && <ErrorBox message={error} />}

              <div className="flex justify-between pt-4">
                <button
                  type="button"
                  onClick={() => setStep('inputs')}
                  className="px-6 py-3 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                >
                  ← Back
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="bg-gradient-to-r from-indigo-600 to-purple-500 hover:from-indigo-700 hover:to-purple-600 text-white font-semibold py-3 px-8 rounded-lg shadow disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <Spinner /> Generating...
                    </>
                  ) : (
                    'Generate pitch'
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {step === 'result' && response && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8">
            <h2 className="text-2xl font-semibold mb-4 text-green-700 dark:text-green-400">
              ✓ Pitch generated
            </h2>
            <pre className="bg-slate-100 dark:bg-slate-900 text-xs p-4 rounded-lg overflow-x-auto max-h-[60vh]">
              {JSON.stringify(response, null, 2)}
            </pre>
            <div className="mt-6 text-center">
              <button
                onClick={reset}
                className="bg-gradient-to-r from-indigo-600 to-purple-500 hover:from-indigo-700 hover:to-purple-600 text-white font-semibold py-3 px-8 rounded-lg shadow"
              >
                Start over
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  id,
  type,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  id: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
        {label} {required && '*'}
      </label>
      <input
        type={type}
        id={id}
        required={required}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
      />
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-4">
      <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 mb-1">
        STEP {n}
      </div>
      <div className="font-semibold text-slate-800 dark:text-slate-200 mb-1">{title}</div>
      <div className="text-sm text-slate-600 dark:text-slate-400">{body}</div>
    </div>
  );
}

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  const steps = ['1. AI Provider', '2. Project URL', '3. .env values'];
  return (
    <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 mb-4 flex-wrap">
      {steps.map((label, i) => (
        <span key={label} className="flex items-center gap-2">
          <span className={current === i + 1 ? 'text-indigo-600 dark:text-indigo-400' : ''}>
            {label}
          </span>
          {i < steps.length - 1 && <span>→</span>}
        </span>
      ))}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-xs bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-200 px-1.5 py-0.5 rounded">
      {children}
    </code>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
      {message}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}
