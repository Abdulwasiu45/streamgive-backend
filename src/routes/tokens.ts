import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists every token address that appears on a stream, with its stream count.
   * @route GET /v1/tokens
   * @auth Public
   * @returns 200 `{ tokens: [{ tokenAddress, streamCount }] }` ordered by token address.
   */
  app.get(
    '/tokens',
    {
      schema: {
        tags: ['Streams'],
        summary: 'List tokens used by streams',
        description: 'Returns distinct stream token addresses with the number of streams for each.',
        response: {
          200: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const rows = await prisma.stream.groupBy({
        by: ['tokenAddress'],
        _count: { _all: true },
        orderBy: { tokenAddress: 'asc' },
      });

      return sendPublicCacheable(request, reply, {
        tokens: rows.map((row) => ({
          tokenAddress: row.tokenAddress,
          streamCount: row._count._all,
        })),
      });
    },
  );
}
