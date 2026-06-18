import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entryPoint = path.resolve(__dirname, 'remoteRecorderEntrypoint.ts');

let cachedBundle: string | undefined;
let bundlePromise: Promise<string> | undefined;

export async function getRemoteRecorderBundle(): Promise<string> {
  if (cachedBundle) {
    return cachedBundle;
  }

  if (!bundlePromise) {
    bundlePromise = build({
      entryPoints: [entryPoint],
      platform: 'node',
      format: 'esm',
      target: ['node18'],
      bundle: true,
      write: false,
      external: ['puppeteer', 'xvfb'],
    }).then((result) => {
      const output = result.outputFiles?.[0];
      if (!output) {
        throw new Error('Failed to build remote recorder bundle.');
      }
      cachedBundle = output.text;
      return cachedBundle;
    }).finally(() => {
      bundlePromise = undefined;
    });
  }

  return bundlePromise;
}

