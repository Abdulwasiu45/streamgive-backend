import { afterEach, describe, expect, it } from 'vitest';

import { MAINTENANCE_RETRY_AFTER_SECONDS } from '../src/config.js';
import { buildServer } from '../src/server.js';

describe('maintenance mode', () => {
  const original = process.env.MAINTENANCE_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.MAINTENANCE_MODE;
    else process.env.MAINTENANCE_MODE = original;
  });

  function serverWithTestRoutes() {
    const app = buildServer();
    app.get('/test-read', async () => ({ ok: true }));
    app.post('/test-write', async () => ({ ok: true }));
    return app;
  }

  it('answers 503 with Retry-After for writes while reads and health checks keep working', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    const app = serverWithTestRoutes();

    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const write = await app.inject({
          method,
          url: '/test-write',
          headers: { origin: 'http://localhost:3001' },
        });
        expect(write.statusCode).toBe(503);
        expect(write.headers['retry-after']).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS));
        expect(write.headers['access-control-allow-origin']).toBe('http://localhost:3001');
        expect(write.json()).toEqual({ error: 'maintenance' });
      }

      const read = await app.inject({ method: 'GET', url: '/test-read' });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ ok: true });

      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('leaves writes alone when the setting is off', async () => {
    process.env.MAINTENANCE_MODE = 'false';
    const app = serverWithTestRoutes();

    try {
      const write = await app.inject({ method: 'POST', url: '/test-write' });
      expect(write.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('refuses to start with an unrecognised value', () => {
    process.env.MAINTENANCE_MODE = 'yes please';
    expect(() => buildServer()).toThrow(/MAINTENANCE_MODE/);
  });
});
