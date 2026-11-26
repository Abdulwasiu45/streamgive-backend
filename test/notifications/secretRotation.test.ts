import { createHmac } from 'node:crypto';

import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import {
  SECRET_ROTATION_OVERLAP_MS,
  _resetDeliveredEventIdsForTest,
  notify,
} from '../../src/notifications/service.js';
import type { NotificationEvent } from '../../src/notifications/types.js';
import { buildServer } from '../../src/server.js';
import { signAdminRequest } from '../helpers/adminAuth.js';
import { resetDb } from '../helpers/db.js';

const adminKeypair = Keypair.random();
const event: NotificationEvent = {
  type: 'stream_created',
  streamId: '1',
  donorAddress: 'GDONOR',
  ngoId: 'NGO1',
  eventId: '0000000100-0000000001',
};

const expected = (secret: string, headers: Record<string, string>, body: string) =>
  `v1=${createHmac('sha256', secret)
    .update(`${headers['x-streamgive-timestamp']}.${headers['x-streamgive-delivery-id']}.${body}`)
    .digest('hex')}`;

describe('webhook secret rotation', () => {
  const originalAdmins = process.env.ADMIN_ADDRESSES;
  let offset = 0;

  beforeEach(async () => {
    process.env.ADMIN_ADDRESSES = adminKeypair.publicKey();
    _resetDeliveredEventIdsForTest();
    await resetDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
    if (originalAdmins === undefined) delete process.env.ADMIN_ADDRESSES;
    else process.env.ADMIN_ADDRESSES = originalAdmins;
  });

  const createEndpoint = (overrides: Record<string, unknown> = {}) =>
    prisma.notificationEndpoint.create({
      data: {
        url: 'https://8.8.8.8/hook',
        secret: 'new-secret',
        eventTypes: ['stream_created'],
        ...overrides,
      },
    });

  async function deliver() {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await notify(event);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    return init;
  }

  it('signs with the current secret and also with the previous one during the overlap', async () => {
    await createEndpoint({
      previousSecret: 'old-secret',
      previousSecretExpiresAt: new Date(Date.now() + 60_000),
    });

    const { headers, body } = await deliver();

    expect(headers['x-streamgive-signature']).toBe(expected('new-secret', headers, body));
    expect(headers['x-streamgive-signature-previous']).toBe(expected('old-secret', headers, body));
  });

  it('sends only the current signature once the overlap has ended or when there is no previous secret', async () => {
    await createEndpoint({
      previousSecret: 'old-secret',
      previousSecretExpiresAt: new Date(Date.now() - 1_000),
    });
    const expired = await deliver();
    expect(expired.headers['x-streamgive-signature']).toBe(
      expected('new-secret', expired.headers, expired.body),
    );
    expect(expired.headers).not.toHaveProperty('x-streamgive-signature-previous');

    vi.restoreAllMocks();
    _resetDeliveredEventIdsForTest();
    await resetDb();
    await createEndpoint();
    const plain = await deliver();
    expect(plain.headers).not.toHaveProperty('x-streamgive-signature-previous');
  });

  it('keeps the old secret as the previous one when an admin changes the secret', async () => {
    const app = buildServer();
    const endpoint = await createEndpoint({ secret: 'first-secret' });
    const url = `/v1/admin/notification-endpoints/${endpoint.id}`;
    const patch = async (payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload);
      return app.inject({
        method: 'PATCH',
        url,
        payload: body,
        headers: {
          'content-type': 'application/json',
          ...signAdminRequest(adminKeypair, 'PATCH', url, String(Date.now() + offset++), body),
        },
      });
    };
    const stored = () => prisma.notificationEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });

    const before = Date.now();
    const rotated = await patch({ secret: 'second-secret' });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).not.toHaveProperty('secret');
    let row = await stored();
    expect(row).toMatchObject({ secret: 'second-secret', previousSecret: 'first-secret' });
    const expiresAt = row.previousSecretExpiresAt!.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + SECRET_ROTATION_OVERLAP_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + SECRET_ROTATION_OVERLAP_MS);
    expect(rotated.json().previousSecretExpiresAt).toBe(row.previousSecretExpiresAt!.toISOString());

    // Repeating the current secret, or editing other fields, does not rotate again.
    await patch({ secret: 'second-secret' });
    await patch({ enabled: false });
    row = await stored();
    expect(row).toMatchObject({ secret: 'second-secret', previousSecret: 'first-secret', enabled: false });
    expect(row.previousSecretExpiresAt!.getTime()).toBe(expiresAt);

    // A second rotation inside the overlap keeps only the immediate predecessor.
    await patch({ secret: 'third-secret' });
    expect(await stored()).toMatchObject({ secret: 'third-secret', previousSecret: 'second-secret' });

    await app.close();
  });
});
