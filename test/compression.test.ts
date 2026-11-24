import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { buildServer } from '../src/server.js';
import { sendPublicCacheable } from '../src/routes/cacheable.js';

async function build() {
  const app = buildServer();
  await app.after();
  app.get('/big', async () => ({
    items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `ngo-${i}` })),
  }));
  app.get('/cached', async (request, reply) =>
    sendPublicCacheable(request, reply, {
      items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `ngo-${i}` })),
    }),
  );
  app.get('/small', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('response compression', () => {
  it('compresses large JSON when client accepts gzip', async () => {
    const app = await build();
    const res = await app.inject({
      url: '/big',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBe('gzip');
    const body = JSON.parse(gunzipSync(res.rawPayload).toString());
    expect(body.items).toHaveLength(500);
    await app.close();
  });

  it('keeps the ETag valid for a compressed cacheable response and returns 304', async () => {
    const app = await build();
    const firstResponse = await app.inject({
      url: '/cached',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(firstResponse.headers['content-encoding']).toBe('gzip');
    expect(firstResponse.headers.vary).toContain('Accept-Encoding');
    const etag = firstResponse.headers.etag;
    expect(etag).toBeDefined();
    if (etag === undefined) {
      throw new Error('expected the cacheable response to include an ETag');
    }
    expect(JSON.parse(gunzipSync(firstResponse.rawPayload).toString()).items).toHaveLength(500);

    const cachedResponse = await app.inject({
      url: '/cached',
      headers: {
        'accept-encoding': 'gzip',
        'if-none-match': etag,
      },
    });

    expect(cachedResponse.statusCode).toBe(304);
    expect(cachedResponse.headers.etag).toBe(etag);
    expect(cachedResponse.headers.vary).toContain('Accept-Encoding');
    await app.close();
  });

  it('does not compress when client sends no accept-encoding', async () => {
    const app = await build();
    const res = await app.inject({ url: '/big' });
    expect(res.headers['content-encoding']).toBeUndefined();
    await app.close();
  });

  it('skips responses under the threshold', async () => {
    const app = await build();
    const res = await app.inject({
      url: '/small',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBeUndefined();
    await app.close();
  });
});
