import 'dotenv/config';

import { pathToFileURL } from 'node:url';

import { prisma } from '../db.js';
import { createScriptLogger } from './logger.js';

const logger = createScriptLogger({ json: process.argv.includes('--json') });

export type StreamStatusValue = 'ACTIVE' | 'PAUSED' | 'CANCELLED';

export interface StreamState {
  balance: string;
  withdrawn: string;
  status: StreamStatusValue;
}

export interface StoredStreamEvent {
  type: string;
  payload: unknown;
}

export interface StreamDifference {
  onChainId: string;
  stored: StreamState;
  rebuilt: StreamState;
}

export interface RebuildReport {
  checked: number;
  /** Streams with no stored `created` event, so nothing to rebuild from. */
  skipped: string[];
  differences: StreamDifference[];
  updated: number;
}

function amount(payload: unknown, field: string): bigint {
  const value =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`stream event payload has no integer "${field}"`);
  }
  return BigInt(value);
}

/**
 * Replays one stream's stored events, oldest first, with the same rules the
 * donation-vault handlers apply live. Returns null when there is no `created`
 * event to start from.
 */
export function computeStreamState(events: readonly StoredStreamEvent[]): StreamState | null {
  let state: { balance: bigint; withdrawn: bigint; status: StreamStatusValue } | null = null;

  for (const event of events) {
    if (event.type === 'created') {
      // The handler upserts with `update: {}`, so a repeated created is a no-op.
      state ??= { balance: amount(event.payload, 'deposit'), withdrawn: 0n, status: 'ACTIVE' };
      continue;
    }
    if (state === null || state.status === 'CANCELLED') continue;

    if (event.type === 'withdraw') {
      const accrued = amount(event.payload, 'accrued');
      const next = state.balance - accrued;
      state.balance = next < 0n ? 0n : next;
      state.withdrawn += accrued;
    } else if (event.type === 'pause') {
      if (state.status === 'ACTIVE') state.status = 'PAUSED';
    } else if (event.type === 'resume') {
      if (state.status === 'PAUSED') state.status = 'ACTIVE';
    } else if (event.type === 'cancel') {
      state.withdrawn += amount(event.payload, 'accrued');
      state.balance = 0n;
      state.status = 'CANCELLED';
    }
  }

  return state === null
    ? null
    : {
        balance: state.balance.toString(),
        withdrawn: state.withdrawn.toString(),
        status: state.status,
      };
}

function sameState(a: StreamState, b: StreamState): boolean {
  return a.balance === b.balance && a.withdrawn === b.withdrawn && a.status === b.status;
}

/**
 * Recomputes balance, withdrawn and status for every stream from its stored
 * events and reports the rows that differ. Without `dryRun` the differing
 * rows are also corrected.
 */
export async function rebuildStreams(options: { dryRun?: boolean } = {}): Promise<RebuildReport> {
  const streams = await prisma.stream.findMany({
    select: { id: true, onChainId: true, balance: true, withdrawn: true, status: true },
    orderBy: { onChainId: 'asc' },
  });

  const report: RebuildReport = {
    checked: streams.length,
    skipped: [],
    differences: [],
    updated: 0,
  };

  for (const stream of streams) {
    const onChainId = stream.onChainId.toString();
    const events = await prisma.streamEvent.findMany({
      where: { streamId: stream.onChainId },
      orderBy: [{ ledger: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { type: true, payload: true },
    });

    const rebuilt = computeStreamState(events);
    if (rebuilt === null) {
      report.skipped.push(onChainId);
      continue;
    }

    const stored: StreamState = {
      balance: stream.balance,
      withdrawn: stream.withdrawn,
      status: stream.status,
    };
    if (sameState(stored, rebuilt)) continue;

    report.differences.push({ onChainId, stored, rebuilt });
    if (!options.dryRun) {
      await prisma.stream.update({ where: { id: stream.id }, data: rebuilt });
      report.updated += 1;
    }
  }

  return report;
}

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const report = await rebuildStreams({ dryRun });

  for (const { onChainId, stored, rebuilt } of report.differences) {
    logger.info('Stream difference detected', {
      streamId: onChainId,
      stored,
      rebuilt,
    });
  }
  if (report.skipped.length > 0) {
    logger.warn('Streams without created event', { streams: report.skipped.join(', ') });
  }

  const mode = dryRun ? 'dry run, nothing changed' : `${report.updated} updated`;
  logger.info('Rebuild complete', {
    checked: report.checked,
    differences: report.differences.length,
    mode,
  });

  // A dry run doubles as a consistency check.
  if (dryRun && report.differences.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      logger.error('Rebuild failed', { error: String(error) });
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
