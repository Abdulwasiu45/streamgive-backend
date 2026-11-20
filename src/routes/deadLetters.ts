import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

/**
 * Query schema for GET /v1/admin/dead-letters:
 * - limit: 1 to 100 items per page (default: 100)
 * - cursor: optional UUID pointing to the last item of the previous page
 * - resolved: optional boolean filter ('true' | 'false')
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  resolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) => (val === undefined ? undefined : val === 'true')),
});

const deadLetterParamsSchema = z.object({
  id: z.string().uuid(),
});

const resolutionBodySchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

export async function deadLetterRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists failed Soroban contract events recorded in the dead-letter queue.
   * @route GET /v1/admin/dead-letters
   * @query limit, cursor, resolved
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ deadLetters: IndexerDeadLetter[], total: number, hasMore: boolean, nextCursor: string | null }`; 400 `{ error: "invalid_request", details }`.
   */
  app.get(
    '/admin/dead-letters',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'List dead-lettered events',
        description:
          'Returns paginated dead-letter records with an optional resolved status filter.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            cursor: { type: 'string', format: 'uuid' },
            resolved: { type: 'string', enum: ['true', 'false'] },
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

      const { limit, cursor, resolved } = parsedQuery.data;

      const where =
        resolved === undefined
          ? {}
          : resolved
            ? { resolvedAt: { not: null } }
            : { resolvedAt: null };

      // Resolve the cursor explicitly. Prisma's `cursor` pagination requires the
      // cursor row to exist; the API contract treats an unknown cursor as an
      // empty page rather than leaking a Prisma record-not-found error.
      const cursorRow = cursor
        ? await prisma.indexerDeadLetter.findUnique({
            where: { id: cursor },
            select: { id: true, createdAt: true },
          })
        : null;

      if (cursor && !cursorRow) {
        return {
          deadLetters: [],
          total: await prisma.indexerDeadLetter.count({ where }),
          hasMore: false,
          nextCursor: null,
        };
      }

      const [total, rows] = await Promise.all([
        prisma.indexerDeadLetter.count({ where }),
        prisma.indexerDeadLetter.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursorRow
            ? {
                where: {
                  ...where,
                  OR: [
                    { createdAt: { lt: cursorRow.createdAt } },
                    { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
                  ],
                },
              }
            : {}),
        }),
      ]);

      const hasMore = rows.length > limit;
      const deadLetters = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? deadLetters[deadLetters.length - 1].id : null;

      return {
        deadLetters,
        total,
        hasMore,
        nextCursor,
      };
    },
  );

  app.get(
    '/admin/dead-letters/:id',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'Get a dead-lettered event',
        description: 'Returns a dead-letter record by id, including its raw event payload.',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          401: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = deadLetterParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', details: parsedParams.error.flatten() });
      }

      const deadLetter = await prisma.indexerDeadLetter.findUnique({
        where: { id: parsedParams.data.id },
      });
      if (!deadLetter) {
        return reply.code(404).send({ error: 'dead_letter_not_found' });
      }

      return deadLetter;
    },
  );

  app.post(
    '/admin/dead-letters/:id/resolve',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'Resolve a dead-lettered event',
        description: 'Marks a dead letter as resolved by the authenticated admin.',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: { note: { type: 'string', maxLength: 2000 } },
          additionalProperties: false,
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          401: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
          409: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = deadLetterParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', details: parsedParams.error.flatten() });
      }

      const parsedBody = resolutionBodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', details: parsedBody.error.flatten() });
      }

      const id = parsedParams.data.id;
      const existing = await prisma.indexerDeadLetter.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: 'dead_letter_not_found' });
      }

      const resolvedBy = request.headers['x-admin-address'];
      if (typeof resolvedBy !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const result = await prisma.indexerDeadLetter.updateMany({
        where: { id, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedBy,
          resolutionNote: parsedBody.data.note || null,
        },
      });
      if (result.count === 0) {
        return reply.code(409).send({
          error: 'dead_letter_already_resolved',
          message: 'Dead letter has already been resolved',
        });
      }

      return {
        deadLetter: await prisma.indexerDeadLetter.findUniqueOrThrow({ where: { id } }),
      };
    },
  );
}
