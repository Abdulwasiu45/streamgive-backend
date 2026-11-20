import { describe, expect, it } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };
import { buildServer } from '../src/server.js';

describe('OpenAPI documentation', () => {
  it('uses the package version and documents signed admin headers', async () => {
    const app = buildServer();
    await app.ready();

    const spec = app.swagger();
    expect(spec.info.version).toBe(packageJson.version);
    expect(spec.components?.securitySchemes).toMatchObject({
      AdminAddress: { type: 'apiKey', in: 'header', name: 'x-admin-address' },
      AdminSignature: { type: 'apiKey', in: 'header', name: 'x-admin-signature' },
      AdminTimestamp: { type: 'apiKey', in: 'header', name: 'x-admin-timestamp' },
    });

    const adminOperations = [
      ['/v1/admin/dead-letters', 'get'],
      ['/v1/admin/dead-letters/{id}', 'get'],
      ['/v1/admin/dead-letters/{id}/resolve', 'post'],
      ['/v1/admin/ngos/{id}', 'patch'],
      ['/v1/ngos/all', 'get'],
      ['/v1/ngo-applications', 'get'],
      ['/v1/ngo-applications/stats', 'get'],
      ['/v1/ngo-applications/{id}', 'get'],
      ['/v1/ngo-applications/{id}/approve', 'post'],
      ['/v1/ngo-applications/{id}/reject', 'post'],
      ['/v1/admin/notification-endpoints', 'get'],
      ['/v1/admin/notification-endpoints', 'post'],
      ['/v1/admin/notification-endpoints/{id}', 'patch'],
      ['/v1/admin/notification-endpoints/{id}', 'delete'],
    ] as const;
    for (const [path, method] of adminOperations) {
      expect(spec.paths?.[path]?.[method]).toHaveProperty('security', [
        {
          AdminAddress: [],
          AdminSignature: [],
          AdminTimestamp: [],
        },
      ]);
    }

    await app.close();
  });

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

  it('documents the on-chain stream lookup route', async () => {
    const app = buildServer();
    await app.ready();

    expect(
      app.swagger().paths?.['/v1/streams/on-chain/{onChainId}']?.get?.parameters,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'onChainId', in: 'path', required: true }),
      ]),
    );

    await app.close();
  });
});
