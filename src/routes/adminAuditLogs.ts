import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

const querySchema = z.object({
  adminAddress: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/)
    .optional(),
  action: z.string().trim().min(1).max(100).optional(),
  targetId: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(50_000).default(0),
});

export async function adminAuditLogRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/audit-logs',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'List admin audit log entries',
        querystring: {
          type: 'object',
          properties: {
            adminAddress: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
            action: { type: 'string', minLength: 1, maxLength: 100 },
            targetId: { type: 'string', minLength: 1, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            offset: { type: 'integer', minimum: 0, maximum: 50000, default: 0 },
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
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const { adminAddress, action, targetId, limit, offset } = parsed.data;
      const where = {
        ...(adminAddress ? { adminAddress } : {}),
        ...(action ? { action } : {}),
        ...(targetId ? { targetId } : {}),
      };

      const [entries, total] = await Promise.all([
        prisma.adminAuditLog.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit,
          skip: offset,
        }),
        prisma.adminAuditLog.count({ where }),
      ]);

      return { entries, total, limit, offset };
    },
  );
}
