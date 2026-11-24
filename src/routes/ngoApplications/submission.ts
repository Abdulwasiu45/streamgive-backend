import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';

import { parseConfig } from '../../config.js';
import { prisma } from '../../db.js';
import { notify } from '../../notifications/service.js';
import { sendContactVerification } from '../../notifications/contactVerification.js';
import {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  hashRequestBody,
  IDEMPOTENCY_HEADER,
} from '../../idempotency/index.js';
import {
  APPLICATION_CHALLENGE_TTL_MS,
  applicationChallengeMessage,
  applicationSubmissionSchema,
  challengeRequestSchema,
  createApplicationUnlessBlocked,
  verifyApplicationSignature,
} from './shared.js';

export async function ngoApplicationSubmissionRoutes(app: FastifyInstance): Promise<void> {
  const applicationRateLimitMax = parseConfig(process.env).RATE_LIMIT_APPLICATION_MAX;

  /**
   * Issues a short-lived challenge that must be signed by the NGO owner address.
   * @route POST /v1/ngo-applications/challenge
   * @body `{ ownerAddress }`
   * @returns 201 `{ challenge, message, expiresAt }`.
   */
  app.post('/ngo-applications/challenge', async (request, reply) => {
    const parsed = challengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    if (!StrKey.isValidEd25519PublicKey(parsed.data.ownerAddress)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const challenge = randomUUID();
    const expiresAt = new Date(Date.now() + APPLICATION_CHALLENGE_TTL_MS);
    const message = applicationChallengeMessage(parsed.data.ownerAddress, challenge, expiresAt);
    await prisma.ngoApplicationChallenge.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    await prisma.ngoApplicationChallenge.create({
      data: { challenge, ownerAddress: parsed.data.ownerAddress, expiresAt },
    });

    return reply.code(201).send({ challenge, message, expiresAt });
  });

  /**
   * Submits a public NGO verification application.
   * @route POST /v1/ngo-applications
   * @body applicationSchema plus a server-issued `challenge` and SEP-53 `signature`
   * @header Idempotency-Key optional; a repeat within 24 hours with the same body replays the
   * first response (marked `idempotent-replayed: true`), with a different body returns 422
   * `idempotency_key_reused`, and while the first is still running returns 409
   * `idempotency_request_in_progress`.
   * @auth Public
   * @returns 201 created application; 400 invalid request or signature; 409 `{ error: "already_approved" | "application_already_pending" }`.
   */
  app.post(
    '/ngo-applications',
    // Public write endpoint — tighter than the global default since it's
    // the most spam-prone route in the API.
    {
      config: {
        rateLimit: {
          max: applicationRateLimitMax,
          timeWindow: process.env.RATE_LIMIT_APPLICATION_WINDOW ?? '1 minute',
        },
      },
    },
    async (request, reply) => {
      const submit = async (): Promise<readonly [number, unknown]> => {
        const parsed = applicationSubmissionSchema.safeParse(request.body);
        if (!parsed.success) {
          return [400, { error: 'invalid_request', details: parsed.error.flatten() }] as const;
        }

        const { challenge, signature, ...applicationData } = parsed.data;
        const challengeRecord = await prisma.ngoApplicationChallenge.findUnique({
          where: { challenge },
        });
        if (
          !challengeRecord ||
          challengeRecord.ownerAddress !== applicationData.ownerAddress ||
          challengeRecord.expiresAt.getTime() <= Date.now()
        ) {
          return [400, { error: 'invalid_or_expired_challenge' }] as const;
        }

        const message = applicationChallengeMessage(
          challengeRecord.ownerAddress,
          challenge,
          challengeRecord.expiresAt,
        );
        if (!verifyApplicationSignature(applicationData.ownerAddress, message, signature)) {
          return [401, { error: 'invalid_signature' }] as const;
        }

        const consumed = await prisma.ngoApplicationChallenge.deleteMany({
          where: {
            challenge,
            ownerAddress: applicationData.ownerAddress,
            expiresAt: { gt: new Date() },
          },
        });
        if (consumed.count !== 1) {
          return [400, { error: 'invalid_or_expired_challenge' }] as const;
        }

        const result = await createApplicationUnlessBlocked(applicationData);
        if (!result.ok) {
          if (result.status === 'APPROVED') {
            return [409, { error: 'already_approved' }] as const;
          }
          return [409, { error: 'application_already_pending' }] as const;
        }

        await notify({
          type: 'application_submitted',
          applicationId: result.application.id,
          ownerAddress: result.application.ownerAddress,
          name: result.application.name,
        });
        await sendContactVerification(result.application);
        return [201, result.application] as const;
      };

      // Optional Idempotency-Key: a retried submission gets the first response
      // back instead of creating (or being refused as) a duplicate.
      const rawKey = request.headers[IDEMPOTENCY_HEADER];
      if (rawKey === undefined) {
        const [status, payload] = await submit();
        return reply.code(status).send(payload);
      }
      const clientKey = Array.isArray(rawKey) ? '' : rawKey;
      const rawBody = (request as typeof request & { rawBody?: Buffer }).rawBody;
      const started = await beginIdempotentRequest(
        'ngo-applications',
        clientKey,
        hashRequestBody(rawBody ?? JSON.stringify(request.body ?? null)),
      );
      if (started.kind === 'invalid') {
        return reply.code(400).send({ error: 'invalid_idempotency_key' });
      }
      if (started.kind === 'conflict') {
        return reply
          .code(started.error === 'idempotency_key_reused' ? 422 : 409)
          .send({ error: started.error });
      }
      if (started.kind === 'replay') {
        return reply
          .code(started.statusCode)
          .header('idempotent-replayed', 'true')
          .send(started.response);
      }

      let result: readonly [number, unknown];
      try {
        result = await submit();
      } catch (err) {
        await abandonIdempotentRequest(started.key);
        throw err;
      }
      const [status, payload] = result;
      // Round-trip through JSON so the stored copy matches what was sent.
      await completeIdempotentRequest(started.key, status, JSON.parse(JSON.stringify(payload)));
      return reply.code(status).send(payload);
    },
  );
}
