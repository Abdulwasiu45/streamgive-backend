import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

/**
 * Query schema for GET /v1/admin/notification-logs:
 * - limit: 1 to 100 items per page (default: 100)
 * - cursor: optional UUID pointing to the last item of the previous page
 * - eventType, channel: optional exact-match filters
 * - success: optional boolean filter ('true' | 'false')
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  eventType: z.string().trim().min(1).max(100).optional(),
  channel: z.string().trim().min(1).max(200).optional(),
  success: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) => (val === undefined ? undefined : val === 'true')),
});

// Explicit field list: a column added to notification_logs later must be
// reviewed before it can show up here.
const logSelect = {
  id: true,
  eventId: true,
  eventType: true,
  channel: true,
  success: true,
  error: true,
  createdAt: true,
} as const;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** Removes anything that looks like a URL, so a receiver address or a token in its query string never leaves the database through this route. */
export function redactUrls(text: string | null): string | null {
  return text === null ? null : text.replace(URL_PATTERN, '[redacted-url]');
}

export async function notificationLogRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists notification delivery results, newest first.
   * @route GET /v1/admin/notification-logs
   * @query limit, cursor, eventType, channel, success
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ logs: NotificationLog[], total: number, hasMore: boolean, nextCursor: string | null }`; 400 `{ error: "invalid_request", details }`.
   */
  app.get(
    '/admin/notification-logs',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'List notification delivery logs',
        description:
          'Returns paginated delivery results filtered by event type, channel and success. Webhook URLs and secrets are never included.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            cursor: { type: 'string', format: 'uuid' },
            eventType: { type: 'string', maxLength: 100 },
            channel: { type: 'string', maxLength: 200 },
            success: { type: 'string', enum: ['true', 'false'] },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          401: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedQuery = querySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
      }

      const { limit, cursor, eventType, channel, success } = parsedQuery.data;
      const where = {
        ...(eventType === undefined ? {} : { eventType }),
        ...(channel === undefined ? {} : { channel }),
        ...(success === undefined ? {} : { success }),
      };

      const cursorRow = cursor
        ? await prisma.notificationLog.findUnique({
            where: { id: cursor },
            select: { id: true, createdAt: true },
          })
        : null;

      if (cursor && !cursorRow) {
        return {
          logs: [],
          total: await prisma.notificationLog.count({ where }),
          hasMore: false,
          nextCursor: null,
        };
      }

      const [total, rows] = await Promise.all([
        prisma.notificationLog.count({ where }),
        prisma.notificationLog.findMany({
          where: cursorRow
            ? {
                ...where,
                OR: [
                  { createdAt: { lt: cursorRow.createdAt } },
                  { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
                ],
              }
            : where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          select: logSelect,
        }),
      ]);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      return {
        logs: page.map((row) => ({ ...row, error: redactUrls(row.error) })),
        total,
        hasMore,
        nextCursor: hasMore ? page[page.length - 1].id : null,
      };
    },
  );
}
