import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };
import { generateOpenApiDocument } from '../src/scripts/exportOpenApi.js';
import { buildServer } from '../src/server.js';

const OPENAPI_ROUTE_ALLOWLIST = new Set([
  'GET /health',
  'GET /health/ready',
  'GET /metrics',
  'GET /v1/health',
  'OPTIONS *',
  'OPTIONS /*',
]);

const OPENAPI_ROUTE_ALLOWLIST_PREFIXES = ['/docs'];

function getRegisteredOperations(routeTree: string): Array<{ method: string; path: string }> {
  const segments: string[] = [];
  const operations: Array<{ method: string; path: string }> = [];

  for (const line of routeTree.split('\n')) {
    const node = /^((?: {4}|│ {3})*)(?:├──|└──)\s+(.*)$/.exec(line);
    if (node === null) {
      continue;
    }

    if (node[2] === '(empty root node)') {
      continue;
    }

    const depth = node[1].length / 4;
    const route = /^(.*?) \(([^()]*)\)$/.exec(node[2]);
    segments.length = depth;
    segments[depth] = route?.[1] ?? node[2];

    if (route === null) {
      continue;
    }

    const path = `/${segments.slice(0, depth + 1).join('')}`
      .replace(/\/+/g, '/')
      .replace(/:([A-Za-z0-9_]+)/g, '{$1}');

    for (const method of route[2].split(',').map((value) => value.trim())) {
      operations.push({ method: method === 'HEAD' ? 'GET' : method, path });
    }
  }

  return operations;
}

describe('OpenAPI documentation', () => {
  it('keeps committed openapi.json in sync with the generated OpenAPI specification', async () => {
    const doc = await generateOpenApiDocument();
    const committed = readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8');
    expect(committed).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });

  it('documents every registered route except explicitly allowlisted infrastructure routes', async () => {
    const app = buildServer();
    await app.ready();

    try {
      const paths = app.swagger().paths ?? {};
      const missing = getRegisteredOperations(app.printRoutes())
        .filter(({ method, path }) => {
          if (
            OPENAPI_ROUTE_ALLOWLIST.has(`${method} ${path}`) ||
            OPENAPI_ROUTE_ALLOWLIST_PREFIXES.some(
              (prefix) => path === prefix || path.startsWith(`${prefix}/`),
            )
          ) {
            return false;
          }
          return !(paths as Record<string, Record<string, unknown>>)[path]?.[method.toLowerCase()];
        })
        .map(({ method, path }) => `${method} ${path}`);

      expect(missing, `Registered routes missing from OpenAPI: ${missing.join(', ')}`).toEqual([]);
    } finally {
      await app.close();
    }
  });

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
      ['/v1/admin/notification-logs', 'get'],
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

    expect(app.swagger().paths?.['/v1/streams/on-chain/{onChainId}']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'onChainId', in: 'path', required: true }),
      ]),
    );

    await app.close();
  });

  it('documents GET /version and GET /v1/ngos/all search parameter', async () => {
    const app = buildServer();
    await app.ready();

    const spec = app.swagger();
    expect(spec.paths?.['/version']?.get).toBeDefined();

    const adminNgoParams = (spec.paths?.['/v1/ngos/all']?.get?.parameters ?? [])
      .filter((param: { in?: string }) => param.in === 'query')
      .map((param: { name: string }) => param.name);
    expect(adminNgoParams).toEqual(expect.arrayContaining(['limit', 'cursor', 'verified', 'q']));

    await app.close();
  });
});
