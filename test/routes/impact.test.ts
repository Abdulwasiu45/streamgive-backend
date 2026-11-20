import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { MAX_TIMESERIES_DAYS } from '../../src/routes/impact.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';

describe('GET /v1/impact', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('returns zeroed totals when the platform has no data', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/impact' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.totalCommitted).toBe('0');
    expect(body.totalWithdrawn).toBe('0');
    expect(body.activeStreams).toBe(0);
    expect(body.verifiedNgoCount).toBe(0);

    await app.close();
  });

  it('aggregates totals across multiple NGOs and streams', async () => {
    const app = buildServer();

    const ngo1 = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'NGO One', verified: true },
    });
    const ngo2 = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO Two', verified: true },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('C'), name: 'Unverified NGO', verified: false },
    });
    const donor = await prisma.donor.create({ data: { address: fakeAddress('D') } });

    // ngo1: active stream — balance=600, withdrawn=400
    await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo1.id,
        tokenAddress: fakeAddress('T'),
        rate: '10',
        balance: '600',
        withdrawn: '400',
        status: 'ACTIVE',
      },
    });
    // ngo2: cancelled stream — balance=0, withdrawn=200
    await prisma.stream.create({
      data: {
        onChainId: 2n,
        donorId: donor.id,
        ngoId: ngo2.id,
        tokenAddress: fakeAddress('U'),
        rate: '0',
        balance: '0',
        withdrawn: '200',
        status: 'CANCELLED',
      },
    });

    const response = await app.inject({ method: 'GET', url: '/v1/impact' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    // committed = (600+400) + (0+200) = 1200
    expect(body.totalCommitted).toBe('1200');
    expect(body.committedByToken).toEqual([
      { tokenAddress: fakeAddress('T'), amount: '1000' },
      { tokenAddress: fakeAddress('U'), amount: '200' },
    ]);
    // withdrawn = 400 + 200 = 600
    expect(body.totalWithdrawn).toBe('600');
    expect(body.activeStreams).toBe(1);
    expect(body.verifiedNgoCount).toBe(2);

    await app.close();
  });

  it('excludes refunded balance from totalCommitted when a stream is cancelled', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('E'), name: 'Refund NGO', verified: true },
    });
    const donor = await prisma.donor.create({ data: { address: fakeAddress('F') } });

    // Active stream: balance=500, withdrawn=500 → committed = 1000
    await prisma.stream.create({
      data: {
        onChainId: 10n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('T'),
        rate: '10',
        balance: '500',
        withdrawn: '500',
        status: 'ACTIVE',
      },
    });

    // Cancelled stream: 400 was withdrawn to NGO; remaining balance was
    // refunded to donor and zeroed on-chain.  Only 400 must count.
    await prisma.stream.create({
      data: {
        onChainId: 11n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('T'),
        rate: '0',
        balance: '0',
        withdrawn: '400',
        status: 'CANCELLED',
      },
    });

    const response = await app.inject({ method: 'GET', url: '/v1/impact' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    // active 1000 + cancelled 400 = 1400
    expect(body.totalCommitted).toBe('1400');
    expect(body.totalWithdrawn).toBe('900');
    expect(body.activeStreams).toBe(1);

    await app.close();
  });
});

describe('GET /v1/impact/:ngoId', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('400s for a non-UUID id', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/impact/not-a-uuid' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });

    await app.close();
  });

  it('404s for an unknown NGO id', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/impact/00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('returns zero platformSharePercent when the platform has no streams', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('A'),
        name: 'Empty NGO',
        displayName: 'Community Fund',
        verified: true,
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/impact/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.name).toBe('Community Fund');
    expect(body.platformSharePercent).toBe(0);
    expect(body.totalCommitted).toBe('0');
    expect(body.activeStreams).toBe(0);
    expect(body.cancelledStreams).toBe(0);
    expect(body.uniqueDonors).toBe(0);

    await app.close();
  });

  it('computes stats correctly across two NGOs', async () => {
    const app = buildServer();

    const ngo1 = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO One', verified: true },
    });
    const ngo2 = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('C'), name: 'NGO Two', verified: true },
    });
    const donor1 = await prisma.donor.create({ data: { address: fakeAddress('D') } });
    const donor2 = await prisma.donor.create({ data: { address: fakeAddress('E') } });

    // ngo1: one active stream (balance=600, withdrawn=400) + one cancelled (balance=0, withdrawn=200)
    // committed = (600+400) + (0+200) = 1200
    await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor1.id,
        ngoId: ngo1.id,
        tokenAddress: fakeAddress('T'),
        rate: '10',
        balance: '600',
        withdrawn: '400',
        status: 'ACTIVE',
      },
    });
    await prisma.stream.create({
      data: {
        onChainId: 2n,
        donorId: donor2.id,
        ngoId: ngo1.id,
        tokenAddress: fakeAddress('U'),
        rate: '0',
        balance: '0',
        withdrawn: '200',
        status: 'CANCELLED',
      },
    });

    // ngo2: one active stream (balance=600, withdrawn=200)
    // committed = 800
    await prisma.stream.create({
      data: {
        onChainId: 3n,
        donorId: donor1.id,
        ngoId: ngo2.id,
        tokenAddress: fakeAddress('T'),
        rate: '5',
        balance: '600',
        withdrawn: '200',
        status: 'ACTIVE',
      },
    });

    // platform total committed = 1200 + 800 = 2000
    // ngo1 share = 1200 / 2000 = 60%

    const response = await app.inject({ method: 'GET', url: `/v1/impact/${ngo1.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.ngoId).toBe(ngo1.id);
    expect(body.totalCommitted).toBe('1200');
    expect(body.committedByToken).toEqual([
      { tokenAddress: fakeAddress('T'), amount: '1000' },
      { tokenAddress: fakeAddress('U'), amount: '200' },
    ]);
    expect(body.platformCommittedByToken).toEqual([
      { tokenAddress: fakeAddress('T'), amount: '1800' },
      { tokenAddress: fakeAddress('U'), amount: '200' },
    ]);
    expect(body.totalWithdrawn).toBe('600');
    expect(body.activeStreams).toBe(1);
    expect(body.cancelledStreams).toBe(1);
    expect(body.uniqueDonors).toBe(2);
    expect(body.platformSharePercent).toBe(60);

    await app.close();
  });

  it('maintains precision for tiny NGO shares', async () => {
    const app = buildServer();

    const ngo1 = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('X'), name: 'Tiny NGO', verified: true },
    });
    const ngo2 = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('Y'), name: 'Huge NGO', verified: true },
    });
    const donor = await prisma.donor.create({ data: { address: fakeAddress('Z') } });

    // ngo1: 1 unit committed
    await prisma.stream.create({
      data: {
        onChainId: 10n,
        donorId: donor.id,
        ngoId: ngo1.id,
        tokenAddress: fakeAddress('T'),
        rate: '1',
        balance: '1',
        withdrawn: '0',
        status: 'ACTIVE',
      },
    });

    // ngo2: 10000 units committed
    await prisma.stream.create({
      data: {
        onChainId: 11n,
        donorId: donor.id,
        ngoId: ngo2.id,
        tokenAddress: fakeAddress('T'),
        rate: '1',
        balance: '10000',
        withdrawn: '0',
        status: 'ACTIVE',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/impact/${ngo1.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.platformSharePercent).toBeGreaterThan(0);
    expect(body.platformSharePercent).toBeLessThan(0.01);

    await app.close();
  });

  it('counts unique donors correctly when the same donor has multiple streams', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('F'), name: 'Loyal NGO', verified: true },
    });
    const donor = await prisma.donor.create({ data: { address: fakeAddress('G') } });

    await prisma.stream.create({
      data: {
        onChainId: 4n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('T'),
        rate: '10',
        balance: '100',
        withdrawn: '0',
        status: 'ACTIVE',
      },
    });
    await prisma.stream.create({
      data: {
        onChainId: 5n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('T'),
        rate: '0',
        balance: '0',
        withdrawn: '50',
        status: 'CANCELLED',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/impact/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.uniqueDonors).toBe(1);

    await app.close();
  });

  it('excludes refunded balance from totalCommitted for a cancelled stream', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('H'), name: 'Refund NGO', verified: true },
    });
    const donor1 = await prisma.donor.create({ data: { address: fakeAddress('I') } });
    const donor2 = await prisma.donor.create({ data: { address: fakeAddress('J') } });

    // Active stream: balance=600, withdrawn=400 → committed = 1000
    await prisma.stream.create({
      data: {
        onChainId: 6n,
        donorId: donor1.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('T'),
        rate: '10',
        balance: '600',
        withdrawn: '400',
        status: 'ACTIVE',
      },
    });

    // Cancelled stream: donor deposited 800, 300 was withdrawn to NGO, 500
    // was refunded to donor (reflected as balance=0 after contract settles).
    // totalCommitted must count only the withdrawn 300, not 300+500=800.
    await prisma.stream.create({
      data: {
        onChainId: 7n,
        donorId: donor2.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('T'),
        rate: '0',
        balance: '0',
        withdrawn: '300',
        status: 'CANCELLED',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/impact/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    // active 1000 + cancelled 300 = 1300 (not 1300 + 500 refunded = 1800)
    expect(body.totalCommitted).toBe('1300');
    expect(body.totalWithdrawn).toBe('700');
    expect(body.activeStreams).toBe(1);
    expect(body.cancelledStreams).toBe(1);

    await app.close();
  });
});

describe('GET /v1/impact/:ngoId/timeseries', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('returns a zero-filled day for every date when the NGO has no activity', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('E'), name: 'Quiet NGO', verified: true },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/impact/${ngo.id}/timeseries?from=2026-01-01&to=2026-01-05`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ngoId: ngo.id, from: '2026-01-01', to: '2026-01-05' });
    expect(body.days).toHaveLength(5);
    expect(body.days[0]).toEqual({
      date: '2026-01-01',
      newStreams: 0,
      withdrawals: 0,
      withdrawnAmount: '0',
    });
    expect(
      body.days.every(
        (d: { newStreams: number; withdrawals: number }) =>
          d.newStreams === 0 && d.withdrawals === 0,
      ),
    ).toBe(true);
    await app.close();
  });

  it('counts new streams and sums withdrawals per day for a busy NGO only', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('F'), name: 'Busy NGO', verified: true },
    });
    const other = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('G'), name: 'Other NGO', verified: true },
    });
    const donor = await prisma.donor.create({ data: { address: fakeAddress('H') } });

    const stream = (onChainId: bigint, ngoId: string, createdAt: string) =>
      prisma.stream.create({
        data: {
          onChainId,
          donorId: donor.id,
          ngoId,
          tokenAddress: fakeAddress('T'),
          rate: '1',
          balance: '100',
          withdrawn: '0',
          createdAt: new Date(createdAt),
        },
      });
    await stream(10n, ngo.id, '2026-02-01T09:00:00Z');
    await stream(11n, ngo.id, '2026-02-01T18:00:00Z');
    await stream(12n, ngo.id, '2026-02-03T12:00:00Z');
    await stream(13n, other.id, '2026-02-01T10:00:00Z');

    const withdraw = (streamId: bigint, accrued: string, createdAt: string) =>
      prisma.streamEvent.create({
        data: {
          type: 'withdraw',
          streamId,
          ledger: 1,
          txHash: `tx-${streamId}-${createdAt}`,
          payload: { accrued },
          createdAt: new Date(createdAt),
        },
      });
    await withdraw(10n, '40', '2026-02-02T08:00:00Z');
    await withdraw(11n, '60', '2026-02-02T20:00:00Z');
    await withdraw(12n, '5', '2026-02-03T13:00:00Z');
    await withdraw(13n, '999', '2026-02-02T08:00:00Z'); // other NGO

    const res = await app.inject({
      method: 'GET',
      url: `/v1/impact/${ngo.id}/timeseries?from=2026-02-01&to=2026-02-04`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toEqual([
      { date: '2026-02-01', newStreams: 2, withdrawals: 0, withdrawnAmount: '0' },
      { date: '2026-02-02', newStreams: 0, withdrawals: 2, withdrawnAmount: '100' },
      { date: '2026-02-03', newStreams: 1, withdrawals: 1, withdrawnAmount: '5' },
      { date: '2026-02-04', newStreams: 0, withdrawals: 0, withdrawnAmount: '0' },
    ]);
    await app.close();
  });

  it('caps the range and rejects inverted or malformed ranges', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('J'), name: 'Range NGO', verified: true },
    });
    const get = (q: string) =>
      app.inject({ method: 'GET', url: `/v1/impact/${ngo.id}/timeseries?${q}` });

    const tooLong = await get('from=2026-01-01&to=2026-12-31');
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toEqual({ error: 'range_too_large', maxDays: MAX_TIMESERIES_DAYS });
    expect((await get('from=2026-03-02&to=2026-03-01')).json().error).toBe('invalid_range');
    expect((await get('from=yesterday')).statusCode).toBe(400);

    const defaultRange = await get('');
    expect(defaultRange.statusCode).toBe(200);
    expect(defaultRange.json().days).toHaveLength(30);
    await app.close();
  });

  it('returns 404 for an unknown NGO', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/impact/00000000-0000-4000-8000-000000000000/timeseries',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
