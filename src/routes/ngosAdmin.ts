import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Prisma } from '../generated/prisma/client.js';
import { recordAdminAction } from '../audit/adminAudit.js';
import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

/** Params for admin update route; `id` must be an NGO UUID. */
const idParamSchema = z.object({ id: z.string().uuid() });

/** Admin update body; optional `displayName` is a string, null to clear, or omitted to preserve. */
const updateNgoSchema = z.object({
  displayName: z.string().nullable().optional(),
});

/**
 * Admin directory query: `limit` from 1–100 (default 100), optional NGO UUID
 * `cursor`, and optional `verified` string (`true` or `false`).
 */
const adminListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  // Optional boolean filter as a query string (so 'true'/'false' arrive as
  // strings); omitted means "everything, verified or not".
  verified: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  q: z.string().max(100).optional(),
});

export async function ngoAdminRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists all NGOs, including unverified entries, for admin review.
   * @route GET /v1/ngos/all
   * @query limit, cursor, verified
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ ngos: Ngo[], nextCursor: string | null }`; 400 `{ error: "invalid_request", details }`.
   */
  app.get('/ngos/all', { preHandler: requireAdminSignature }, async (request, reply) => {
    const parsedQuery = adminListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }
    const { limit, cursor, verified, q } = parsedQuery.data;
    const searchTerm = q?.trim() || undefined;

    const where: Prisma.NgoWhereInput = {
      ...(verified === undefined ? {} : { verified }),
      ...(searchTerm
        ? {
            OR: [
              { name: { contains: searchTerm, mode: 'insensitive' } },
              { displayName: { contains: searchTerm, mode: 'insensitive' } },
              { ownerAddress: { contains: searchTerm, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await prisma.ngo.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasMore = rows.length > limit;
    const ngos = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? ngos[ngos.length - 1].id : null;

    return { ngos, nextCursor };
  });

  /**
   * Updates or clears the NGO's public display name.
   * @route PATCH /v1/admin/ngos/:id
   * @param id NGO UUID
   * @body `{ displayName?: string | null }`
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 updated NGO with its effective public `name`; 400 invalid params/body; 404 `{ error: "not_found" }`.
   */
  app.patch('/admin/ngos/:id', { preHandler: requireAdminSignature }, async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const parsedBody = updateNgoSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedBody.error.flatten() });
    }

    const ngo = await prisma.ngo.findUnique({ where: { id: parsedParams.data.id } });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const adminAddress = request.headers['x-admin-address'];
    if (typeof adminAddress !== 'string') {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.ngo.update({
        where: { id: ngo.id },
        data: { displayName: parsedBody.data.displayName },
      });
      await recordAdminAction(
        tx,
        adminAddress,
        'ngo.display_name.updated',
        ngo.id,
        'Updated NGO display name override',
      );
      return result;
    });

    return { ...updated, name: updated.displayName || updated.name };
  });
}
