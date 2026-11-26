import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, fakeContractAddress, resetDb } from '../helpers/db.js';

describe('GET /v1/tokens', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns distinct token addresses with a stream count for each', async () => {
    const app = buildServer();
    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });
    const firstToken = fakeContractAddress('C');
    const secondToken = fakeContractAddress('D');

    await prisma.stream.createMany({
      data: [
        {
          onChainId: 1n,
          donorId: donor.id,
          ngoId: ngo.id,
          tokenAddress: secondToken,
          rate: '1',
          balance: '100',
          withdrawn: '0',
        },
        {
          onChainId: 2n,
          donorId: donor.id,
          ngoId: ngo.id,
          tokenAddress: firstToken,
          rate: '1',
          balance: '200',
          withdrawn: '0',
        },
        {
          onChainId: 3n,
          donorId: donor.id,
          ngoId: ngo.id,
          tokenAddress: firstToken,
          rate: '1',
          balance: '300',
          withdrawn: '0',
        },
      ],
    });

    const response = await app.inject({ method: 'GET', url: '/v1/tokens' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tokens: [
        { tokenAddress: firstToken, streamCount: 2 },
        { tokenAddress: secondToken, streamCount: 1 },
      ],
      hasMore: false,
      nextCursor: null,
    });

    await app.close();
  });

  it('pages tokens by address and limits each response', async () => {
    const app = buildServer();
    const donor = await prisma.donor.create({ data: { address: fakeAddress('E') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('F'), name: 'NGO', verified: true },
    });
    const tokenAddresses = ['G', 'H', 'I'].map(fakeContractAddress).sort();

    await prisma.stream.createMany({
      data: tokenAddresses.map((tokenAddress, index) => ({
        onChainId: BigInt(index + 10),
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress,
        rate: '1',
        balance: '100',
        withdrawn: '0',
      })),
    });

    const first = await app.inject({ method: 'GET', url: '/v1/tokens?limit=2' });
    expect(first.statusCode).toBe(200);
    expect(
      first.json().tokens.map((token: { tokenAddress: string }) => token.tokenAddress),
    ).toEqual(tokenAddresses.slice(0, 2));
    expect(first.json().hasMore).toBe(true);

    const nextCursor = first.json().nextCursor as string;
    const second = await app.inject({
      method: 'GET',
      url: `/v1/tokens?limit=2&cursor=${nextCursor}`,
    });
    expect(second.statusCode).toBe(200);
    expect(
      second.json().tokens.map((token: { tokenAddress: string }) => token.tokenAddress),
    ).toEqual(tokenAddresses.slice(2));
    expect(second.json().hasMore).toBe(false);
    expect(second.json().nextCursor).toBeNull();

    await app.close();
  });

  it('returns an empty list when no streams exist', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/tokens' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tokens: [], hasMore: false, nextCursor: null });

    await app.close();
  });

  it('rejects invalid limits and token cursors', async () => {
    const app = buildServer();

    expect((await app.inject({ method: 'GET', url: '/v1/tokens?limit=101' })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/tokens?cursor=not-a-token' })).statusCode,
    ).toBe(400);

    await app.close();
  });
});
