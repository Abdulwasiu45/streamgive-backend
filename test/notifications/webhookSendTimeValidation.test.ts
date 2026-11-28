import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

import { lookup } from 'node:dns/promises';

import { prisma } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { _resetDeliveredEventIdsForTest, notify } from '../../src/notifications/service.js';
import type { NotificationEvent } from '../../src/notifications/types.js';
import { buildServer } from '../../src/server.js';
import { signAdminRequest } from '../helpers/adminAuth.js';
import { resetDb } from '../helpers/db.js';

const adminKeypair = Keypair.random();
const resolver = vi.mocked(lookup) as unknown as ReturnType<typeof vi.fn>;
const resolveTo = (address: string) => resolver.mockResolvedValue([{ address, family: 4 }]);

const eventWith = (eventId: string): NotificationEvent => ({
  type: 'stream_created',
  streamId: '1',
  donorAddress: 'GDONOR',
  ngoId: 'NGO1',
  eventId,
});

describe('webhook URL is validated again at send time', () => {
  const originalAdmins = process.env.ADMIN_ADDRESSES;
  let timestampOffset = 0;

  beforeEach(async () => {
    process.env.ADMIN_ADDRESSES = adminKeypair.publicKey();
    _resetDeliveredEventIdsForTest();
    await resetDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resolver.mockReset();
    await resetDb();
    if (originalAdmins === undefined) delete process.env.ADMIN_ADDRESSES;
    else process.env.ADMIN_ADDRESSES = originalAdmins;
  });

  it('blocks and logs a delivery once the saved hostname resolves to a private address', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    // Save the endpoint while the hostname resolves to a public address.
    resolveTo('93.184.216.34');
    const app = buildServer();
    const url = '/v1/admin/notification-endpoints';
    const body = JSON.stringify({
      url: 'https://hooks.example.test/webhook',
      secret: 'shared-secret',
      eventTypes: ['stream_created'],
    });
    const created = await app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: {
        'content-type': 'application/json',
        ...signAdminRequest(adminKeypair, 'POST', url, String(Date.now() + timestampOffset++), body),
      },
    });
    expect(created.statusCode).toBe(201);
    const channel = `webhook:${created.json().id}`;

    // While the hostname is still public, the delivery goes out.
    await notify(eventWith('0000000100-0000000001'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // DNS now points at a private address: the next delivery must not be sent.
    fetchSpy.mockClear();
    resolveTo('10.0.0.5');
    await notify(eventWith('0000000101-0000000001'));

    expect(fetchSpy).not.toHaveBeenCalled();
    const log = await prisma.notificationLog.findFirst({
      where: { eventId: '0000000101-0000000001', channel },
    });
    expect(log).toMatchObject({ success: false, error: 'unsafe webhook destination' });
    const delivery = await prisma.webhookDelivery.findFirst({
      where: { eventId: '0000000101-0000000001', channel },
    });
    expect(delivery).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'unsafe webhook destination' });

    await app.close();
  });
});
