import type { FastifyInstance } from 'fastify';

import { prisma } from '../../db.js';
import { statusQuerySchema } from './shared.js';

export async function ngoApplicationStatusRoutes(app: FastifyInstance): Promise<void> {
  // Public read endpoint: an applicant can check their own review status
  // without an admin signature. Deliberately returns only the review
  // outcome, timestamps, and (after review) the review note — never contact
  // details or the description submitted with the application, since anyone
  // who knows (or guesses) an address could otherwise read them.
  /**
   * Returns the latest application status without exposing submitted details.
   * @route GET /v1/ngo-applications/status
   * @query ownerAddress Stellar public key
   * @auth Public
   * @returns 200 `{ status, createdAt, updatedAt, reviewNote? }`; the note
   * is returned after review. 400 invalid address; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/ngo-applications/status',
    {
      schema: {
        tags: ['NGOs'],
        summary: 'Check an NGO application status',
        description:
          'Returns the status and timestamps, plus the review note after review, for the supplied owner address.',
        querystring: {
          type: 'object',
          properties: { ownerAddress: { type: 'string', pattern: '^G[A-Z2-7]{55}$' } },
          required: ['ownerAddress'],
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsed = statusQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const application = await prisma.ngoApplication.findFirst({
        where: { ownerAddress: parsed.data.ownerAddress },
        orderBy: { createdAt: 'desc' },
        select: { status: true, createdAt: true, updatedAt: true, reviewNote: true },
      });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }

      if (application.status === 'PENDING') {
        return {
          status: application.status,
          createdAt: application.createdAt,
          updatedAt: application.updatedAt,
        };
      }
      return application;
    },
  );
}
