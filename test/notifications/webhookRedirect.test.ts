import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { _resetDeliveredEventIdsForTest, notify } from '../../src/notifications/service.js';
import type { NotificationEvent } from '../../src/notifications/types.js';
import { resetDb } from '../helpers/db.js';

const event: NotificationEvent = {
  type: 'stream_created',
  streamId: '1',
  donorAddress: 'GDONOR',
  ngoId: 'NGO1',
  eventId: '0000000100-0000000001',
};

describe('webhook redirects are refused', () => {
  const originalUrl = process.env.NOTIFY_WEBHOOK_URL;
  const originalSecret = process.env.NOTIFY_WEBHOOK_SECRET;
  let server: Server;
  let port: number;
  let hits: string[] = [];

  beforeAll(async () => {
    // A local receiver that answers /hook with a 302 to /internal, standing in for
    // an internal address a public receiver could bounce the request to.
    server = createServer((request, response) => {
      hits.push(request.url ?? '');
      if (request.url === '/hook') {
        response.writeHead(302, { location: `http://127.0.0.1:${port}/internal` });
        response.end();
        return;
      }
      response.writeHead(200).end('internal');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    hits = [];
    _resetDeliveredEventIdsForTest();
    await resetDb();
    delete process.env.NOTIFY_WEBHOOK_SECRET;
    // The single-endpoint environment destination is not subject to the public-address
    // check, which lets the test use a loopback receiver for the redirect itself.
    process.env.NOTIFY_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
    if (originalUrl === undefined) delete process.env.NOTIFY_WEBHOOK_URL;
    else process.env.NOTIFY_WEBHOOK_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.NOTIFY_WEBHOOK_SECRET;
    else process.env.NOTIFY_WEBHOOK_SECRET = originalSecret;
  });

  it('fails the delivery without following a 302 to another address', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    await notify(event);

    // Only the original URL was requested; the redirect target was never fetched.
    expect(hits).toEqual(['/hook']);
    const log = await prisma.notificationLog.findFirst({ where: { channel: 'webhook' } });
    expect(log).toMatchObject({ success: false, error: 'TypeError' });
    const delivery = await prisma.webhookDelivery.findFirst({ where: { channel: 'webhook' } });
    expect(delivery).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'TypeError' });
  });
});
