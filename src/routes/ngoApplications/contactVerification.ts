import type { FastifyInstance } from 'fastify';

import { parseConfig } from '../../config.js';
import { prisma } from '../../db.js';
import {
  sendContactVerification,
  verifyContactToken,
} from '../../notifications/contactVerification.js';
import { contactVerificationTokenSchema, idParamSchema } from './shared.js';

export async function ngoApplicationContactVerificationRoutes(app: FastifyInstance): Promise<void> {
  const applicationRateLimitMax = parseConfig(process.env).RATE_LIMIT_APPLICATION_MAX;

  /**
   * Renders a confirmation page for the one-time link. GET must not consume
   * the token because mail scanners and link previews fetch links automatically.
   * @route GET /v1/ngo-applications/verify-contact-email
   * @query token opaque, single-use token sent by email
   * @returns 200 HTML confirmation form; 400 invalid or expired token.
   */
  app.get('/ngo-applications/verify-contact-email', async (request, reply) => {
    const parsed = contactVerificationTokenSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    const action = `/v1/ngo-applications/verify-contact-email?token=${encodeURIComponent(parsed.data.token)}`;
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Verify contact email</title><p>Confirm this email address for your NGO application.</p><form method="post" action="${action}"><button type="submit">Confirm email</button></form></html>`,
      );
  });

  /**
   * Redeems the one-time link after an explicit form submission.
   * @route POST /v1/ngo-applications/verify-contact-email
   * @query token opaque, single-use token sent by email
   * @returns 200 `{ verified: true }`; 400 invalid or expired token.
   */
  app.post('/ngo-applications/verify-contact-email', async (request, reply) => {
    const parsed = contactVerificationTokenSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    const verified = await verifyContactToken(parsed.data.token);
    if (!verified) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    return { verified: true };
  });

  /**
   * Sends another verification link without revealing whether the application exists.
   * @route POST /v1/ngo-applications/:id/contact-email-verification
   * @returns 202 `{ message }` for missing, verified, or resent applications.
   */
  app.post(
    '/ngo-applications/:id/contact-email-verification',
    {
      config: {
        rateLimit: {
          max: applicationRateLimitMax,
          timeWindow: process.env.RATE_LIMIT_APPLICATION_WINDOW ?? '1 minute',
        },
      },
    },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (parsedParams.success) {
        const application = await prisma.ngoApplication.findUnique({
          where: { id: parsedParams.data.id },
          select: { id: true, name: true, contactEmail: true, emailVerifiedAt: true },
        });
        if (application && !application.emailVerifiedAt) {
          await sendContactVerification(application);
        }
      }
      return reply.code(202).send({ message: 'If eligible, a verification email has been sent.' });
    },
  );
}
