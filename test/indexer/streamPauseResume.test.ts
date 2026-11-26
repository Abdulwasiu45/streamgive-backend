import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/notifications/service.js', () => ({ dispatchNotification: vi.fn() }));

import { prisma } from '../../src/db.js';
import { handleDonationVaultEvent } from '../../src/indexer/handlers/donationVault.js';
import { remainingSeconds } from '../../src/routes/streamTiming.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { makeEvent, symbolScVal, u64ScVal } from '../helpers/events.js';

const T0 = new Date('2026-06-01T00:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

async function createStream(onChainId: bigint, overrides: Record<string, unknown> = {}) {
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
  return prisma.stream.create({
    data: {
      onChainId,
      donorId: donor.id,
      ngoId: ngo.id,
      tokenAddress: fakeAddress('T'),
      rate: '10',
      balance: '1000',
      withdrawn: '0',
      status: 'ACTIVE',
      updatedAt: T0,
      ...overrides,
    },
  });
}

const eventFor = (topic: string, onChainId: bigint, ledger: number, closedAt: Date) =>
  makeEvent([symbolScVal(topic), u64ScVal(onChainId)], u64ScVal(0n), {
    ledger,
    ledgerClosedAt: closedAt.toISOString(),
  });

describe('stream pause and resume events', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
  });

  it('marks an active stream paused and records when, without moving updatedAt', async () => {
    await createStream(1n);

    await handleDonationVaultEvent(eventFor('pause', 1n, 101, at(30)));

    const stream = await prisma.stream.findUnique({ where: { onChainId: 1n } });
    expect(stream?.status).toBe('PAUSED');
    expect(stream?.pausedAt).toEqual(at(30));
    expect(stream?.updatedAt).toEqual(T0);
    expect(await prisma.streamEvent.count({ where: { type: 'pause', streamId: 1n } })).toBe(1);
  });

  it('ignores a replayed pause event', async () => {
    await createStream(1n);
    const event = eventFor('pause', 1n, 101, at(30));

    await handleDonationVaultEvent(event);
    await handleDonationVaultEvent(event);

    const stream = await prisma.stream.findUnique({ where: { onChainId: 1n } });
    expect(stream?.status).toBe('PAUSED');
    expect(stream?.pausedAt).toEqual(at(30));
    expect(await prisma.streamEvent.count({ where: { type: 'pause' } })).toBe(1);
  });

  it('resumes a paused stream, clears pausedAt and shifts updatedAt by the paused time', async () => {
    await createStream(1n);
    await handleDonationVaultEvent(eventFor('pause', 1n, 101, at(30)));

    await handleDonationVaultEvent(eventFor('resume', 1n, 102, at(90)));

    const stream = await prisma.stream.findUnique({ where: { onChainId: 1n } });
    expect(stream?.status).toBe('ACTIVE');
    expect(stream?.pausedAt).toBeNull();
    expect(stream?.updatedAt).toEqual(at(60));
    expect(await prisma.streamEvent.count({ where: { type: 'resume', streamId: 1n } })).toBe(1);
  });

  it('ignores a replayed resume event and a resume for a stream that is not paused', async () => {
    await createStream(1n);
    await createStream(2n);
    await handleDonationVaultEvent(eventFor('pause', 1n, 101, at(30)));
    const resume = eventFor('resume', 1n, 102, at(90));

    await handleDonationVaultEvent(resume);
    await handleDonationVaultEvent(resume);
    await handleDonationVaultEvent(eventFor('resume', 2n, 103, at(95)));

    const first = await prisma.stream.findUnique({ where: { onChainId: 1n } });
    expect(first?.updatedAt).toEqual(at(60));
    expect(await prisma.streamEvent.count({ where: { type: 'resume' } })).toBe(1);
    expect((await prisma.stream.findUnique({ where: { onChainId: 2n } }))?.status).toBe('ACTIVE');
  });

  it('does not pause a cancelled stream and dead-letters an unknown one', async () => {
    await createStream(1n, { status: 'CANCELLED', rate: '0', balance: '0' });
    const unknown = eventFor('pause', 999n, 104, at(10));

    await handleDonationVaultEvent(eventFor('pause', 1n, 101, at(30)));
    await handleDonationVaultEvent(unknown);

    expect((await prisma.stream.findUnique({ where: { onChainId: 1n } }))?.status).toBe('CANCELLED');
    expect(await prisma.streamEvent.count({ where: { type: 'pause' } })).toBe(0);
    const deadLetter = await prisma.indexerDeadLetter.findUnique({ where: { eventId: unknown.id } });
    expect(deadLetter?.error).toContain('unknown stream: 999');
  });

  it('lists paused streams under the PAUSED status filter and reports their remaining time', async () => {
    const app = buildServer();
    const stream = await createStream(1n, { status: 'PAUSED', pausedAt: at(30) });

    const list = await app.inject({ method: 'GET', url: '/v1/streams?status=PAUSED' });
    expect(list.statusCode).toBe(200);
    expect(list.json().streams.map((s: { id: string }) => s.id)).toEqual([stream.id]);

    const detail = await app.inject({ method: 'GET', url: `/v1/streams/${stream.id}` });
    expect(detail.json()).toMatchObject({ status: 'PAUSED', remainingSeconds: 70 });

    await app.close();
  });
});

describe('remainingSeconds', () => {
  const base = { rate: '10', balance: '1000', updatedAt: T0 };

  it('counts down from balance / rate while the stream is active', () => {
    expect(remainingSeconds({ ...base, status: 'ACTIVE' }, T0)).toBe(100);
    expect(remainingSeconds({ ...base, status: 'ACTIVE' }, at(40))).toBe(60);
    expect(remainingSeconds({ ...base, status: 'ACTIVE' }, at(500))).toBe(0);
  });

  it('freezes at the pause time while paused, however long it stays paused', () => {
    const paused = { ...base, status: 'PAUSED' as const, pausedAt: at(30) };
    expect(remainingSeconds(paused, at(30))).toBe(70);
    expect(remainingSeconds(paused, at(3_600))).toBe(70);
  });

  it('does not count the paused period after a resume shifts updatedAt', () => {
    const resumed = { ...base, status: 'ACTIVE' as const, updatedAt: at(60), pausedAt: null };
    expect(remainingSeconds(resumed, at(90))).toBe(70);
  });

  it('returns 0 for a cancelled stream and null when no end can be derived', () => {
    expect(remainingSeconds({ ...base, status: 'CANCELLED' }, T0)).toBe(0);
    expect(remainingSeconds({ ...base, rate: '0', status: 'ACTIVE' }, T0)).toBeNull();
    expect(remainingSeconds({ ...base, rate: 'abc', status: 'ACTIVE' }, T0)).toBeNull();
  });
});
