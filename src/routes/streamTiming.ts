export interface TimedStream {
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  rate: string;
  balance: string;
  /** When `balance` was last settled; the indexer moves it forward by the paused time on resume. */
  updatedAt: Date;
  /** When the stream was paused; only set while the status is PAUSED. */
  pausedAt?: Date | null;
}

/**
 * Whole seconds of funding left in a stream at `now`: `balance / rate` as of
 * the last settlement, minus the time that has passed since. A paused stream
 * stops the clock at `pausedAt`, so its remaining time does not shrink; on
 * resume the indexer shifts `updatedAt` forward by the paused time, so the
 * paused period is never counted. Returns 0 for a cancelled stream and null
 * when the rate is not positive (no end can be derived).
 */
export function remainingSeconds(stream: TimedStream, now: Date = new Date()): number | null {
  if (stream.status === 'CANCELLED') return 0;

  let rate: bigint;
  let balance: bigint;
  try {
    rate = BigInt(stream.rate);
    balance = BigInt(stream.balance);
  } catch {
    return null;
  }
  if (rate <= 0n) return null;

  const clock = stream.status === 'PAUSED' && stream.pausedAt ? stream.pausedAt : now;
  const elapsed = BigInt(Math.max(0, Math.floor((clock.getTime() - stream.updatedAt.getTime()) / 1000)));
  const left = balance / rate - elapsed;
  return left > 0n ? Number(left) : 0;
}
