import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

const oldestFirst = [{ createdAt: 'asc' }, { id: 'asc' }] as const;

export async function adminOverviewRoutes(app: FastifyInstance): Promise<void> {
  /**
   * One-call overview of the queues an operator watches: how many applications
   * are pending, how many dead letters are unresolved and how many webhook
   * deliveries have failed, each with its oldest item. Every figure is a plain
   * count or a single indexed `ORDER BY ... LIMIT 1` lookup.
   * @route GET /v1/admin/overview
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ pendingApplications, unresolvedDeadLetters, failedWebhookDeliveries }`, each `{ count, oldest }` where `oldest` is `null` when the queue is empty.
   */
  app.get(
    '/admin/overview',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'Admin overview of queue sizes and failures',
        response: {
          200: { type: 'object', additionalProperties: true },
          401: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async () => {
      const pending = { status: 'PENDING' } as const;
      const unresolved = { resolvedAt: null };
      const failed = { status: 'FAILED' } as const;

      const [
        pendingCount,
        pendingOldest,
        deadLetterCount,
        deadLetterOldest,
        failedCount,
        failedOldest,
      ] = await Promise.all([
        prisma.ngoApplication.count({ where: pending }),
        prisma.ngoApplication.findFirst({
          where: pending,
          orderBy: [...oldestFirst],
          select: { id: true, name: true, createdAt: true },
        }),
        prisma.indexerDeadLetter.count({ where: unresolved }),
        prisma.indexerDeadLetter.findFirst({
          where: unresolved,
          orderBy: [...oldestFirst],
          select: { id: true, eventId: true, createdAt: true },
        }),
        prisma.webhookDelivery.count({ where: failed }),
        prisma.webhookDelivery.findFirst({
          where: failed,
          orderBy: [...oldestFirst],
          select: { id: true, channel: true, eventType: true, createdAt: true },
        }),
      ]);

      return {
        pendingApplications: { count: pendingCount, oldest: pendingOldest },
        unresolvedDeadLetters: { count: deadLetterCount, oldest: deadLetterOldest },
        failedWebhookDeliveries: { count: failedCount, oldest: failedOldest },
      };
    },
  );
}
