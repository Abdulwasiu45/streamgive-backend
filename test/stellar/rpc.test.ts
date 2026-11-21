import { beforeEach, describe, expect, it, vi } from 'vitest';

const { simulateTransaction } = vi.hoisted(() => ({
  simulateTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk/rpc')>();
  return {
    ...actual,
    Server: class {
      simulateTransaction(transaction: unknown) {
        return simulateTransaction(transaction);
      }
    },
  };
});

import { nativeToScVal, Transaction } from '@stellar/stellar-sdk';
import type { Server } from '@stellar/stellar-sdk/rpc';
import { callContract, RpcFailoverClient } from '../../src/stellar/rpc.js';
import { fakeContractAddress } from '../helpers/db.js';

beforeEach(() => {
  simulateTransaction.mockReset();
});

describe('callContract', () => {
  it('simulates a read-only call and decodes its return value', async () => {
    simulateTransaction.mockResolvedValue({
      result: { retval: nativeToScVal('result') },
    });

    const result = await callContract<string>(fakeContractAddress('A'), 'read');

    expect(result).toBe('result');
    expect(simulateTransaction).toHaveBeenCalledOnce();
    expect(simulateTransaction.mock.calls[0][0]).toBeInstanceOf(Transaction);
  });
});

describe('RpcFailoverClient', () => {
  const urls = ['https://rpc-1.test', 'https://rpc-2.test', 'https://rpc-3.test'];

  it('fails over in order and remembers the last working endpoint', async () => {
    let clock = 1_000;
    const calls: string[] = [];
    const client = new RpcFailoverClient(urls, {
      primaryRetryMs: 60_000,
      now: () => clock,
      createServer: (url) => ({ url }) as unknown as Server,
    });

    const first = await client.execute(async (_server, url) => {
      calls.push(url);
      if (url === urls[0]) throw new Error('primary down');
      return `ok:${url}`;
    });

    expect(first).toBe('ok:https://rpc-2.test');
    expect(calls).toEqual([urls[0], urls[1]]);
    expect(client.activeUrl).toBe(urls[1]);

    // Before primaryRetryMs elapses, subsequent calls go directly to the remembered fallback.
    clock += 10_000;
    calls.length = 0;
    const second = await client.execute(async (_server, url) => {
      calls.push(url);
      return `ok:${url}`;
    });

    expect(second).toBe('ok:https://rpc-2.test');
    expect(calls).toEqual([urls[1]]);
  });

  it('recovers to the primary after primaryRetryMs elapses even under steady traffic', async () => {
    let clock = 0;
    let primaryHealthy = false;
    const calls: string[] = [];
    const client = new RpcFailoverClient(urls.slice(0, 2), {
      primaryRetryMs: 30_000,
      now: () => clock,
      createServer: (url) => ({ url }) as unknown as Server,
    });

    // Fail over to secondary at t=0.
    await client.execute(async (_server, url) => {
      calls.push(url);
      if (url === urls[0] && !primaryHealthy) throw new Error('primary down');
      return url;
    });
    expect(client.activeUrl).toBe(urls[1]);

    // Steady call at t=20s should stay on secondary without resetting failover timestamp.
    clock = 20_000;
    calls.length = 0;
    await client.execute(async (_server, url) => {
      calls.push(url);
      return url;
    });
    expect(calls).toEqual([urls[1]]);

    // At t=30s, primary is healthy again and should be probed and restored.
    clock = 30_000;
    primaryHealthy = true;
    calls.length = 0;
    const recovered = await client.execute(async (_server, url) => {
      calls.push(url);
      if (url === urls[0] && !primaryHealthy) throw new Error('primary down');
      return url;
    });

    expect(recovered).toBe(urls[0]);
    expect(calls).toEqual([urls[0]]);
    expect(client.activeUrl).toBe(urls[0]);
  });

  it('throws the last error when all endpoints fail', async () => {
    const client = new RpcFailoverClient(urls.slice(0, 2), {
      createServer: (url) => ({ url }) as unknown as Server,
    });

    await expect(
      client.execute(async (_server, url) => {
        throw new Error(`failed:${url}`);
      }),
    ).rejects.toThrow(`failed:${urls[1]}`);
  });
});
