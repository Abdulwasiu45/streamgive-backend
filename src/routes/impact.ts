import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';
import { getPublicNgoName } from './ngoName.js';
import { committedTotalsByToken } from './tokenTotals.js';

/** Params for GET /v1/impact/:ngoId; `ngoId` must be an NGO UUID. */
const paramsSchema = z.object({ ngoId: z.string().uuid() });

/** Longest range GET /v1/impact/:ngoId/timeseries returns, in days (inclusive). */
export const MAX_TIMESERIES_DAYS = 90;
/** Range used when `from`/`to` are omitted: the last 30 days, ending today (UTC). */
const DEFAULT_TIMESERIES_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)));
const timeseriesQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

type TimeseriesRow = {
  day: Date;
  new_streams: bigint | number;
  withdrawals: bigint | number;
  withdrawn_amount: string;
};

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Resolves the requested range, or an error code when it is invalid or too long. */
export function resolveTimeseriesRange(
  query: { from?: string; to?: string },
  now: Date = new Date(),
): { from: string; to: string } | { error: 'invalid_range' | 'range_too_large' } {
  const to = query.to ?? (query.from
    ? utcDay(new Date(Date.parse(`${query.from}T00:00:00Z`) + (DEFAULT_TIMESERIES_DAYS - 1) * DAY_MS))
    : utcDay(now));
  const from = query.from ?? utcDay(new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_TIMESERIES_DAYS - 1) * DAY_MS));
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  if (days < 1) return { error: 'invalid_range' };
  if (days > MAX_TIMESERIES_DAYS) return { error: 'range_too_large' };
  return { from, to };
}

/**
 * Public "impact" view for one NGO — a superset of /ngos/:id's profile
 * stats, framed around relative impact rather than admin/profile detail:
 * active vs. cancelled breakdown, and this NGO's share of everything ever
 * committed platform-wide. That platform-wide comparison is the reason
 * this isn't just folded into /ngos/:id — a plain profile page shouldn't
 * need to scan every stream on the platform to render.
 */
export async function impactRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Returns platform-wide committed/withdrawn totals and activity counts.
   * @route GET /v1/impact
   * @auth Public
   * @returns 200 `{ totalCommitted: string, totalWithdrawn: string, activeStreams: number, verifiedNgoCount: number }`.
   */
  app.get('/impact', async (request, reply) => {
    const [streams, verifiedNgoCount] = await Promise.all([
      prisma.stream.findMany({
        select: { balance: true, withdrawn: true, status: true, tokenAddress: true },
      }),
      prisma.ngo.count({ where: { verified: true } }),
    ]);

    // For cancelled streams the balance was refunded to the donor and never
    // delivered to any NGO, so only count withdrawn.  Active streams count
    // balance + withdrawn (balance will be withdrawn in the future).
    const totalCommitted = streams.reduce(
      (sum, s) =>
        s.status === 'CANCELLED'
          ? sum + BigInt(s.withdrawn)
          : sum + BigInt(s.balance) + BigInt(s.withdrawn),
      0n,
    );
    const totalWithdrawn = streams.reduce((sum, s) => sum + BigInt(s.withdrawn), 0n);
    const activeStreams = streams.filter((s) => s.status === 'ACTIVE').length;

    return sendPublicCacheable(request, reply, {
      totalCommitted: totalCommitted.toString(),
      committedByToken: committedTotalsByToken(streams),
      totalWithdrawn: totalWithdrawn.toString(),
      activeStreams,
      verifiedNgoCount,
    });
  });

  /**
   * Returns one NGO's contribution and share of platform-wide impact.
   * @route GET /v1/impact/:ngoId
   * @param ngoId NGO UUID
   * @auth Public
   * @returns 200 NGO impact totals, stream counts, unique donor count, and `platformSharePercent`; 400 invalid UUID; 404 `{ error: "not_found" }`.
   */
  /**
   * Per-day activity for one NGO, aggregated in SQL: new streams (by
   * `streams.created_at`) and withdrawals with their summed amounts (from
   * indexed `withdraw` events). Days with no activity are returned as zeros.
   * @route GET /v1/impact/:ngoId/timeseries
   * @query from, to — inclusive UTC dates (YYYY-MM-DD); default the last 30 days; at most 90 days
   * @returns 200 `{ ngoId, from, to, days: [{ date, newStreams, withdrawals, withdrawnAmount }] }`;
   * 400 invalid request or range; 404 unknown NGO.
   */
  app.get(
    '/impact/:ngoId/timeseries',
    {
      schema: {
        tags: ['Impact'],
        summary: 'Get a daily time series of one NGO\'s streams and withdrawals',
        params: {
          type: 'object',
          properties: { ngoId: { type: 'string', format: 'uuid' } },
          required: ['ngoId'],
        },
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', format: 'date' },
            to: { type: 'string', format: 'date' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      const parsedQuery = timeseriesQuerySchema.safeParse(request.query);
      if (!parsedParams.success || !parsedQuery.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const range = resolveTimeseriesRange(parsedQuery.data);
      if ('error' in range) {
        return reply
          .code(400)
          .send({ error: range.error, maxDays: MAX_TIMESERIES_DAYS });
      }
      const { ngoId } = parsedParams.data;

      const ngo = await prisma.ngo.findUnique({ where: { id: ngoId }, select: { id: true } });
      if (!ngo) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const rows = await prisma.$queryRaw<TimeseriesRow[]>`
        WITH days AS (
          SELECT d::date AS day
          FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS d
        ),
        created AS (
          SELECT created_at::date AS day, COUNT(*) AS n
          FROM streams
          WHERE ngo_id = ${ngoId}
            AND created_at >= ${range.from}::date
            AND created_at < ${range.to}::date + 1
          GROUP BY 1
        ),
        withdrawn AS (
          SELECT e.created_at::date AS day,
                 COUNT(*) AS n,
                 SUM((e.payload->>'accrued')::numeric) AS amount
          FROM stream_events e
          JOIN streams s ON s.on_chain_id = e.stream_id
          WHERE s.ngo_id = ${ngoId}
            AND e.type = 'withdraw'
            AND e.created_at >= ${range.from}::date
            AND e.created_at < ${range.to}::date + 1
          GROUP BY 1
        )
        SELECT days.day,
               COALESCE(c.n, 0) AS new_streams,
               COALESCE(w.n, 0) AS withdrawals,
               COALESCE(w.amount, 0)::text AS withdrawn_amount
        FROM days
        LEFT JOIN created c ON c.day = days.day
        LEFT JOIN withdrawn w ON w.day = days.day
        ORDER BY days.day
      `;

      return sendPublicCacheable(request, reply, {
        ngoId,
        from: range.from,
        to: range.to,
        days: rows.map((row) => ({
          date: utcDay(row.day),
          newStreams: Number(row.new_streams),
          withdrawals: Number(row.withdrawals),
          withdrawnAmount: row.withdrawn_amount,
        })),
      });
    },
  );

  app.get(
    '/impact/:ngoId',
    {
      schema: {
        tags: ['Impact'],
        summary: 'Get impact totals for one NGO',
        params: {
          type: 'object',
          properties: { ngoId: { type: 'string', format: 'uuid' } },
          required: ['ngoId'],
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { ngoId } = parsedParams.data;

      const ngo = await prisma.ngo.findUnique({
        where: { id: ngoId },
        include: {
          streams: {
            select: {
              status: true,
              balance: true,
              withdrawn: true,
              donorId: true,
              tokenAddress: true,
            },
          },
        },
      });

      if (!ngo) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // For cancelled streams the balance was refunded to the donor, so only
      // count withdrawn.  Active streams count balance + withdrawn.
      const ngoCommitted = ngo.streams.reduce(
        (sum, s) =>
          s.status === 'CANCELLED'
            ? sum + BigInt(s.withdrawn)
            : sum + BigInt(s.balance) + BigInt(s.withdrawn),
        0n,
      );
      const ngoWithdrawn = ngo.streams.reduce((sum, s) => sum + BigInt(s.withdrawn), 0n);

      // Scans every stream on the platform — fine at MVP scale, but this is
      // the first thing to replace with a maintained running total if the
      // streams table grows large.
      const allStreams = await prisma.stream.findMany({
        select: { balance: true, withdrawn: true, status: true, tokenAddress: true },
      });
      const platformCommitted = allStreams.reduce(
        (sum, s) =>
          s.status === 'CANCELLED'
            ? sum + BigInt(s.withdrawn)
            : sum + BigInt(s.balance) + BigInt(s.withdrawn),
        0n,
      );

      const percentScale = 1_000_000_000_000n;
      const platformSharePercent =
        platformCommitted > 0n
          ? Number((ngoCommitted * 100n * percentScale) / platformCommitted) /
            Number(percentScale)
          : 0;

      return sendPublicCacheable(request, reply, {
        ngoId: ngo.id,
        name: getPublicNgoName(ngo),
        totalCommitted: ngoCommitted.toString(),
        committedByToken: committedTotalsByToken(ngo.streams),
        platformCommittedByToken: committedTotalsByToken(allStreams),
        totalWithdrawn: ngoWithdrawn.toString(),
        activeStreams: ngo.streams.filter((s) => s.status === 'ACTIVE').length,
        cancelledStreams: ngo.streams.filter((s) => s.status === 'CANCELLED').length,
        uniqueDonors: new Set(ngo.streams.map((s) => s.donorId)).size,
        platformSharePercent,
      });
    },
  );
}
