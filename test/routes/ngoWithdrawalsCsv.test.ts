import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { bodyHash, sep53Hash } from '../../src/middleware/adminAuth.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';

const HEADER_LINE = 'eventId,streamId,tokenAddress,amount,ledger,txHash,withdrawnAt\r\n';

function ownerHeaders(keypair: Keypair, url: string) {
  const timestamp = String(Date.now());
  const message = `GET:${url}:${timestamp}:${bodyHash('')}`;
  return {
    'x-owner-address': keypair.publicKey(),
    'x-owner-timestamp': timestamp,
    'x-owner-signature': Buffer.from(keypair.sign(sep53Hash(message))).toString('base64'),
  };
}

async function createNgo(owner: Keypair, name = 'Owner NGO') {
  return prisma.ngo.create({
    data: { ownerAddress: owner.publicKey(), name, verified: true },
  });
}

async function createStream(ngoId: string, onChainId: bigint, donorChar: string) {
  const donor = await prisma.donor.create({ data: { address: fakeAddress(donorChar) } });
  return prisma.stream.create({
    data: {
      onChainId,
      donorId: donor.id,
      ngoId,
      tokenAddress: fakeAddress('T'),
      rate: '10',
      balance: '500',
      withdrawn: '0',
      status: 'ACTIVE',
    },
  });
}

describe('GET /v1/ngos/:id/withdrawals.csv', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns only the headers for an NGO with no withdrawals', async () => {
    const app = buildServer();
    const owner = Keypair.random();
    const ngo = await createNgo(owner);
    const url = `/v1/ngos/${ngo.id}/withdrawals.csv`;

    const response = await app.inject({ method: 'GET', url, headers: ownerHeaders(owner, url) });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="ngo-${ngo.id}-withdrawals.csv"`,
    );
    expect(response.body).toBe(HEADER_LINE);

    await app.close();
  });

  it('exports one row per withdrawal of the NGO with formula-safe fields', async () => {
    const app = buildServer();
    const owner = Keypair.random();
    const ngo = await createNgo(owner);
    const otherNgo = await createNgo(Keypair.random(), 'Other NGO');
    const stream = await createStream(ngo.id, 7n, 'A');
    const otherStream = await createStream(otherNgo.id, 8n, 'B');

    const withdrawal = await prisma.streamEvent.create({
      data: {
        type: 'withdraw',
        streamId: stream.onChainId,
        ledger: 100,
        txHash: '=cmd|calc',
        payload: { accrued: '250' },
      },
    });
    // Not exported: a different event type, and a withdrawal from another NGO's stream.
    await prisma.streamEvent.create({
      data: { type: 'created', streamId: stream.onChainId, ledger: 90, txHash: 'created-tx', payload: {} },
    });
    await prisma.streamEvent.create({
      data: {
        type: 'withdraw',
        streamId: otherStream.onChainId,
        ledger: 101,
        txHash: 'other-tx',
        payload: { accrued: '999' },
      },
    });
    const url = `/v1/ngos/${ngo.id}/withdrawals.csv`;

    const response = await app.inject({ method: 'GET', url, headers: ownerHeaders(owner, url) });

    expect(response.statusCode).toBe(200);
    const lines = response.body.trim().split(/\r\n/);
    expect(lines).toEqual([
      HEADER_LINE.trim(),
      [
        withdrawal.id,
        '7',
        stream.tokenAddress,
        '250',
        '100',
        "'=cmd|calc",
        withdrawal.createdAt.toISOString(),
      ].join(','),
    ]);

    await app.close();
  });

  it('rejects a signer who does not own the NGO', async () => {
    const app = buildServer();
    const ngo = await createNgo(Keypair.random());
    const url = `/v1/ngos/${ngo.id}/withdrawals.csv`;

    const response = await app.inject({
      method: 'GET',
      url,
      headers: ownerHeaders(Keypair.random(), url),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden' });

    await app.close();
  });

  it('rejects an unsigned request', async () => {
    const app = buildServer();
    const ngo = await createNgo(Keypair.random());

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngos/${ngo.id}/withdrawals.csv`,
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});
