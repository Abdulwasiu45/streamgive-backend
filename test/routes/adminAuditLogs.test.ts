import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { signAdminRequest } from '../helpers/adminAuth.js';
import { resetDb } from '../helpers/db.js';

const adminKeypair = Keypair.random();

describe('GET /v1/admin/audit-logs', () => {
  const originalAdminAddress = process.env.ADMIN_ADDRESS;

  afterEach(async () => {
    if (originalAdminAddress === undefined) delete process.env.ADMIN_ADDRESS;
    else process.env.ADMIN_ADDRESS = originalAdminAddress;
    await resetDb();
  });

  it('requires an admin signature and filters and pages audit records', async () => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
    const app = buildServer();
    const baseTime = new Date('2026-01-01T00:00:00.000Z');
    await prisma.adminAuditLog.createMany({
      data: [
        {
          adminAddress: adminKeypair.publicKey(),
          action: 'ngo_application.approved',
          targetId: 'app-one',
          summary: 'Approved NGO application',
          createdAt: new Date(baseTime.getTime() + 1_000),
        },
        {
          adminAddress: adminKeypair.publicKey(),
          action: 'ngo_application.approved',
          targetId: 'app-four',
          summary: 'Approved NGO application',
          createdAt: new Date(baseTime.getTime() + 2_000),
        },
        {
          adminAddress: adminKeypair.publicKey(),
          action: 'ngo_application.rejected',
          targetId: 'app-two',
          summary: 'Rejected NGO application',
          createdAt: new Date(baseTime.getTime() + 3_000),
        },
        {
          adminAddress: Keypair.random().publicKey(),
          action: 'ngo_application.approved',
          targetId: 'app-three',
          summary: 'Approved NGO application',
          createdAt: new Date(baseTime.getTime() + 4_000),
        },
      ],
    });

    const unsigned = await app.inject({ method: 'GET', url: '/v1/admin/audit-logs' });
    expect(unsigned.statusCode).toBe(401);

    const url = `/v1/admin/audit-logs?adminAddress=${adminKeypair.publicKey()}&action=ngo_application.approved&limit=1`;
    const first = await app.inject({
      method: 'GET',
      url,
      headers: signAdminRequest(adminKeypair, 'GET', url),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      entries: [
        {
          action: 'ngo_application.approved',
          targetId: 'app-four',
          summary: 'Approved NGO application',
        },
      ],
    });

    const nextUrl = `${url}&offset=1`;
    const next = await app.inject({
      method: 'GET',
      url: nextUrl,
      headers: signAdminRequest(adminKeypair, 'GET', nextUrl),
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().entries[0].targetId).toBe('app-one');

    const filteredUrl = '/v1/admin/audit-logs?targetId=app-two';
    const filtered = await app.inject({
      method: 'GET',
      url: filteredUrl,
      headers: signAdminRequest(adminKeypair, 'GET', filteredUrl),
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().total).toBe(1);
    expect(filtered.json().entries[0].targetId).toBe('app-two');

    await app.close();
  });

  it('rejects invalid filters and pagination values', async () => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
    const app = buildServer();
    const url = '/v1/admin/audit-logs?limit=101';
    const response = await app.inject({
      method: 'GET',
      url,
      headers: signAdminRequest(adminKeypair, 'GET', url),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
