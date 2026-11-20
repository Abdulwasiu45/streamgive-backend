import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamFindMany: vi.fn(),
  streamUpdate: vi.fn(),
  eventFindMany: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  prisma: {
    stream: { findMany: mocks.streamFindMany, update: mocks.streamUpdate },
    streamEvent: { findMany: mocks.eventFindMany },
    $disconnect: vi.fn(),
  },
}));

import { computeStreamState, rebuildStreams } from '../../src/scripts/rebuildStreams.js';

const created = { type: 'created', payload: { deposit: '1000', rate: '10' } };
const withdraw = (accrued: string) => ({ type: 'withdraw', payload: { accrued } });
const cancel = (accrued: string) => ({ type: 'cancel', payload: { accrued, refund: '0' } });

describe('computeStreamState', () => {
  it('applies withdrawals and a cancel in order', () => {
    expect(computeStreamState([created, withdraw('100'), withdraw('50')])).toEqual({
      balance: '850',
      withdrawn: '150',
      status: 'ACTIVE',
    });
    expect(computeStreamState([created, withdraw('100'), cancel('30')])).toEqual({
      balance: '0',
      withdrawn: '130',
      status: 'CANCELLED',
    });
  });

  it('follows the live handler rules for edge cases', () => {
    // Balance never goes negative, events after a cancel are ignored, and a
    // repeated created does not reset the stream.
    expect(
      computeStreamState([created, withdraw('1200'), created, cancel('5'), withdraw('9')]),
    ).toEqual({ balance: '0', withdrawn: '1205', status: 'CANCELLED' });
  });

  it('returns null without a created event and rejects a malformed payload', () => {
    expect(computeStreamState([withdraw('10')])).toBeNull();
    expect(() => computeStreamState([created, { type: 'withdraw', payload: {} }])).toThrow(
      /accrued/,
    );
  });
});

describe('rebuildStreams', () => {
  const healthy = { id: 's1', onChainId: 1n, balance: '900', withdrawn: '100', status: 'ACTIVE' };
  const drifted = { id: 's2', onChainId: 2n, balance: '1000', withdrawn: '0', status: 'ACTIVE' };
  const legacy = { id: 's3', onChainId: 3n, balance: '5', withdrawn: '0', status: 'ACTIVE' };

  beforeEach(() => {
    mocks.streamUpdate.mockReset();
    mocks.streamFindMany.mockResolvedValue([healthy, drifted, legacy]);
    mocks.eventFindMany.mockImplementation(({ where }: { where: { streamId: bigint } }) => {
      if (where.streamId === 1n) return Promise.resolve([created, withdraw('100')]);
      if (where.streamId === 2n) return Promise.resolve([created, cancel('40')]);
      return Promise.resolve([]);
    });
  });

  it('reports differing rows and changes nothing on a dry run', async () => {
    const report = await rebuildStreams({ dryRun: true });

    expect(report).toEqual({
      checked: 3,
      skipped: ['3'],
      differences: [
        {
          onChainId: '2',
          stored: { balance: '1000', withdrawn: '0', status: 'ACTIVE' },
          rebuilt: { balance: '0', withdrawn: '40', status: 'CANCELLED' },
        },
      ],
      updated: 0,
    });
    expect(mocks.streamUpdate).not.toHaveBeenCalled();
  });

  it('corrects only the differing rows otherwise', async () => {
    const report = await rebuildStreams();

    expect(report.updated).toBe(1);
    expect(mocks.streamUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.streamUpdate).toHaveBeenCalledWith({
      where: { id: 's2' },
      data: { balance: '0', withdrawn: '40', status: 'CANCELLED' },
    });
  });
});
