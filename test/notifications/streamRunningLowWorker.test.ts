import { afterEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { fakeAddress, fakeContractAddress, resetDb } from '../helpers/db.js';

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));
vi.mock('../../src/notifications/service.js', () => ({ notify: notifyMock }));

import { notifyStreamsRunningLow } from '../../src/notifications/streamRunningLowWorker.js';

describe('stream running low notifications', () => {
  afterEach(async () => {
    notifyMock.mockReset();
    await resetDb();
  });

  it('notifies once when an active stream is at or below the configured threshold', async () => {
    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'NGO', verified: true },
    });
    const tokenAddress = fakeContractAddress('C');
    const thresholdBalance = (7n * 24n * 60n * 60n * 10n).toString();

    await prisma.stream.createMany({
      data: [
        {
          onChainId: 1n,
          donorId: donor.id,
          ngoId: ngo.id,
          tokenAddress,
          rate: '10',
          balance: thresholdBalance,
          withdrawn: '0',
        },
        {
          onChainId: 2n,
          donorId: donor.id,
          ngoId: ngo.id,
          tokenAddress,
          rate: '10',
          balance: (BigInt(thresholdBalance) + 1n).toString(),
          withdrawn: '0',
        },
        {
          onChainId: 3n,
          donorId: donor.id,
          ngoId: ngo.id,
          tokenAddress,
          rate: '0',
          balance: '0',
          withdrawn: '0',
        },
        {
          onChainId: 4n,
          donorId: donor.id,
          ngoId: ngo.id,
          tokenAddress,
          rate: '0',
          balance: '0',
          withdrawn: '0',
          status: 'CANCELLED',
        },
      ],
    });

    expect(await notifyStreamsRunningLow(7)).toBe(1);
    expect(await notifyStreamsRunningLow(7)).toBe(0);

    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stream_running_low',
        streamId: '1',
        donorAddress: donor.address,
        ngoId: ngo.id,
        remainingSeconds: '604800',
        eventId: expect.stringMatching(/^stream-running-low:/),
      }),
    );

    const notifiedStream = await prisma.stream.findUnique({ where: { onChainId: 1n } });
    expect(notifiedStream?.runningLowNotifiedAt).toBeInstanceOf(Date);
    const aboveThreshold = await prisma.stream.findUnique({ where: { onChainId: 2n } });
    expect(aboveThreshold?.runningLowNotifiedAt).toBeNull();
  });

  it('rejects invalid thresholds rather than silently disabling notifications', async () => {
    await expect(notifyStreamsRunningLow(0)).rejects.toThrow('STREAM_RUNNING_LOW_DAYS');
  });
});
