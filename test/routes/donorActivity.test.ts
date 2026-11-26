import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';

const at = (minute: number) => new Date(Date.UTC(2026, 4, 1, 0, minute));

async function createStream(donorId: string, ngoId: string, onChainId: bigint) {
  return prisma.stream.create({
    data: {
      onChainId,
      donorId,
      ngoId,
      tokenAddress: fakeAddress('T'),
      rate: '1',
      balance: '100',
      withdrawn: '0',
    },
  });
}

const event = (streamId: bigint, type: string, minute: number) =>
  prisma.streamEvent.create({
    data: { type, streamId, ledger: 100 + minute, txHash: `tx-${type}-${minute}`, payload: {}, createdAt: at(minute) },
  });

describe('GET /v1/donors/:address/activity', () => {
  afterEach(async () => {
    await resetDb();
  });

  async function seed() {
    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const other = await prisma.donor.create({ data: { address: fakeAddress('B') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('N'), name: 'NGO', verified: true },
    });
    await createStream(donor.id, ngo.id, 1n);
    await createStream(donor.id, ngo.id, 2n);
    await createStream(other.id, ngo.id, 3n);
    const a = await event(1n, 'created', 1);
    const b = await event(2n, 'created', 2);
    const c = await event(1n, 'withdraw', 3);
    const d = await event(2n, 'cancel', 4);
    await event(3n, 'created', 5); // another donor's stream
    return { donor, ids: { a: a.id, b: b.id, c: c.id, d: d.id } };
  }

  it('returns the events of all of a donor streams in one feed, newest first', async () => {
    const app = buildServer();
    const { donor, ids } = await seed();

    const response = await app.inject({ method: 'GET', url: `/v1/donors/${donor.address}/activity` });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBeDefined();
    const body = response.json();
    expect(body.events.map((e: { id: string }) => e.id)).toEqual([ids.d, ids.c, ids.b, ids.a]);
    expect(body.events.map((e: { streamId: string }) => e.streamId)).toEqual(['2', '1', '2', '1']);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();

    await app.close();
  });

  it('pages through the feed with a cursor', async () => {
    const app = buildServer();
    const { donor, ids } = await seed();
    const url = `/v1/donors/${donor.address}/activity`;

    const first = (await app.inject({ method: 'GET', url: `${url}?limit=3` })).json();
    expect(first.events.map((e: { id: string }) => e.id)).toEqual([ids.d, ids.c, ids.b]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(ids.b);

    const second = (await app.inject({ method: 'GET', url: `${url}?limit=3&cursor=${first.nextCursor}` })).json();
    expect(second.events.map((e: { id: string }) => e.id)).toEqual([ids.a]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();

    await app.close();
  });

  it('returns an empty feed for a donor without streams', async () => {
    const app = buildServer();
    const donor = await prisma.donor.create({ data: { address: fakeAddress('C') } });

    const response = await app.inject({ method: 'GET', url: `/v1/donors/${donor.address}/activity` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [], hasMore: false, nextCursor: null });

    await app.close();
  });

  it('answers 404 for an unknown donor and 400 for a bad address, limit or cursor', async () => {
    const app = buildServer();
    const { donor } = await seed();

    const unknown = await app.inject({ method: 'GET', url: `/v1/donors/${fakeAddress('Z')}/activity` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found' });

    for (const url of [
      '/v1/donors/not-an-address/activity',
      `/v1/donors/${donor.address}/activity?limit=0`,
      `/v1/donors/${donor.address}/activity?cursor=not-a-uuid`,
      `/v1/donors/${donor.address}/activity?cursor=11111111-1111-4111-8111-111111111111`,
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(400);
    }

    await app.close();
  });
});
