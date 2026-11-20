import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSlowRequestThresholdMs } from '../src/config.js';
import { buildServer } from '../src/server.js';

describe('slow request warning', () => {
  afterEach(() => {
    delete process.env.SLOW_REQUEST_THRESHOLD_MS;
    vi.restoreAllMocks();
  });

  async function serverWithSlowRoute() {
    const app = buildServer();
    app.get('/__test/slow/:id', async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { ok: true };
    });
    app.get('/__test/fast', async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('logs a warning with route, status and duration when a request exceeds the threshold', async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = '20';
    const app = await serverWithSlowRoute();
    const warn = vi.spyOn(app.log, 'warn');

    const res = await app.inject({ method: 'GET', url: '/__test/slow/42?secret=x' });
    expect(res.statusCode).toBe(200);

    const call = warn.mock.calls.find((args) => args[1] === 'slow request');
    expect(call).toBeDefined();
    const fields = call?.[0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      method: 'GET',
      route: '/__test/slow/:id',
      statusCode: 200,
      thresholdMs: 20,
    });
    expect(fields.durationMs as number).toBeGreaterThan(20);
    await app.close();
  });

  it('stays quiet for fast requests and when the threshold is 0', async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = '1000';
    let app = await serverWithSlowRoute();
    let warn = vi.spyOn(app.log, 'warn');
    await app.inject({ method: 'GET', url: '/__test/fast' });
    expect(warn.mock.calls.some((args) => args[1] === 'slow request')).toBe(false);
    await app.close();

    process.env.SLOW_REQUEST_THRESHOLD_MS = '0';
    app = await serverWithSlowRoute();
    warn = vi.spyOn(app.log, 'warn');
    await app.inject({ method: 'GET', url: '/__test/slow/1' });
    expect(warn.mock.calls.some((args) => args[1] === 'slow request')).toBe(false);
    await app.close();
  });

  it('parses the threshold', () => {
    expect(parseSlowRequestThresholdMs(undefined)).toBe(1000);
    expect(parseSlowRequestThresholdMs(' 250 ')).toBe(250);
    expect(parseSlowRequestThresholdMs('0')).toBe(0);
    expect(() => parseSlowRequestThresholdMs('fast')).toThrow(/SLOW_REQUEST_THRESHOLD_MS/);
    expect(() => parseSlowRequestThresholdMs('-5')).toThrow(/SLOW_REQUEST_THRESHOLD_MS/);
  });
});
