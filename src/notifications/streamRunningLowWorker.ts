import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { notify } from './service.js';

const DAY_SECONDS = 24n * 60n * 60n;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 200;

export async function notifyStreamsRunningLow(thresholdDays: number): Promise<number> {
  if (!Number.isSafeInteger(thresholdDays) || thresholdDays < 1) {
    throw new Error('STREAM_RUNNING_LOW_DAYS must be a positive integer');
  }

  const thresholdSeconds = BigInt(thresholdDays) * DAY_SECONDS;
  let cursorId: string | undefined;
  let notified = 0;

  while (true) {
    const streams = await prisma.stream.findMany({
      where: {
        status: 'ACTIVE',
        runningLowNotifiedAt: null,
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        onChainId: true,
        balance: true,
        rate: true,
        ngoId: true,
        donor: { select: { address: true } },
      },
    });

    if (streams.length === 0) break;

    for (const stream of streams) {
      const rate = BigInt(stream.rate);
      if (rate <= 0n) continue;

      const balance = BigInt(stream.balance);
      if (balance > thresholdSeconds * rate) continue;
      const remainingSeconds = balance / rate;

      const marked = await prisma.stream.updateMany({
        where: { id: stream.id, status: 'ACTIVE', runningLowNotifiedAt: null },
        data: { runningLowNotifiedAt: new Date() },
      });
      if (marked.count === 0) continue;

      await notify({
        type: 'stream_running_low',
        streamId: stream.onChainId.toString(),
        donorAddress: stream.donor.address,
        ngoId: stream.ngoId,
        remainingSeconds: remainingSeconds.toString(),
        eventId: `stream-running-low:${stream.id}`,
      });
      notified += 1;
    }

    cursorId = streams.at(-1)?.id;
    if (streams.length < BATCH_SIZE) break;
  }

  return notified;
}

export function startStreamRunningLowWorker(thresholdDays: number): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(run, CHECK_INTERVAL_MS);
    timer.unref();
  }

  function run(): void {
    if (stopped) return;
    inFlight = notifyStreamsRunningLow(thresholdDays)
      .then((count) => {
        if (count > 0) logger.info({ count }, 'sent stream running low notifications');
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'stream running low check failed');
      })
      .finally(() => {
        inFlight = undefined;
        schedule();
      });
  }

  run();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}
