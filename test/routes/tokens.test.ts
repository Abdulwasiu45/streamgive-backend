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
    });

    await app.close();
  });

  it('returns an empty list when no streams exist', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/tokens' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tokens: [] });

    await app.close();
  });
});
