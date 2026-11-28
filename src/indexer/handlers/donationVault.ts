import { scValToNative } from '@stellar/stellar-sdk';

import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { dispatchNotification } from '../../notifications/service.js';
import { recordDeadLetter } from '../deadLetter.js';
import type { ContractEvent } from '../worker.js';

type DonationDb = Pick<typeof prisma, 'donor' | 'ngo' | 'stream'>;

async function ensureDonor(db: DonationDb, address: string) {
  return db.donor.upsert({
    where: { address },
    create: { address },
    update: {},
  });
}

async function ensureNgo(db: DonationDb, ownerAddress: string) {
  return db.ngo.upsert({
    where: { ownerAddress },
    // A stream can reference an NGO address that hasn't gone through
    // ngo-registry — donation-vault doesn't check registry membership
    // on-chain. Placeholder name until (if) a "register" event arrives;
    // `update: {}` below makes sure we never clobber a real name/verified
    // status that's already on file.
    create: { ownerAddress, name: '', verified: false },
    update: {},
  });
}

const MAX_MEMO_LENGTH = 256;

/** The optional memo of a `created` event: a non-empty string or UTF-8 bytes, capped at 256 characters. */
function parseMemo(value: unknown): string | null {
  const text =
    typeof value === 'string'
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value).toString('utf8')
        : '';
  return text === '' ? null : text.slice(0, MAX_MEMO_LENGTH);
}

/** The optional delayed start of a `created` event: seconds since the epoch, or null when absent or zero. */
function parseStartsAt(value: unknown): Date | null {
  const seconds = typeof value === 'bigint' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000)
    : null;
}

/**
 * Handles the donation-vault contract's `created` event, emitted when a
 * donor opens a new streaming donation to an NGO.
 *
 * Writes: upserts the `donor` and `ngo` rows (creating them if this is the
 * first time either address has been seen), then upserts a `stream` row
 * with status `ACTIVE`, the initial deposit as `balance`, and `withdrawn`
 * set to `0`. Persists a `StreamEvent` row in the same transaction.
 * Emits a `stream_created` notification.
 */
async function handleStreamCreated(event: ContractEvent): Promise<void> {
  const [, streamIdVal] = event.topic;
  const onChainId = scValToNative(streamIdVal) as bigint;

  const [donorVal, ngoVal, tokenVal, depositVal, rateVal, memoVal, startVal] = scValToNative(
    event.value,
  ) as [
    { toString(): string },
    { toString(): string },
    { toString(): string },
    bigint,
    bigint,
    unknown?,
    unknown?,
  ];
  const memo = parseMemo(memoVal);
  const startsAt = parseStartsAt(startVal);

  const { ngo } = await prisma.$transaction(async (tx) => {
    const [donor, ngo] = await Promise.all([
      ensureDonor(tx, donorVal.toString()),
      ensureNgo(tx, ngoVal.toString()),
    ]);

    await tx.stream.upsert({
      where: { onChainId },
      create: {
        onChainId,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: tokenVal.toString(),
        rate: rateVal.toString(),
        balance: depositVal.toString(),
        withdrawn: '0',
        status: 'ACTIVE',
        createdTxHash: event.txHash,
        memo,
        startsAt,
        createdAt: new Date(event.ledgerClosedAt),
      },
      update: {},
    });

    await tx.streamEvent.create({
      data: {
        type: 'created',
        streamId: onChainId,
        ledger: event.ledger,
        txHash: event.txHash,
        payload: {
          donor: donorVal.toString(),
          ngo: ngoVal.toString(),
          token: tokenVal.toString(),
          deposit: depositVal.toString(),
          rate: rateVal.toString(),
          memo,
          startsAt: startsAt?.toISOString() ?? null,
        },
      },
    });

    return { ngo };
  });

  dispatchNotification({
    type: 'stream_created',
    eventId: event.id,
    streamId: onChainId.toString(),
    donorAddress: donorVal.toString(),
    ngoId: ngo.id,
  });
}

/**
 * Handles the donation-vault contract's `withdraw` event, emitted when
 * accrued funds are withdrawn to the NGO from an active stream.
 *
 * Writes: updates the matching `stream` row, subtracting the accrued
 * amount from `balance` and adding it to `withdrawn`. Persists a
 * `StreamEvent` row in the same transaction. No-ops if the stream isn't
 * known yet or if it is already cancelled. Emits a `stream_withdrawn` notification.
 *
 * Withdraw's event payload is just the accrued amount, so the new balance
 * and withdrawn total are fully determined by it — no ambiguity.
 */
async function handleWithdraw(event: ContractEvent): Promise<void> {
  const [, streamIdVal] = event.topic;
  const onChainId = scValToNative(streamIdVal) as bigint;
  const accrued = scValToNative(event.value) as bigint;

  let shouldNotify = false;

  await prisma.$transaction(async (tx) => {
    const stream = await tx.stream.findUnique({ where: { onChainId } });
    if (!stream) {
      logger.warn(
        { eventId: event.id, streamId: onChainId.toString() },
        'withdraw event received for unknown stream',
      );
      await recordDeadLetter(event, new Error(`unknown stream: ${onChainId}`));
      return;
    }

    if (stream.status === 'CANCELLED') {
      logger.warn(
        { eventId: event.id, streamId: onChainId.toString() },
        'ignoring withdraw event for cancelled stream',
      );
      return;
    }

    const balance = BigInt(stream.balance);
    const nextBalance = balance - accrued;
    if (nextBalance < 0n) {
      logger.warn(
        {
          onChainId: onChainId.toString(),
          balance: balance.toString(),
          accrued: accrued.toString(),
        },
        'withdraw exceeds recorded stream balance',
      );
    }

    await tx.stream.update({
      where: { onChainId },
      data: {
        balance: (nextBalance < 0n ? 0n : nextBalance).toString(),
        withdrawn: (BigInt(stream.withdrawn) + accrued).toString(),
        updatedAt: new Date(event.ledgerClosedAt),
      },
    });

    await tx.streamEvent.create({
      data: {
        type: 'withdraw',
        streamId: onChainId,
        ledger: event.ledger,
        txHash: event.txHash,
        payload: { accrued: accrued.toString() },
      },
    });

    shouldNotify = true;
  });

  if (shouldNotify) {
    dispatchNotification({
      type: 'stream_withdrawn',
      eventId: event.id,
      streamId: onChainId.toString(),
      amount: accrued.toString(),
    });
  }
}

/**
 * Handles the donation-vault contract's `cancel` event, emitted when a
 * stream is cancelled, settling accrued funds to the NGO and refunding the
 * remaining balance to the donor.
 *
 * Writes: updates the matching `stream` row — adds the settled amount to
 * `withdrawn`, zeroes `balance` and `rate`, and sets `status` to
 * `CANCELLED`. Persists a `StreamEvent` row in the same transaction.
 * No-ops if the stream isn't known yet or already cancelled. Emits a `stream_cancelled`
 * notification.
 *
 * Cancel's payload carries both the settled amount and the refund, so —
 * like withdraw — the resulting state is fully determined by the event.
 */
async function handleCancel(event: ContractEvent): Promise<void> {
  const [, streamIdVal] = event.topic;
  const onChainId = scValToNative(streamIdVal) as bigint;
  const [accrued, refund] = scValToNative(event.value) as [bigint, bigint];

  let shouldNotify = false;

  await prisma.$transaction(async (tx) => {
    const stream = await tx.stream.findUnique({ where: { onChainId } });
    if (!stream) {
      logger.warn(
        { eventId: event.id, streamId: onChainId.toString() },
        'cancel event received for unknown stream',
      );
      await recordDeadLetter(event, new Error(`unknown stream: ${onChainId}`));
      return;
    }

    if (stream.status === 'CANCELLED') {
      logger.warn(
        { eventId: event.id, streamId: onChainId.toString() },
        'ignoring duplicate cancel event for already cancelled stream',
      );
      return;
    }

    await tx.stream.update({
      where: { onChainId },
      data: {
        withdrawn: (BigInt(stream.withdrawn) + accrued).toString(),
        balance: '0',
        lastRate: stream.rate,
        rate: '0',
        status: 'CANCELLED',
        updatedAt: new Date(event.ledgerClosedAt),
      },
    });

    await tx.streamEvent.create({
      data: {
        type: 'cancel',
        streamId: onChainId,
        ledger: event.ledger,
        txHash: event.txHash,
        payload: {
          accrued: accrued.toString(),
          refund: refund.toString(),
        },
      },
    });

    shouldNotify = true;
  });

  if (shouldNotify) {
    dispatchNotification({
      type: 'stream_cancelled',
      eventId: event.id,
      streamId: onChainId.toString(),
      settledToNgo: accrued.toString(),
      refundToDonor: refund.toString(),
    });
  }
}

/**
 * Handles the donation-vault contract's `pause` event, emitted when a donor
 * pauses an active stream.
 *
 * Writes: sets the matching `stream` row to `PAUSED` and records when in
 * `pausedAt`, leaving `updatedAt` (the settlement time the remaining-time
 * calculation counts from) untouched. Persists a `StreamEvent` row in the same
 * transaction. Idempotent: a replayed event, or one for a stream that is not
 * `ACTIVE`, changes nothing and writes no second row.
 */
async function handlePause(event: ContractEvent): Promise<void> {
  const [, streamIdVal] = event.topic;
  const onChainId = scValToNative(streamIdVal) as bigint;

  await prisma.$transaction(async (tx) => {
    const stream = await tx.stream.findUnique({ where: { onChainId } });
    if (!stream) {
      logger.warn(
        { eventId: event.id, streamId: onChainId.toString() },
        'pause event received for unknown stream',
      );
      await recordDeadLetter(event, new Error(`unknown stream: ${onChainId}`));
      return;
    }

    if (stream.status !== 'ACTIVE') {
      logger.warn(
        { eventId: event.id, streamId: onChainId.toString(), status: stream.status },
        'ignoring pause event for a stream that is not active',
      );
      return;
    }

    const pausedAt = new Date(event.ledgerClosedAt);
    await tx.stream.update({
      where: { onChainId },
      data: { status: 'PAUSED', pausedAt, updatedAt: stream.updatedAt },
    });

    await tx.streamEvent.create({
      data: {
        type: 'pause',
        streamId: onChainId,
        ledger: event.ledger,
        txHash: event.txHash,
        payload: { pausedAt: pausedAt.toISOString() },
      },
    });
  });
}

/**
 * Handles the donation-vault contract's `resume` event, emitted when a donor
 * resumes a paused stream.
 *
 * Writes: sets the matching `stream` row back to `ACTIVE`, clears `pausedAt`
 * and moves `updatedAt` forward by the time spent paused, so the paused period
 * does not count against the remaining time. Persists a `StreamEvent` row in
 * the same transaction. Idempotent: a replayed event, or one for a stream that
 * is not `PAUSED`, changes nothing and writes no second row.
 */
async function handleResume(event: ContractEvent): Promise<void> {
  const [, streamIdVal] = event.topic;
  const onChainId = scValToNative(streamIdVal) as bigint;

  await prisma.$transaction(async (tx) => {
    const stream = await tx.stream.findUnique({ where: { onChainId } });
    if (!stream) {
      logger.warn(
        { eventId: event.id, streamId: onChainId.toString() },
        'resume event received for unknown stream',
      );
      await recordDeadLetter(event, new Error(`unknown stream: ${onChainId}`));
      return;
    }

    if (stream.status !== 'PAUSED') {
      logger.warn(
        { eventId: event.id, streamId: onChainId.toString(), status: stream.status },
        'ignoring resume event for a stream that is not paused',
      );
      return;
    }

    const resumedAt = new Date(event.ledgerClosedAt);
    const pausedMs = stream.pausedAt ? Math.max(0, resumedAt.getTime() - stream.pausedAt.getTime()) : 0;
    await tx.stream.update({
      where: { onChainId },
      data: {
        status: 'ACTIVE',
        pausedAt: null,
        updatedAt: new Date(stream.updatedAt.getTime() + pausedMs),
      },
    });

    await tx.streamEvent.create({
      data: {
        type: 'resume',
        streamId: onChainId,
        ledger: event.ledger,
        txHash: event.txHash,
        payload: { resumedAt: resumedAt.toISOString(), pausedMs },
      },
    });
  });
}

/**
 * Entry point for all donation-vault contract events. Dispatches on the
 * event's topic to the handler for that on-chain event:
 * `created` → {@link handleStreamCreated}, `withdraw` → {@link handleWithdraw},
 * `cancel` → {@link handleCancel}, `pause` → {@link handlePause}, `resume` →
 * {@link handleResume}. `topup` and `ratemod` are deliberately
 * unhandled for now (see comment below); any other topic is ignored.
 */
export async function handleDonationVaultEvent(event: ContractEvent): Promise<void> {
  const [topicSymbol] = event.topic;
  const topic = scValToNative(topicSymbol) as string;

  switch (topic) {
    case 'created':
      await handleStreamCreated(event);
      break;
    case 'withdraw':
      await handleWithdraw(event);
      break;
    case 'cancel':
      await handleCancel(event);
      break;
    case 'pause':
    case 'paused':
      await handlePause(event);
      break;
    case 'resume':
    case 'resumed':
      await handleResume(event);
      break;
    case 'topup':
    case 'ratemod':
      // Deliberately unhandled for now: both events only publish the new
      // amount/rate, not how much accrued and settled to the NGO during
      // the same call, so the new balance can't be reconstructed from the
      // event payload alone without either a verified read-only contract
      // call (get_stream) or duplicating the contract's accrual math here
      // — both real work, tracked as follow-up rather than guessed at.
      break;
    default:
      break;
  }
}
