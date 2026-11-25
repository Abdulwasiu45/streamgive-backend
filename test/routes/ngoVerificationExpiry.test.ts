import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/notifications/service.js', () => ({ dispatchNotification: vi.fn() }));

import { prisma } from '../../src/db.js';
import { handleNgoRegistryEvent } from '../../src/indexer/handlers/ngoRegistry.js';
import { isVerifiedAt } from '../../src/routes/ngoVerification.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { addressScVal, makeEvent, symbolScVal, u64ScVal } from '../helpers/events.js';

describe('isVerifiedAt', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('is false when the NGO is not verified', () => {
    expect(isVerifiedAt({ verified: false, verifiedUntil: null }, now)).toBe(false);
    expect(isVerifiedAt({ verified: false, verifiedUntil: new Date('2027-01-01') }, now)).toBe(false);
  });

  it('is true without an expiry and before the expiry', () => {
    expect(isVerifiedAt({ verified: true, verifiedUntil: null }, now)).toBe(true);
    expect(isVerifiedAt({ verified: true }, now)).toBe(true);
    expect(isVerifiedAt({ verified: true, verifiedUntil: new Date(now.getTime() + 1) }, now)).toBe(true);
  });

  it('treats the expiry instant and anything after it as expired', () => {
    expect(isVerifiedAt({ verified: true, verifiedUntil: new Date(now.getTime()) }, now)).toBe(false);
    expect(isVerifiedAt({ verified: true, verifiedUntil: new Date(now.getTime() - 1) }, now)).toBe(false);
  });
});

describe('NGO verification expiry in the API', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await resetDb();
  });

  const inMs = (ms: number) => new Date(Date.now() + ms);

  it('lists an NGO whose verification has not expired and an NGO without an expiry', async () => {
    const app = buildServer();
    const soon = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Soon', verified: true, verifiedUntil: inMs(60_000) },
    });
    const forever = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Forever', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/v1/ngos' });

    expect(response.statusCode).toBe(200);
    const listed = response.json().ngos as { id: string; verifiedUntil: string | null }[];
    expect(listed.map((n) => n.id).sort()).toEqual([soon.id, forever.id].sort());
    expect(listed.find((n) => n.id === soon.id)?.verifiedUntil).toBe(soon.verifiedUntil?.toISOString());
    expect(listed.find((n) => n.id === forever.id)?.verifiedUntil).toBeNull();

    await app.close();
  });

  it('drops an expired NGO from the list and reports it unverified in the detail, with the date', async () => {
    const app = buildServer();
    const expiredAt = inMs(-1_000);
    const expired = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('C'), name: 'Expired', verified: true, verifiedUntil: expiredAt },
    });

    const list = await app.inject({ method: 'GET', url: '/v1/ngos' });
    expect(list.json().ngos).toEqual([]);

    const detail = await app.inject({ method: 'GET', url: `/v1/ngos/${expired.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: expired.id,
      verified: false,
      verifiedUntil: expiredAt.toISOString(),
    });

    await app.close();
  });

  it('flips from verified to unverified as the expiry boundary passes', async () => {
    const app = buildServer();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const ngo = await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('D'),
        name: 'Boundary',
        verified: true,
        verifiedUntil: new Date('2026-06-01T00:00:10.000Z'),
      },
    });
    const verifiedFlag = async () =>
      (await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}` })).json().verified;

    expect(await verifiedFlag()).toBe(true);
    vi.setSystemTime(new Date('2026-06-01T00:00:09.999Z'));
    expect(await verifiedFlag()).toBe(true);
    vi.setSystemTime(new Date('2026-06-01T00:00:10.000Z'));
    expect(await verifiedFlag()).toBe(false);

    await app.close();
  });
});

describe('registry events store the verification expiry', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('stores the expiry from an approved event, replaces it on renewal and clears it on revoke', async () => {
    const owner = fakeAddress('E');
    await prisma.ngo.create({ data: { ownerAddress: owner, name: 'Registry NGO' } });
    const topic = (name: string) => [symbolScVal(name), addressScVal(owner)];
    const read = async () => (await prisma.ngo.findUnique({ where: { ownerAddress: owner } }))!;

    await handleNgoRegistryEvent(makeEvent(topic('approved'), u64ScVal(1_800_000_000n)));
    expect((await read()).verifiedUntil).toEqual(new Date(1_800_000_000 * 1000));

    await handleNgoRegistryEvent(makeEvent(topic('renewed'), u64ScVal(1_900_000_000n)));
    const renewed = await read();
    expect(renewed.verified).toBe(true);
    expect(renewed.verifiedUntil).toEqual(new Date(1_900_000_000 * 1000));

    await handleNgoRegistryEvent(makeEvent(topic('revoked'), u64ScVal(0n)));
    const revoked = await read();
    expect(revoked.verified).toBe(false);
    expect(revoked.verifiedUntil).toBeNull();
  });
});
