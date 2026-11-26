import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { signAdminRequest } from '../helpers/adminAuth.js';
import { resetDb } from '../helpers/db.js';

const adminKeypair = Keypair.random();
const URL = '/v1/admin/overview';
const day = (n: number) => new Date(`2026-05-${String(n).padStart(2, '0')}T00:00:00.000Z`);

describe('GET /v1/admin/overview', () => {
  const originalAdmins = process.env.ADMIN_ADDRESSES;
  let offset = 0;

  beforeEach(async () => {
    process.env.ADMIN_ADDRESSES = adminKeypair.publicKey();
    await resetDb();
  });

  afterEach(async () => {
    await resetDb();
    if (originalAdmins === undefined) delete process.env.ADMIN_ADDRESSES;
    else process.env.ADMIN_ADDRESSES = originalAdmins;
  });

  const signed = () => signAdminRequest(adminKeypair, 'GET', URL, String(Date.now() + offset++));

  it('requires an admin signature', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('reports zero counts and no oldest item for empty queues', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: URL, headers: signed() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      pendingApplications: { count: 0, oldest: null },
      unresolvedDeadLetters: { count: 0, oldest: null },
      failedWebhookDeliveries: { count: 0, oldest: null },
    });

    await app.close();
  });

  it('counts only open items and returns the oldest of each queue', async () => {
    const app = buildServer();
    const application = (name: string, status: 'PENDING' | 'APPROVED', createdAt: Date) =>
      prisma.ngoApplication.create({
        data: {
          ownerAddress: Keypair.random().publicKey(),
          name,
          description: 'desc',
          contactEmail: 'ngo@example.com',
          status,
          createdAt,
        },
      });
    await application('Newer pending', 'PENDING', day(5));
    const oldestApplication = await application('Oldest pending', 'PENDING', day(2));
    await application('Approved', 'APPROVED', day(1));

    await prisma.indexerDeadLetter.create({ data: { eventId: 'e-new', ledger: 5, error: 'x', createdAt: day(6) } });
    const oldestDeadLetter = await prisma.indexerDeadLetter.create({
      data: { eventId: 'e-old', ledger: 3, error: 'x', createdAt: day(3) },
    });
    await prisma.indexerDeadLetter.create({
      data: { eventId: 'e-done', ledger: 1, error: 'x', createdAt: day(1), resolvedAt: day(2) },
    });

    const delivery = (key: string, status: 'FAILED' | 'PENDING' | 'SUCCEEDED', createdAt: Date) =>
      prisma.webhookDelivery.create({
        data: {
          deliveryKey: key,
          eventType: 'stream_created',
          channel: 'webhook:test',
          url: 'https://example.com/hook',
          payload: '{}',
          status,
          createdAt,
        },
      });
    await delivery('k-new', 'FAILED', day(9));
    const oldestFailed = await delivery('k-old', 'FAILED', day(4));
    await delivery('k-pending', 'PENDING', day(1));
    await delivery('k-ok', 'SUCCEEDED', day(1));

    const response = await app.inject({ method: 'GET', url: URL, headers: signed() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      pendingApplications: {
        count: 2,
        oldest: { id: oldestApplication.id, name: 'Oldest pending', createdAt: day(2).toISOString() },
      },
      unresolvedDeadLetters: {
        count: 2,
        oldest: { id: oldestDeadLetter.id, eventId: 'e-old', createdAt: day(3).toISOString() },
      },
      failedWebhookDeliveries: {
        count: 2,
        oldest: {
          id: oldestFailed.id,
          channel: 'webhook:test',
          eventType: 'stream_created',
          createdAt: day(4).toISOString(),
        },
      },
    });

    await app.close();
  });
});
