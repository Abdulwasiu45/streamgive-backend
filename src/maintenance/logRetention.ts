import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';
import { DEFAULT_LOG_RETENTION_DAYS } from '../config.js';
import { envInt } from '../config/env.js';
import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function retentionDays(): number {
  return envInt(process.env.LOG_RETENTION_DAYS, 'LOG_RETENTION_DAYS', {
    defaultValue: DEFAULT_LOG_RETENTION_DAYS,
    min: 1,
  });
}

export async function pruneOldLogs(
  now = new Date(),
): Promise<{ notifications: number; deadLetters: number }> {
  const cutoff = new Date(now.getTime() - retentionDays() * DAY_MS);
  const [notifications, deadLetters] = await Promise.all([
    prisma.notificationLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    // Unresolved events may still be needed for recovery and are never expired.
    prisma.indexerDeadLetter.deleteMany({ where: { resolvedAt: { lt: cutoff } } }),
  ]);

  return { notifications: notifications.count, deadLetters: deadLetters.count };
}

export function registerLogRetention(app: FastifyInstance): void {
  let timer: NodeJS.Timeout | undefined;

  app.addHook('onReady', async () => {
    const run = async () => {
      try {
        const removed = await pruneOldLogs();
        if (removed.notifications || removed.deadLetters) {
          logger.info(removed, 'pruned expired logs');
        }
      } catch (error) {
        logger.error({ err: error }, 'failed to prune expired logs');
      }
    };

    await run();
    timer = setInterval(() => void run(), DAY_MS);
    timer.unref();
  });

  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
}
