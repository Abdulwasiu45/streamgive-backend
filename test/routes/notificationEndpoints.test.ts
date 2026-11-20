import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      ...signAdminRequest(
        adminKeypair,
        method,
        url,
        String(Date.now() + timestampOffset++),
        body,
      ),
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
      headers: signedHeaders('DELETE', url),
    });
    expect(deleted.statusCode).toBe(204);
    expect(await prisma.notificationEndpoint.findUnique({ where: { id: endpoint.id } })).toBeNull();

    await app.close();
  });
});
