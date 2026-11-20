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

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const LATEST_LEDGER_CACHE_TTL_MS = 5_000;

export const rpcServer = new Server(SOROBAN_RPC_URL);

let latestLedgerCache: { sequence: number; expiresAt: number } | undefined;
let latestLedgerRequest: Promise<number> | undefined;

/** Latest ledger sequence the configured RPC node has ingested. */
export async function getLatestLedgerSequence(): Promise<number> {
  if (latestLedgerCache && Date.now() < latestLedgerCache.expiresAt) {
    return latestLedgerCache.sequence;
  }

  if (!latestLedgerRequest) {
    latestLedgerRequest = rpcServer
      .getLatestLedger()
      .then(({ sequence }) => {
        latestLedgerCache = {
          sequence,
          expiresAt: Date.now() + LATEST_LEDGER_CACHE_TTL_MS,
        };
        return sequence;
      })
      .finally(() => {
        latestLedgerRequest = undefined;
      });
  }

  return latestLedgerRequest;
}

/** Call a read-only Soroban contract function and return the decoded result. */
export async function callContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const source = new Account(Keypair.random().publicKey(), '0');
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(0)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);

  if ('error' in sim) {
    throw new Error(`Soroban simulation failed: ${sim.error}`);
  }

  const retVal = 'result' in sim ? sim.result?.retval : undefined;
  if (!retVal) {
    throw new Error('Soroban simulation returned no return value');
  }

  return scValToNative(retVal) as T;
}
