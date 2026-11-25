import { Keypair } from '@stellar/stellar-sdk';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { signAdminRequest } from '../helpers/adminAuth.js';
import { resetDb } from '../helpers/db.js';

const adminKeypair = Keypair.random();

describe('admin notification endpoint routes', () => {
  const originalAdmins = process.env.ADMIN_ADDRESSES;
  let timestampOffset = 0;

  beforeEach(async () => {
    process.env.ADMIN_ADDRESSES = adminKeypair.publicKey();
    await resetDb();
  });

  afterEach(async () => {
    await resetDb();
    if (originalAdmins === undefined) delete process.env.ADMIN_ADDRESSES;
    else process.env.ADMIN_ADDRESSES = originalAdmins;
  });

  function signedHeaders(method: string, url: string, body = '') {
    return {
      'content-type': 'application/json',
      ...signAdminRequest(adminKeypair, method, url, String(Date.now() + timestampOffset++), body),
    };
  }

  it('creates and lists endpoints without returning their stored secrets', async () => {
    const app = buildServer();
    const url = '/v1/admin/notification-endpoints';
    const body = JSON.stringify({
      url: 'https://8.8.8.8/webhooks',
      secret: 'private-shared-secret',
      eventTypes: ['stream_created'],
    });

    const created = await app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: signedHeaders('POST', url, body),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty('secret');
    expect(created.json().eventTypes).toEqual(['stream_created']);

    const listed = await app.inject({
      method: 'GET',
      url,
      headers: signedHeaders('GET', url),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0]).not.toHaveProperty('secret');

    await app.close();
  });

  it('rejects private destinations and unknown event types', async () => {
    const app = buildServer();
    const url = '/v1/admin/notification-endpoints';
    const base = {
      secret: 'private-shared-secret',
      eventTypes: ['stream_created'],
    };
    const privateBody = JSON.stringify({ ...base, url: 'https://127.0.0.1/hook' });
    const privateResponse = await app.inject({
      method: 'POST',
      url,
      payload: privateBody,
      headers: signedHeaders('POST', url, privateBody),
    });
    expect(privateResponse.statusCode).toBe(400);

    const invalidFilterBody = JSON.stringify({
      ...base,
      url: 'https://8.8.8.8/hook',
      eventTypes: ['not_a_notification'],
    });
    const invalidFilterResponse = await app.inject({
      method: 'POST',
      url,
      payload: invalidFilterBody,
      headers: signedHeaders('POST', url, invalidFilterBody),
    });
    expect(invalidFilterResponse.statusCode).toBe(400);

    await app.close();
  });

  it('updates and deletes an endpoint with signed requests and redacts secret rotation', async () => {
    const app = buildServer();
    const endpoint = await prisma.notificationEndpoint.create({
      data: {
        url: 'https://8.8.8.8/original',
        secret: 'old-private-secret',
        eventTypes: ['stream_created'],
      },
    });
    const url = `/v1/admin/notification-endpoints/${endpoint.id}`;
    const body = JSON.stringify({ enabled: false, secret: 'rotated-private-secret' });

    const updated = await app.inject({
      method: 'PATCH',
      url,
      payload: body,
      headers: signedHeaders('PATCH', url, body),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).not.toHaveProperty('secret');
    expect(updated.json().enabled).toBe(false);
    expect(
      (await prisma.notificationEndpoint.findUnique({ where: { id: endpoint.id } }))?.secret,
    ).toBe('rotated-private-secret');

    const deleted = await app.inject({
      method: 'DELETE',
      url,
      headers: signAdminRequest(adminKeypair, 'DELETE', url),
    });
    expect(deleted.statusCode).toBe(204);
    expect(await prisma.notificationEndpoint.findUnique({ where: { id: endpoint.id } })).toBeNull();

    await app.close();
  });

  describe('test ping', () => {
    // Bodyless POST: no content-type, or Fastify rejects the empty JSON body.
    function pingHeaders(url: string) {
      return signAdminRequest(adminKeypair, 'POST', url, String(Date.now() + timestampOffset++));
    }

    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.NOTIFY_WEBHOOK_TIMEOUT_MS;
    });

    async function createEndpoint(app: ReturnType<typeof buildServer>) {
      const url = '/v1/admin/notification-endpoints';
      const body = JSON.stringify({
        url: 'https://8.8.8.8/hooks',
        secret: 'ping-secret',
        eventTypes: ['stream_created'],
      });
      const res = await app.inject({
        method: 'POST',
        url,
        payload: body,
        headers: signedHeaders('POST', url, body),
      });
      return res.json().id as string;
    }

    it('sends a signed ping and returns the status code and latency without recording a delivery', async () => {
      const app = buildServer();
      const id = await createEndpoint(app);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));

      const url = `/v1/admin/notification-endpoints/${id}/test`;
      const res = await app.inject({ method: 'POST', url, headers: pingHeaders(url) });

      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result).toMatchObject({ ok: true, statusCode: 204 });
      expect(typeof result.latencyMs).toBe('number');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [target, init] = fetchSpy.mock.calls[0];
      expect(target).toBe('https://8.8.8.8/hooks');
      const headers = init?.headers as Record<string, string>;
      const sentBody = init?.body as string;
      expect(JSON.parse(sentBody)).toMatchObject({ type: 'ping', endpointId: id });
      const expected = createHmac('sha256', 'ping-secret')
        .update(
          `${headers['x-streamgive-timestamp']}.${headers['x-streamgive-delivery-id']}.${sentBody}`,
        )
        .digest('hex');
      expect(headers['x-streamgive-signature']).toBe(`v1=${expected}`);

      expect(await prisma.notificationLog.count()).toBe(0);
      expect(await prisma.webhookDelivery.count()).toBe(0);
      await app.close();
    });

    it('reports a failing receiver once, without retrying', async () => {
      const app = buildServer();
      const id = await createEndpoint(app);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('nope', { status: 500 }));

      const url = `/v1/admin/notification-endpoints/${id}/test`;
      const res = await app.inject({ method: 'POST', url, headers: pingHeaders(url) });

      expect(res.json()).toMatchObject({ ok: false, statusCode: 500 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await prisma.notificationLog.count()).toBe(0);
      expect(await prisma.webhookDelivery.count()).toBe(0);
      await app.close();
    });

    it('respects the delivery timeout', async () => {
      process.env.NOTIFY_WEBHOOK_TIMEOUT_MS = '50';
      const app = buildServer();
      const id = await createEndpoint(app);
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
            );
          }),
      );

      const url = `/v1/admin/notification-endpoints/${id}/test`;
      const res = await app.inject({ method: 'POST', url, headers: pingHeaders(url) });

      expect(res.json()).toMatchObject({ ok: false, statusCode: null, error: 'timeout' });
      await app.close();
    });

    it('returns 404 for an unknown endpoint', async () => {
      const app = buildServer();
      const url = '/v1/admin/notification-endpoints/00000000-0000-4000-8000-000000000000/test';
      const res = await app.inject({ method: 'POST', url, headers: pingHeaders(url) });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
