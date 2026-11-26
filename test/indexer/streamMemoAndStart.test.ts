import { xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/notifications/service.js', () => ({ dispatchNotification: vi.fn() }));

import { prisma } from '../../src/db.js';
import { handleDonationVaultEvent } from '../../src/indexer/handlers/donationVault.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import {
  addressScVal,
  i128ScVal,
  makeEvent,
  stringScVal,
  symbolScVal,
  u64ScVal,
} from '../helpers/events.js';

const required = () => [
  addressScVal(fakeAddress('A')),
  addressScVal(fakeAddress('B')),
  addressScVal(fakeAddress('C')),
  i128ScVal(1000n),
  i128ScVal(10n),
];

const created = (id: bigint, ...extra: xdr.ScVal[]) =>
  makeEvent([symbolScVal('created'), u64ScVal(id)], xdr.ScVal.scvVec([...required(), ...extra]));

describe('stream memo and delayed start from the created event', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
  });

  it('stores the memo and the start time', async () => {
    await handleDonationVaultEvent(created(1n, stringScVal('Monthly gift'), u64ScVal(1_800_000_000n)));

    const stream = await prisma.stream.findUnique({ where: { onChainId: 1n } });
    expect(stream?.memo).toBe('Monthly gift');
    expect(stream?.startsAt).toEqual(new Date(1_800_000_000 * 1000));
    const event = await prisma.streamEvent.findFirst({ where: { type: 'created', streamId: 1n } });
    expect(event?.payload).toMatchObject({
      memo: 'Monthly gift',
      startsAt: '2027-01-15T08:00:00.000Z',
    });
  });

  it('leaves both columns null for a created event without the optional values', async () => {
    await handleDonationVaultEvent(created(2n));

    const stream = await prisma.stream.findUnique({ where: { onChainId: 2n } });
    expect(stream?.memo).toBeNull();
    expect(stream?.startsAt).toBeNull();
    expect(stream?.balance).toBe('1000');
  });

  it('treats an empty memo, a void value or a zero start as absent and caps a long memo', async () => {
    await handleDonationVaultEvent(created(3n, stringScVal(''), u64ScVal(0n)));
    await handleDonationVaultEvent(created(4n, xdr.ScVal.scvVoid(), xdr.ScVal.scvVoid()));
    await handleDonationVaultEvent(created(5n, stringScVal('x'.repeat(400))));

    for (const id of [3n, 4n]) {
      const stream = await prisma.stream.findUnique({ where: { onChainId: id } });
      expect(stream?.memo, String(id)).toBeNull();
      expect(stream?.startsAt, String(id)).toBeNull();
    }
    expect((await prisma.stream.findUnique({ where: { onChainId: 5n } }))?.memo).toHaveLength(256);
  });

  it('keeps the stored values when the same event is replayed', async () => {
    const event = created(6n, stringScVal('First'), u64ScVal(1_800_000_000n));
    await handleDonationVaultEvent(event);
    await handleDonationVaultEvent(
      created(6n, stringScVal('Different'), u64ScVal(1_900_000_000n)),
    );

    const stream = await prisma.stream.findUnique({ where: { onChainId: 6n } });
    expect(stream?.memo).toBe('First');
    expect(stream?.startsAt).toEqual(new Date(1_800_000_000 * 1000));
  });

  it('returns the memo and start time on stream responses, as null when absent', async () => {
    const app = buildServer();
    await handleDonationVaultEvent(created(7n, stringScVal('Hello'), u64ScVal(1_800_000_000n)));
    await handleDonationVaultEvent(created(8n));
    const withMemo = await prisma.stream.findUniqueOrThrow({ where: { onChainId: 7n } });

    const detail = await app.inject({ method: 'GET', url: `/v1/streams/${withMemo.id}` });
    expect(detail.json()).toMatchObject({ memo: 'Hello', startsAt: '2027-01-15T08:00:00.000Z' });

    const onChain = await app.inject({ method: 'GET', url: '/v1/streams/on-chain/8' });
    expect(onChain.json()).toMatchObject({ memo: null, startsAt: null });

    const list = await app.inject({ method: 'GET', url: '/v1/streams' });
    const byId = new Map(
      (list.json().streams as { onChainId: string; memo: string | null }[]).map((s) => [s.onChainId, s.memo]),
    );
    expect(byId.get('7')).toBe('Hello');
    expect(byId.get('8')).toBeNull();

    await app.close();
  });
});
