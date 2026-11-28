import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { redactUrls } from '../../src/routes/notificationLogs.js';
import { buildServer } from '../../src/server.js';
import { signAdminRequest } from '../helpers/adminAuth.js';
import { resetDb } from '../helpers/db.js';

const adminKeypair = Keypair.random();

async function getLogs(query = '') {
  const app = buildServer();
  const url = `/v1/admin/notification-logs${query}`;
  const response = await app.inject({
    method: 'GET',
    url,
    headers: signAdminRequest(adminKeypair, 'GET', url),
  });
  await app.close();
  return response;
}

describe('GET /v1/admin/notification-logs', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('requires an admin signature', async () => {
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/v1/admin/notification-logs' });
    await app.close();

    expect(response.statusCode).toBe(401);
  });

  it('pages newest first and filters by event type, channel and success', async () => {
    // Recent timestamps: older rows are pruned by log retention at startup.
    const base = Date.now() - 60_000;
    await prisma.notificationLog.createMany({
      data: [
        {
          eventType: 'stream_created',
          channel: 'webhook',
          success: true,
          createdAt: new Date(base),
        },
        {
          eventType: 'stream_created',
          channel: 'webhook',
          success: false,
          error: 'status 500',
          createdAt: new Date(base + 1000),
        },
        {
          eventType: 'ngo_approved',
          channel: 'email',
          success: true,
          createdAt: new Date(base + 2000),
        },
      ],
    });

    const first = await getLogs('?limit=2');
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.total).toBe(3);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.logs.map((log: { eventType: string }) => log.eventType)).toEqual([
      'ngo_approved',
      'stream_created',
    ]);

    const second = (await getLogs(`?limit=2&cursor=${firstBody.nextCursor}`)).json();
    expect(second.logs).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();

    const failedWebhooks = (
      await getLogs('?eventType=stream_created&channel=webhook&success=false')
    ).json();
    expect(failedWebhooks.total).toBe(1);
    expect(failedWebhooks.logs[0]).toMatchObject({ success: false, error: 'status 500' });
  });

  it('returns no URL or secret even if one ended up in the error text', async () => {
    await prisma.notificationLog.create({
      data: {
        eventType: 'stream_created',
        channel: 'webhook:11111111-1111-4111-8111-111111111111',
        success: false,
        error: 'request to https://hooks.example.org/in?token=s3cret failed',
      },
    });

    const response = await getLogs();
    const [log] = response.json().logs;

    expect(Object.keys(log).sort()).toEqual(
      ['channel', 'createdAt', 'error', 'eventId', 'eventType', 'id', 'success'].sort(),
    );
    expect(response.body).not.toContain('hooks.example.org');
    expect(response.body).not.toContain('s3cret');
    expect(log.error).toBe('request to [redacted-url] failed');
  });

  it('rejects an invalid filter', async () => {
    const response = await getLogs('?success=maybe');
    expect(response.statusCode).toBe(400);
  });
});

describe('redactUrls', () => {
  it('leaves plain text and null alone', () => {
    expect(redactUrls('status 503')).toBe('status 503');
    expect(redactUrls(null)).toBeNull();
  });
});
