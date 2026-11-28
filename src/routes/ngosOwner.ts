import { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
import { requireOwnerSignature } from '../middleware/ownerAuth.js';
import { getPublicNgoName } from './ngoName.js';
import { isVerifiedAt } from './ngoVerification.js';
import { escapeCsvField } from './donors.js';

/** Params for owner routes; `id` must be an NGO UUID. */
const idParamSchema = z.object({ id: z.string().uuid() });

const WITHDRAWALS_CSV_BATCH_SIZE = 500;
const WITHDRAWALS_CSV_HEADERS = [
  'eventId',
  'streamId',
  'tokenAddress',
  'amount',
  'ledger',
  'txHash',
  'withdrawnAt',
];

interface WithdrawalRow {
  id: string;
  streamId: bigint;
  tokenAddress: string;
  amount: string | null;
  ledger: number;
  txHash: string;
  createdAt: Date;
}

/**
 * Owner profile update body; enforces the same limits as the NGO application
 * form (`description` 1–5000 trimmed chars, `website` URL max 2048 chars with
 * scheme-less HTTPS normalization, or null to clear website).
 */
export const updateNgoProfileSchema = z
  .object({
    description: z.string().trim().min(1).max(5000).optional(),
    website: z
      .union([
        z.null(),
        z
          .string()
          .trim()
          .transform((val) => (val && !/^https?:\/\//i.test(val) ? `https://${val}` : val))
          .pipe(z.string().url().max(2048)),
      ])
      .optional(),
  })
  .refine((data) => data.description !== undefined || data.website !== undefined, {
    message: 'At least one of description or website must be provided',
  });

export async function ngoOwnerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lets a verified NGO owner update the NGO's public description and website.
   * @route PATCH /v1/ngos/:id/profile
   * @param id NGO UUID
   * @body `{ description?: string, website?: string | null }`
   * @auth Owner signature required via `x-owner-address`, `x-owner-timestamp`, and `x-owner-signature`.
   */
  app.patch('/ngos/:id/profile', { preHandler: requireOwnerSignature }, async (request, reply) => {
    const ownerAddress = request.headers['x-owner-address'];
    if (typeof ownerAddress !== 'string') {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const parsedBody = updateNgoProfileSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedBody.error.flatten() });
    }

    const ngo = await prisma.ngo.findUnique({ where: { id: parsedParams.data.id } });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (ngo.ownerAddress !== ownerAddress) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (!isVerifiedAt(ngo)) {
      return reply.code(403).send({ error: 'ngo_not_verified' });
    }

    const updated = await prisma.ngo.update({
      where: { id: ngo.id },
      data: {
        ...(parsedBody.data.description !== undefined
          ? { description: parsedBody.data.description }
          : {}),
        ...(parsedBody.data.website !== undefined ? { website: parsedBody.data.website } : {}),
        profileUpdatedAt: new Date(),
      },
    });

    return { ...updated, name: getPublicNgoName(updated) || null };
  });

  /**
   * Exports an NGO's withdrawals as a formula-safe CSV, streamed in batches.
   * @route GET /v1/ngos/:id/withdrawals.csv
   * @param id NGO UUID
   * @auth Owner signature required via `x-owner-address`, `x-owner-timestamp`, and `x-owner-signature`.
   * @returns 200 CSV stream; 400 invalid id; 401 unauthorized; 403 `{ error: "forbidden" }` when the signer is not the owner; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/ngos/:id/withdrawals.csv',
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

      const ngo = await prisma.ngo.findUnique({ where: { id: parsedParams.data.id } });
      if (!ngo) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (ngo.ownerAddress !== ownerAddress) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="ngo-${ngo.id}-withdrawals.csv"`,
      );

      const csv = Readable.from(
        (async function* () {
          yield `${WITHDRAWALS_CSV_HEADERS.map(escapeCsvField).join(',')}\r\n`;
          let cursor: { ledger: number; id: string } | undefined;

          while (true) {
            const rows: WithdrawalRow[] = await prisma.$queryRaw<WithdrawalRow[]>(Prisma.sql`
              SELECT e.id,
                     e.stream_id AS "streamId",
                     s.token_address AS "tokenAddress",
                     e.payload->>'accrued' AS "amount",
                     e.ledger,
                     e.tx_hash AS "txHash",
                     e.created_at AS "createdAt"
              FROM "stream_events" e
              JOIN "streams" s ON s.on_chain_id = e.stream_id
              WHERE s.ngo_id = ${ngo.id}
                AND e.type = 'withdraw'
                ${
                  cursor
                    ? Prisma.sql`AND (e.ledger, e.id) > (${cursor.ledger}::int, ${cursor.id}::text)`
                    : Prisma.empty
                }
              ORDER BY e.ledger ASC, e.id ASC
              LIMIT ${WITHDRAWALS_CSV_BATCH_SIZE}
            `);

            for (const row of rows) {
              const fields = [
                row.id,
                row.streamId.toString(),
                row.tokenAddress,
                row.amount ?? '',
                row.ledger,
                row.txHash,
                row.createdAt.toISOString(),
              ];
              yield `${fields.map(escapeCsvField).join(',')}\r\n`;
            }

            const last = rows.at(-1);
            if (!last || rows.length < WITHDRAWALS_CSV_BATCH_SIZE) break;
            cursor = { ledger: last.ledger, id: last.id };
          }
        })(),
      );

      return reply.send(csv);
    },
  );
}
