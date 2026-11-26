import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';

const at = (minute: number) => new Date(Date.UTC(2026, 4, 1, 0, minute));

async function createNgo(char: string) {
  return prisma.ngo.create({
    data: { ownerAddress: fakeAddress(char), name: `NGO ${char}`, verified: true },
  });
}

async function createStream(
  ngoId: string,
  onChainId: bigint,
  minute: number,
  status: 'ACTIVE' | 'CANCELLED' = 'ACTIVE',
) {
  const donor = await prisma.donor.upsert({
    where: { address: fakeAddress('D') },
    create: { address: fakeAddress('D') },
    update: {},
  });
  return prisma.stream.create({
    data: {
      onChainId,
      donorId: donor.id,
      ngoId,
      tokenAddress: fakeAddress('T'),
      rate: '1',
      balance: '100',
      withdrawn: '0',
      status,
      createdAt: at(minute),
    },
  });
}

describe('GET /v1/ngos/:id/streams', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('answers 404 for an unknown NGO and 400 for an invalid id, status or limit', async () => {
    const app = buildServer();
    const ngo = await createNgo('A');

    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/ngos/11111111-1111-4111-8111-111111111111/streams',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found' });

    for (const url of [
      '/v1/ngos/not-a-uuid/streams',
      `/v1/ngos/${ngo.id}/streams?status=PAUSED`,
      `/v1/ngos/${ngo.id}/streams?limit=0`,
      `/v1/ngos/${ngo.id}/streams?limit=101`,
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(400);
    }

    await app.close();
  });

  it('returns an empty page for an NGO without streams', async () => {
    const app = buildServer();
    const ngo = await createNgo('A');

    const response = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}/streams` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ streams: [], hasMore: false, nextCursor: null });

    await app.close();
  });

  it('lists only the NGO streams, newest first, with serialized ids', async () => {
    const app = buildServer();
    const ngo = await createNgo('A');
    const other = await createNgo('B');
    const oldest = await createStream(ngo.id, 1n, 1);
    const newest = await createStream(ngo.id, 2n, 2);
    await createStream(other.id, 3n, 3);

    const response = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}/streams` });

    expect(response.statusCode).toBe(200);
    const { streams } = response.json();
    expect(streams.map((s: { id: string }) => s.id)).toEqual([newest.id, oldest.id]);
    expect(streams[0]).toMatchObject({ onChainId: '2', ngoId: ngo.id, status: 'ACTIVE' });
    expect(streams[0].ngo).toMatchObject({ id: ngo.id, name: 'NGO A' });

    await app.close();
  });

  it('pages with a cursor and rejects a cursor that is not one of the NGO streams', async () => {
    const app = buildServer();
    const ngo = await createNgo('A');
    const other = await createNgo('B');
    const first = await createStream(ngo.id, 1n, 1);
    const second = await createStream(ngo.id, 2n, 2);
    const third = await createStream(ngo.id, 3n, 3);
    const foreign = await createStream(other.id, 4n, 4);
    const url = `/v1/ngos/${ngo.id}/streams`;

    const page1 = (await app.inject({ method: 'GET', url: `${url}?limit=2` })).json();
    expect(page1.streams.map((s: { id: string }) => s.id)).toEqual([third.id, second.id]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(second.id);

    const page2 = (await app.inject({ method: 'GET', url: `${url}?limit=2&cursor=${page1.nextCursor}` })).json();
    expect(page2.streams.map((s: { id: string }) => s.id)).toEqual([first.id]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    for (const cursor of [foreign.id, '11111111-1111-4111-8111-111111111111', 'nope']) {
      expect((await app.inject({ method: 'GET', url: `${url}?cursor=${cursor}` })).statusCode, cursor).toBe(400);
    }

    await app.close();
  });

  it('filters by status', async () => {
    const app = buildServer();
    const ngo = await createNgo('A');
    const active = await createStream(ngo.id, 1n, 1, 'ACTIVE');
    const cancelled = await createStream(ngo.id, 2n, 2, 'CANCELLED');
    const url = `/v1/ngos/${ngo.id}/streams`;

    const onlyActive = (await app.inject({ method: 'GET', url: `${url}?status=ACTIVE` })).json();
    const onlyCancelled = (await app.inject({ method: 'GET', url: `${url}?status=CANCELLED` })).json();

    expect(onlyActive.streams.map((s: { id: string }) => s.id)).toEqual([active.id]);
    expect(onlyCancelled.streams.map((s: { id: string }) => s.id)).toEqual([cancelled.id]);

    await app.close();
  });

  it('sends the same cache headers as the other lists and answers 304 for a matching ETag', async () => {
    const app = buildServer();
    const ngo = await createNgo('A');
    await createStream(ngo.id, 1n, 1);
    const url = `/v1/ngos/${ngo.id}/streams`;

    const first = await app.inject({ method: 'GET', url });
    expect(first.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=60');
    expect(first.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);

    const second = await app.inject({ method: 'GET', url, headers: { 'if-none-match': first.headers.etag as string } });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');

    await app.close();
  });
});
