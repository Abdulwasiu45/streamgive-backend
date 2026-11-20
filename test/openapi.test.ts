import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

describe('OpenAPI documentation', () => {
  it('lists limit, cursor, sort, and q query parameters for /v1/ngos', async () => {
    const app = buildServer();
    await app.ready();

    const spec = app.swagger();
    const ngoGet = spec.paths?.['/v1/ngos']?.get;
    expect(ngoGet).toBeDefined();

    const queryParameters = (ngoGet?.parameters ?? []).filter(
      (param: { in?: string; name: string }) => param.in === 'query',
    );
    const parameterNames = queryParameters.map(
      (param: { in?: string; name: string }) => param.name,
    );

    expect(parameterNames).toContain('limit');
    expect(parameterNames).toContain('cursor');
    expect(parameterNames).toContain('sort');
    expect(parameterNames).toContain('q');

    await app.close();
  });

  it('documents the /v1/streams query parameters generated from the validation schema', async () => {
    const app = buildServer();
    await app.ready();

    const streamsGet = app.swagger().paths?.['/v1/streams']?.get;
    expect(streamsGet).toBeDefined();

    const names = (streamsGet?.parameters ?? [])
      .filter((param: { in?: string }) => param.in === 'query')
      .map((param: { name: string }) => param.name);

    expect(names).toEqual(
      expect.arrayContaining(['donor', 'ngo', 'ngoAddress', 'token', 'status', 'limit', 'cursor']),
    );

    await app.close();
  });

  it('documents the admin dead-letter detail and resolve routes', async () => {
    const app = buildServer();
    await app.ready();

    const spec = app.swagger();
    expect(spec.paths?.['/v1/admin/dead-letters/{id}']?.get).toBeDefined();
    expect(spec.paths?.['/v1/admin/dead-letters/{id}/resolve']?.post).toBeDefined();

    await app.close();
  });
});
