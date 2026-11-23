import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function startEntrypoint(
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
      cwd: root,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 8_000);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error('entrypoint did not fail fast'));
        return;
      }
      resolve({ status, stderr });
    });
  });
}

describe('startup configuration validation', () => {
  it.each([
    ['PORT', 'invalid'],
    ['RATE_LIMIT_MAX', 'invalid'],
    ['INDEXER_START_LEDGER', 'invalid'],
  ])(
    'exits before startup when %s is invalid',
    async (name, value) => {
      const result = await startEntrypoint({
        NODE_ENV: 'test',
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        [name]: value,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(name);
    },
    10_000,
  );
});
