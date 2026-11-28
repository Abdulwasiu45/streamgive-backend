import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, fakeContractAddress, resetDb } from '../helpers/db.js';

async function seedStream(onChainId: bigint, token: string) {
  const donor = await prisma.donor.upsert({
    where: { address: fakeAddress('A') },
    create: { address: fakeAddress('A') },
    update: {},
  });
  const ngo = await prisma.ngo.upsert({
    where: { ownerAddress: fakeAddress('B') },
    create: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    update: {},
  });
  await prisma.stream.create({
    data: {
      onChainId,
      donorId: donor.id,
      ngoId: ngo.id,
      tokenAddress: token,
      rate: '1',
      balance: '100',
      withdrawn: '0',
    },
  });
}

describe('GET /v1/tokens caching', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('sends an ETag and a public Cache-Control header, also for an empty table', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/tokens' });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(response.headers['cache-control']).toBe(
      'public, max-age=30, stale-while-revalidate=60',
    );

    await app.close();
  });

  it('answers 304 with no body when If-None-Match matches, including weak and wildcard forms', async () => {
    const app = buildServer();
    await seedStream(1n, fakeContractAddress('C'));
    const first = await app.inject({ method: 'GET', url: '/v1/tokens' });
    const etag = first.headers.etag as string;

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/tokens',
        headers: { 'if-none-match': header },
      });
      expect(response.statusCode, header).toBe(304);
      expect(response.body).toBe('');
      expect(response.headers.etag).toBe(etag);
    }

    await app.close();
  });

  it('answers 200 with the list when If-None-Match is stale', async () => {
    const app = buildServer();
    const token = fakeContractAddress('C');
    await seedStream(1n, token);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tokens',
      headers: { 'if-none-match': '"stale"' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tokens: [{ tokenAddress: token, streamCount: 1 }] });

    await app.close();
  });

  it('changes the ETag when the data changes and the old validator stops matching', async () => {
    const app = buildServer();
    const token = fakeContractAddress('C');
    await seedStream(1n, token);
    const before = await app.inject({ method: 'GET', url: '/v1/tokens' });

    await seedStream(2n, token);
    const after = await app.inject({
      method: 'GET',
      url: '/v1/tokens',
      headers: { 'if-none-match': before.headers.etag as string },
    });

    expect(after.statusCode).toBe(200);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    expect(after.json()).toEqual({ tokens: [{ tokenAddress: token, streamCount: 2 }] });

    await app.close();
  });
});
