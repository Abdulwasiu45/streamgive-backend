import type { FastifyInstance } from 'fastify';

import { recordAdminAction } from '../../audit/adminAudit.js';
import { prisma } from '../../db.js';
import { requireAdminSignature } from '../../middleware/adminAuth.js';
import { requireOwnerSignature } from '../../middleware/ownerAuth.js';
import { notify } from '../../notifications/service.js';
import { idParamSchema, listQuerySchema, reviewBodySchema } from './shared.js';

export async function ngoApplicationAdminRoutes(app: FastifyInstance): Promise<void> {
  // Admin dashboard endpoint: returns application counts grouped by
  // status so the client doesn't have to fetch and count applications
  // itself. Must be registered before the /:id route so 'stats' isn't
  // swallowed as an id and rejected by the UUID param validation.
  /**
   * Counts applications grouped by review status.
   * @route GET /v1/ngo-applications/stats
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ counts: { PENDING, APPROVED, REJECTED, WITHDRAWN }, total }`.
   */
  app.get('/ngo-applications/stats', { preHandler: requireAdminSignature }, async () => {
    const grouped = await prisma.ngoApplication.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 } as Record<string, number>;
    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }

    const total = counts.PENDING + counts.APPROVED + counts.REJECTED + counts.WITHDRAWN;

    return {
      counts: {
        PENDING: counts.PENDING,
        APPROVED: counts.APPROVED,
        REJECTED: counts.REJECTED,
        WITHDRAWN: counts.WITHDRAWN,
      },
      total,
    };
  });

  /**
   * Lists applications newest first with optional status and offset pagination.
   * Rows are ordered by `createdAt` then `id` (both descending), so applications
   * created at the same instant keep a fixed position and offset pages never
   * repeat or skip a row.
   * @route GET /v1/ngo-applications
   * @query status, search, submittedAfter, submittedBefore, limit, offset
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ applications: Application[], total, limit, offset }`; 400 `{ error: "invalid_request", details }` (including invalid dates and an `offset` above `MAX_APPLICATION_LIST_OFFSET`).
   */
  app.get('/ngo-applications', { preHandler: requireAdminSignature }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const { status, search, submittedAfter, submittedBefore } = parsed.data;
    const where = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { contactEmail: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(submittedAfter || submittedBefore
        ? {
            createdAt: {
              ...(submittedAfter ? { gte: submittedAfter } : {}),
              ...(submittedBefore ? { lte: submittedBefore } : {}),
            },
          }
        : {}),
    };

    const [applications, total] = await Promise.all([
      prisma.ngoApplication.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: parsed.data.limit,
        skip: parsed.data.offset,
      }),
      prisma.ngoApplication.count({ where }),
    ]);

    return { applications, total, limit: parsed.data.limit, offset: parsed.data.offset };
  });

  /**
   * Returns a single application, including its submitted and review details.
   * @route GET /v1/ngo-applications/:id
   * @param id Application UUID
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 application; 400 invalid UUID; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/ngo-applications/:id',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const application = await prisma.ngoApplication.findUnique({
        where: { id: parsedParams.data.id },
      });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return application;
    },
  );

  /**
   * Approves a pending application and optionally records a review note.
   * @route POST /v1/ngo-applications/:id/approve
   * @param id Application UUID
   * @body Optional `{ reviewNote?: string }` (maximum 2000 characters)
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 updated application; 400 invalid params/body; 404 `{ error: "not_found" }`; 409 `{ error: "already_reviewed" }`.
   */
  app.post(
    '/ngo-applications/:id/approve',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const reviewedBy = request.headers['x-admin-address'];
      if (typeof reviewedBy !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { id } = parsedParams.data;

      const parsed = reviewBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const application = await prisma.ngoApplication.findUnique({ where: { id } });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ error: 'already_reviewed' });
      }
      if (!application.emailVerifiedAt) {
        return reply.code(409).send({ error: 'contact_email_unverified' });
      }

      try {
        const reviewed = await prisma.$transaction(async (tx) => {
          const updated = await tx.ngoApplication.update({
            where: { id, status: 'PENDING' },
            data: {
              status: 'APPROVED',
              reviewNote: parsed.data?.reviewNote,
              reviewedBy,
              reviewedAt: new Date(),
            },
          });
          await recordAdminAction(
            tx,
            reviewedBy,
            'ngo_application.approved',
            updated.id,
            'Approved NGO application',
          );
          return updated;
        });
        await notify({
          type: 'application_reviewed',
          applicationId: reviewed.id,
          ownerAddress: reviewed.ownerAddress,
          status: 'APPROVED',
          ...(reviewed.reviewNote ? { reviewNote: reviewed.reviewNote } : {}),
        });
        return reviewed;
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'P2025'
        ) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );

  /**
   * Rejects a pending application and optionally records a review note.
   * @route POST /v1/ngo-applications/:id/reject
   * @param id Application UUID
   * @body Optional `{ reviewNote?: string }` (maximum 2000 characters)
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 updated application; 400 invalid params/body; 404 `{ error: "not_found" }`; 409 `{ error: "already_reviewed" }`.
   */
  app.post(
    '/ngo-applications/:id/reject',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const reviewedBy = request.headers['x-admin-address'];
      if (typeof reviewedBy !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { id } = parsedParams.data;

      const parsed = reviewBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const application = await prisma.ngoApplication.findUnique({ where: { id } });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ error: 'already_reviewed' });
      }
      if (!application.emailVerifiedAt) {
        return reply.code(409).send({ error: 'contact_email_unverified' });
      }

      try {
        const reviewed = await prisma.$transaction(async (tx) => {
          const updated = await tx.ngoApplication.update({
            where: { id, status: 'PENDING' },
            data: {
              status: 'REJECTED',
              reviewNote: parsed.data?.reviewNote,
              reviewedBy,
              reviewedAt: new Date(),
            },
          });
          await recordAdminAction(
            tx,
            reviewedBy,
            'ngo_application.rejected',
            updated.id,
            'Rejected NGO application',
          );
          return updated;
        });
        await notify({
          type: 'application_reviewed',
          applicationId: reviewed.id,
          ownerAddress: reviewed.ownerAddress,
          status: 'REJECTED',
          ...(reviewed.reviewNote ? { reviewNote: reviewed.reviewNote } : {}),
        });
        return reviewed;
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'P2025'
        ) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );

  /**
   * Lets the applicant withdraw their own pending NGO application.
   * @route POST /v1/ngo-applications/:id/withdraw
   * @param id Application UUID
   * @auth Owner signature required via `x-owner-address`, `x-owner-timestamp`, and `x-owner-signature`.
   * @returns 200 updated application; 400 invalid UUID; 401 unauthorized; 403 forbidden; 404 not_found; 409 not_pending.
   */
  app.post(
    '/ngo-applications/:id/withdraw',
    { preHandler: requireOwnerSignature },
    async (request, reply) => {
      const ownerAddress = request.headers['x-owner-address'];
      if (typeof ownerAddress !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { id } = parsedParams.data;

      const application = await prisma.ngoApplication.findUnique({ where: { id } });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (application.ownerAddress !== ownerAddress) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ error: 'not_pending' });
      }

      try {
        const withdrawn = await prisma.ngoApplication.update({
          where: { id, status: 'PENDING' },
          data: {
            status: 'WITHDRAWN',
          },
        });
        return withdrawn;
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'P2025'
        ) {
          return reply.code(409).send({ error: 'not_pending' });
        }
        throw err;
      }
    },
  );
}
