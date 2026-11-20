import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Prisma is mocked so this runs in the unit project: no database needed to
// fill the de-duplication set past its cap.
const findFirst = vi.fn();
const create = vi.fn();
const upsert = vi.fn();
const findMany = vi.fn();
const deliveryRows = new Map<string, Record<string, unknown>>();
const deliveryByEvent = new Map<string, string>();
let nextDeliveryId = 0;
const deliveryUpsert = vi.fn(
  ({
    where,
    create,
  }: {
    where: { deliveryKey: string };
    create: Record<string, unknown>;
  }) => {
    const key = where.deliveryKey;
    const existingId = deliveryByEvent.get(key);
    if (existingId) return deliveryRows.get(existingId);
    const id = `delivery-${++nextDeliveryId}`;
    const row = {
      ...create,
      id,
      attempts: 0,
      status: 'PENDING',
      nextAttemptAt: new Date(0),
      lockedUntil: null,
      maxAttempts: 5,
    };
    deliveryByEvent.set(key, id);
    deliveryRows.set(id, row);
    return row;
  },
);
const deliveryFindUnique = vi.fn(({ where }: { where: { id: string } }) =>
  deliveryRows.get(where.id) ?? null,
);
const deliveryUpdateMany = vi.fn(({ where }: { where: { id: string } }) => {
    const row = deliveryRows.get(where.id);
    if (!row) return { count: 0 };
    row.attempts = Number(row.attempts) + 1;
    row.lockedUntil = new Date(Date.now() + 60_000);
    return { count: 1 };
});
const deliveryUpdate = vi.fn(
  ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = deliveryRows.get(where.id);
    if (!row) throw new Error('delivery not found');
    Object.assign(row, data);
    return row;
  },
);
vi.mock('../../src/db.js', () => ({
  prisma: {
    notificationLog: { findFirst, create, upsert },
    notificationEndpoint: { findMany },
    webhookDelivery: {
      upsert: deliveryUpsert,
      findUnique: deliveryFindUnique,
      findUniqueOrThrow: deliveryFindUnique,
      updateMany: deliveryUpdateMany,
      update: deliveryUpdate,
    },
  },
}));

const {
  _MAX_DELIVERED_EVENT_IDS_FOR_TEST: CAP,
  _deliveredEventIdCountForTest: deliveredCount,
  _resetDeliveredEventIdsForTest,
  notify,
} = await import('../../src/notifications/service.js');

import type { NotificationEvent } from '../../src/notifications/types.js';

const eventWithId = (n: number): NotificationEvent => ({
  type: 'ngo_approved',
  ownerAddress: 'GOWNER',
  ngoId: 'NGO1',
  eventId: `evt-${n}`,
});

describe('notify de-duplication cap', () => {
  const originalUrl = process.env.NOTIFY_WEBHOOK_URL;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetDeliveredEventIdsForTest();
    findFirst.mockReset().mockResolvedValue(null);
    create.mockReset().mockResolvedValue({});
    upsert.mockReset().mockResolvedValue({});
    findMany.mockReset().mockResolvedValue([]); // no table endpoints: env fallback
    deliveryRows.clear();
    deliveryByEvent.clear();
    nextDeliveryId = 0;
    deliveryUpsert.mockClear();
    deliveryFindUnique.mockClear();
    deliveryUpdateMany.mockClear();
    deliveryUpdate.mockClear();
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.NOTIFY_WEBHOOK_URL;
    else process.env.NOTIFY_WEBHOOK_URL = originalUrl;
  });

  const fill = async (count: number) => {
    for (let i = 0; i < count; i += 1) await notify(eventWithId(i));
  };

  it('stays bounded at the cap when more ids are delivered than it holds', async () => {
    await fill(CAP + 50);

    expect(deliveredCount()).toBe(CAP);
  });

  it('uses the durable outbox to avoid resending ids after in-memory eviction', async () => {
    await fill(CAP + 1); // evt-0 is evicted
    fetchSpy.mockClear();

    await notify(eventWithId(CAP)); // newest: still remembered, not resent
    expect(fetchSpy).not.toHaveBeenCalled();

    await notify(eventWithId(0)); // forgotten in memory, but still persisted as delivered
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still delivers the event that triggers an eviction', async () => {
    await fill(CAP);
    fetchSpy.mockClear();

    await expect(notify(eventWithId(CAP))).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(deliveredCount()).toBe(CAP);
  });

  it('keeps delivering after many evictions without throwing', async () => {
    await expect(fill(CAP + 200)).resolves.toBeUndefined();
    fetchSpy.mockClear();

    await notify(eventWithId(CAP + 200));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('stays bounded when ids are recovered from the persisted delivery log', async () => {
    await fill(CAP);
    findFirst.mockResolvedValue({ id: 1 }); // every later id was delivered before a restart

    for (let i = CAP; i < CAP + 25; i += 1) await notify(eventWithId(i));

    expect(deliveredCount()).toBe(CAP);
  });
});
