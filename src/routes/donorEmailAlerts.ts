import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parseConfig } from '../config.js';
import { requireOwnerSignature } from '../middleware/ownerAuth.js';
import {
  confirmDonorEmailAlert,
  registerDonorEmailAlert,
  unsubscribeDonorEmailAlert,
} from '../notifications/donorAlerts.js';

const addressParamSchema = z.object({ address: z.string().regex(/^G[A-Z2-7]{55}$/) });
const bodySchema = z.object({ email: z.string().trim().email().max(254) }).strict();
const tokenQuerySchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) });

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>${body}</html>`;

export async function donorEmailAlertRoutes(app: FastifyInstance): Promise<void> {
  const rateLimit = {
    max: parseConfig(process.env).RATE_LIMIT_APPLICATION_MAX,
    timeWindow: process.env.RATE_LIMIT_APPLICATION_WINDOW ?? '1 minute',
  };

  /**
   * Registers an email for stream alerts on a wallet and sends a confirmation link.
   * @route POST /v1/donors/:address/email-alerts
   * @body `{ email }`
   * @auth Owner signature of the same address via `x-owner-address`, `x-owner-timestamp`, and `x-owner-signature`.
   * @returns 202 `{ status: "verification_sent" }`; 200 `{ status: "already_verified" }`; 400 invalid request; 403 signer is not the address; 502/503 email could not be sent.
   */
  app.post(
    '/donors/:address/email-alerts',
    { preHandler: requireOwnerSignature, config: { rateLimit } },
    async (request, reply) => {
      const parsedParams = addressParamSchema.safeParse(request.params);
      const parsedBody = bodySchema.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      if (request.headers['x-owner-address'] !== parsedParams.data.address) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      const result = await registerDonorEmailAlert(parsedParams.data.address, parsedBody.data.email);
      if (result === 'already_verified') return { status: 'already_verified' };
      if (result === 'not_configured') return reply.code(503).send({ error: 'email_not_configured' });
      if (result === 'failed') return reply.code(502).send({ error: 'email_send_failed' });
      return reply.code(202).send({ status: 'verification_sent' });
    },
  );

  /**
   * Shows a confirmation form for the emailed link. GET does not consume the token,
   * because mail scanners and link previews fetch links automatically.
   * @route GET /v1/donor-email-alerts/verify
   * @query token one-time token from the confirmation email
   */
  app.get('/donor-email-alerts/verify', async (request, reply) => {
    const parsed = tokenQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    const action = `/v1/donor-email-alerts/verify?token=${encodeURIComponent(parsed.data.token)}`;
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Confirm email alerts',
          `<p>Confirm email alerts for your StreamGive streams.</p><form method="post" action="${action}"><button type="submit">Confirm</button></form>`,
        ),
      );
  });

  /**
   * Redeems the confirmation token.
   * @route POST /v1/donor-email-alerts/verify
   * @query token one-time token from the confirmation email
   * @returns 200 `{ verified: true }`; 400 invalid or expired token.
   */
  app.post('/donor-email-alerts/verify', { config: { rateLimit } }, async (request, reply) => {
    const parsed = tokenQuerySchema.safeParse(request.query);
    if (!parsed.success || !(await confirmDonorEmailAlert(parsed.data.token))) {
      return reply.code(400).send({ error: 'invalid_or_expired_token' });
    }
    return { verified: true };
  });

  /**
   * One click unsubscribe from the link in every alert. Repeating it is harmless.
   * @route GET /v1/donor-email-alerts/unsubscribe
   * @query token secret from the unsubscribe link
   * @returns 200 HTML confirmation; 400 malformed token.
   */
  app.get('/donor-email-alerts/unsubscribe', async (request, reply) => {
    const parsed = tokenQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_token' });
    await unsubscribeDonorEmailAlert(parsed.data.token);
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(page('Unsubscribed', '<p>You will no longer get StreamGive stream alerts at this address.</p>'));
  });

  /**
   * RFC 8058 one-click unsubscribe, used by mail clients through the List-Unsubscribe header.
   * @route POST /v1/donor-email-alerts/unsubscribe
   * @query token secret from the unsubscribe link
   * @returns 200 `{ unsubscribed: true }`; 400 malformed token.
   */
  app.post('/donor-email-alerts/unsubscribe', async (request, reply) => {
    const parsed = tokenQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_token' });
    await unsubscribeDonorEmailAlert(parsed.data.token);
    return { unsubscribed: true };
  });
}
