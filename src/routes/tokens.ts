import type { FastifyInstance } from 'fastify';
import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z
    .string()
    .refine((value) => StrKey.isValidContract(value), {
      message: 'Invalid Stellar contract address',
    })
    .optional(),
});

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists token addresses used by streams, with their stream counts.
   * @route GET /v1/tokens
   * @auth Public
   * @returns 200 `{ tokens: [{ tokenAddress, streamCount }], hasMore, nextCursor }`.
   */
  app.get(
    '/tokens',
    {
      schema: {
        tags: ['Streams'],
        summary: 'List tokens used by streams',
        description: 'Returns distinct stream token addresses with the number of streams for each.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            cursor: { type: 'string', pattern: '^C[A-Z2-7]{55}$' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const { limit, cursor } = parsed.data;
      const rows = await prisma.stream.groupBy({
        by: ['tokenAddress'],
        ...(cursor ? { where: { tokenAddress: { gt: cursor } } } : {}),
        _count: { _all: true },
        orderBy: { tokenAddress: 'asc' },
        take: limit + 1,
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return sendPublicCacheable(request, reply, {
        tokens: page.map((row) => ({
          tokenAddress: row.tokenAddress,
          streamCount: row._count._all,
        })),
        hasMore,
        nextCursor: hasMore ? (page.at(-1)?.tokenAddress ?? null) : null,
      });
    },
  );
}
