import {
  Account,
  Contract,
  Keypair,
  Networks,
  scValToNative,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';

import { parseConfig, parseRpcUrls } from '../config.js';

export const DEFAULT_PRIMARY_RETRY_MS = 60_000;

export interface RpcFailoverOptions {
  primaryRetryMs?: number;
  now?: () => number;
  createServer?: (url: string) => Server;
}

/**
 * Wraps one or more Soroban RPC URLs and fails over in order. Remembers the
 * last working endpoint for `primaryRetryMs` before probing the primary again
 * so recovery is automatic without hammering a down primary on every call.
 */
export class RpcFailoverClient {
  readonly urls: string[];
  private readonly servers: Server[];
  private readonly primaryRetryMs: number;
  private readonly now: () => number;
  private activeIndex = 0;
  private lastFailoverAt: number | null = null;

  constructor(urls: string[], options: RpcFailoverOptions = {}) {
    if (urls.length === 0) {
      throw new Error('RpcFailoverClient requires at least one RPC URL');
    }
    this.urls = [...urls];
    const factory = options.createServer ?? ((url: string) => new Server(url));
    this.servers = this.urls.map((url) => factory(url));
    this.primaryRetryMs = options.primaryRetryMs ?? DEFAULT_PRIMARY_RETRY_MS;
    this.now = options.now ?? (() => Date.now());
  }

  get activeUrl(): string {
    return this.urls[this.activeIndex];
  }

  get primaryServer(): Server {
    return this.servers[0];
  }

  private shouldProbePrimary(): boolean {
    return (
      this.activeIndex !== 0 &&
      this.lastFailoverAt !== null &&
      this.now() - this.lastFailoverAt >= this.primaryRetryMs
    );
  }

  private attemptOrder(probePrimary: boolean): number[] {
    const count = this.servers.length;
    const start = probePrimary ? 0 : this.activeIndex;
    const order: number[] = [];
    for (let offset = 0; offset < count; offset += 1) {
      order.push((start + offset) % count);
    }
    return order;
  }

  async execute<T>(operation: (server: Server, url: string) => Promise<T>): Promise<T> {
    const probePrimary = this.shouldProbePrimary();
    const order = this.attemptOrder(probePrimary);
    let lastError: unknown;

    for (const index of order) {
      try {
        const result = await operation(this.servers[index], this.urls[index]);
        const switched = this.activeIndex !== index;
        this.activeIndex = index;
        if (index === 0) {
          this.lastFailoverAt = null;
        } else if (switched || probePrimary) {
          this.lastFailoverAt = this.now();
        }
        return result;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  }
}

const initialUrls = parseRpcUrls(process.env.SOROBAN_RPC_URL);
export const rpcClient = new RpcFailoverClient(initialUrls);
export const rpcServer = rpcClient.primaryServer;

/** Latest ledger sequence the configured RPC node has ingested. */
export async function getLatestLedgerSequence(): Promise<number> {
  const { sequence } = await rpcClient.execute((server) => server.getLatestLedger());
  return sequence;
}

/** Call a read-only Soroban contract function and return the decoded result. */
export async function callContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const cfg = parseConfig(process.env);
  const source = new Account(Keypair.random().publicKey(), '0');
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: cfg.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(0)
    .build();

  const sim = await rpcClient.execute((server) => server.simulateTransaction(tx));

  if ('error' in sim) {
    throw new Error(`Soroban simulation failed: ${sim.error}`);
  }

  const retVal = 'result' in sim ? sim.result?.retval : undefined;
  if (!retVal) {
    throw new Error('Soroban simulation returned no return value');
  }

  return scValToNative(retVal) as T;
}
