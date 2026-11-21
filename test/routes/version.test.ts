import { afterEach, describe, expect, it } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };
import { buildServer } from '../../src/server.js';

describe('GET /version', () => {
  const origCommit = process.env.GIT_COMMIT;
  const origBuildTime = process.env.BUILD_TIME;

  afterEach(() => {
    if (origCommit === undefined) delete process.env.GIT_COMMIT;
    else process.env.GIT_COMMIT = origCommit;
    if (origBuildTime === undefined) delete process.env.BUILD_TIME;
    else process.env.BUILD_TIME = origBuildTime;
  });

  it('returns package version, git commit, and build time without secrets', async () => {
    process.env.GIT_COMMIT = 'abc1234';
    process.env.BUILD_TIME = '2026-11-20T00:00:00Z';

    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/version' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: packageJson.version,
      commit: 'abc1234',
      buildTime: '2026-11-20T00:00:00Z',
    });
  });
});
