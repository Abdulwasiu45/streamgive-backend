import { prisma } from '../db.js';
import { MAX_WEBHOOK_DELIVERY_ATTEMPTS, processWebhookDelivery } from './service.js';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 50;

/** Attempts one batch of due deliveries and marks exhausted crashed attempts terminal. */
export async function processDueWebhookDeliveries(): Promise<void> {
  const now = new Date();

  await prisma.webhookDelivery.updateMany({
    where: {
      status: 'PENDING',
      attempts: { gte: MAX_WEBHOOK_DELIVERY_ATTEMPTS },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: {
      status: 'FAILED',
      completedAt: now,
      lockedUntil: null,
      lastError: 'maximum attempts reached',
    },
  });

  const due = await prisma.webhookDelivery.findMany({
    where: {
      status: 'PENDING',
      attempts: { lt: MAX_WEBHOOK_DELIVERY_ATTEMPTS },
      nextAttemptAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: BATCH_SIZE,
    select: { id: true },
  });

  await Promise.all(
    due.map(async ({ id }) => {
      try {
        await processWebhookDelivery(id);
      } catch (error) {
        console.error('webhook delivery worker failed to process a delivery', error);
      }
    }),
  );
}

/** Starts the durable webhook retry loop and returns a stop function. */
export function startWebhookDeliveryWorker(): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(run, POLL_INTERVAL_MS);
  }

  function run(): void {
    if (stopped) return;
    inFlight = processDueWebhookDeliveries()
      .catch((error: unknown) => {
        console.error('webhook delivery polling failed', error);
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
