import { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';
import { getPublicNgoName } from './ngoName.js';
import { serializeStream } from './streams.js';
import { isVerifiedAt } from './ngoVerification.js';
import { committedTotalsByToken } from './tokenTotals.js';

/** Params for NGO detail and donor routes; `id` must be an NGO UUID. */
const idParamSchema = z.object({ id: z.string().uuid() });
const RECENT_STREAMS_LIMIT = 10;

interface NgoListRow {
  id: string;
  ownerAddress: string;
  name: string;
  displayName: string | null;
  verified: boolean;
  verifiedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Public directory sort mode: newest, oldest, or name (default newest). */
const sortSchema = z.enum(['newest', 'oldest', 'name']).default('newest');

/**
 * Public directory query: `limit` from 1–100 (default 100), optional NGO
 * UUID `cursor`, `sort` mode, and optional case-insensitive `q` up to
 * 100 characters.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  sort: sortSchema,
  // Name search: case-insensitive substring match, capped to prevent abuse.
  q: z.string().max(100).optional(),
});

/** NGO streams query: optional `status`, `limit` from 1–100 (default 100) and optional stream UUID `cursor`. */
const ngoStreamsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
});

/** Donor-list query: `limit` from 1–100 (default 100) and optional donor UUID `cursor`. */
const donorListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
});

/** Lookup query; `address` must be a Stellar G... public key. */
const lookupQuerySchema = z.object({
  // Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
  address: z.string().regex(/^G[A-Z2-7]{55}$/),
});

const ngoStreamInclude = {
  donor: { select: { address: true } },
  ngo: { select: { id: true, name: true, displayName: true, ownerAddress: true } },
} as const;

function committedAmount(stream: {
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  balance: string;
  withdrawn: string;
}): bigint {
  return stream.status === 'CANCELLED'
    ? BigInt(stream.withdrawn)
    : BigInt(stream.balance) + BigInt(stream.withdrawn);
}

/** Builds the GET /ngos/:id response shape from a unique Prisma `where`. */
async function findNgoDetail(where: { id: string } | { ownerAddress: string }) {
  const ngo = await prisma.ngo.findUnique({ where });

  if (!ngo) {
    return null;
  }

  const [approvedApp, streamStats, recentStreamRows, streamsForTokenTotals] = await Promise.all([
    prisma.ngoApplication.findFirst({
      where: { ownerAddress: ngo.ownerAddress, status: 'APPROVED' },
      orderBy: { updatedAt: 'desc' },
      select: { description: true, website: true, country: true },
    }),
    prisma.$queryRaw<
      Array<{
        totalCommitted: string;
        totalWithdrawn: string;
        activeStreamCount: number;
        donorCount: number;
      }>
    >`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN "status" = 'CANCELLED' THEN "withdrawn"::numeric
            ELSE "balance"::numeric + "withdrawn"::numeric
          END
        ), 0)::text AS "totalCommitted",
        COALESCE(SUM("withdrawn"::numeric), 0)::text AS "totalWithdrawn",
        COUNT(*) FILTER (WHERE "status" = 'ACTIVE')::int AS "activeStreamCount",
        COUNT(DISTINCT "donor_id")::int AS "donorCount"
      FROM "streams"
      WHERE "ngo_id" = ${ngo.id}
    `,
    prisma.stream.findMany({
      where: { ngoId: ngo.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_STREAMS_LIMIT + 1,
      select: {
        id: true,
        onChainId: true,
        donor: { select: { address: true } },
        tokenAddress: true,
        rate: true,
        balance: true,
        withdrawn: true,
        status: true,
        memo: true,
        startsAt: true,
        createdAt: true,
      },
    }),
    prisma.stream.findMany({
      where: { ngoId: ngo.id },
      select: { status: true, balance: true, withdrawn: true, tokenAddress: true },
    }),
  ]);

  const [stats] = streamStats;
  const hasMoreRecentStreams = recentStreamRows.length > RECENT_STREAMS_LIMIT;
  const recentStreams = recentStreamRows.slice(0, RECENT_STREAMS_LIMIT);

  return {
    ...ngo,
    verified: isVerifiedAt(ngo),
    verifiedUntil: ngo.verifiedUntil ?? null,
    name: getPublicNgoName(ngo) || null,
    registered: ngo.name !== '',
    description: ngo.description ?? approvedApp?.description ?? null,
    website: ngo.website ?? approvedApp?.website ?? null,
    profileUpdatedAt: ngo.profileUpdatedAt ?? null,
    country: approvedApp?.country ?? null,
    stats: {
      totalCommitted: stats.totalCommitted,
      committedByToken: committedTotalsByToken(streamsForTokenTotals),
      totalWithdrawn: stats.totalWithdrawn,
      activeStreamCount: stats.activeStreamCount,
      donorCount: stats.donorCount,
    },
    recentStreams: recentStreams.map(({ onChainId, ...stream }) => ({
      ...stream,
      onChainId: onChainId.toString(),
    })),
    recentStreamsNextCursor: hasMoreRecentStreams ? (recentStreams.at(-1)?.id ?? null) : null,
  };
}

export async function ngoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists verified NGOs with search, sorting, and cursor pagination.
   * @route GET /v1/ngos
   * @query limit, cursor, sort, q
   * @auth Public
   * @returns 200 `{ ngos: NgoSummary[], nextCursor: string | null }`; 400 `{ error: "invalid_request", details }`.
   */
  app.get('/ngos', async (request, reply) => {
    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }
    const { limit, cursor, sort, q } = parsedQuery.data;

    // @prisma/adapter-pg sends string parameters as type `text`. The ngos.id
    // column is also `text` in Postgres (Prisma maps String @id to text, not
    // the native uuid type), so both sides of the comparison are already text.
    // Casting to ::uuid would produce "operator does not exist: text = uuid".
    // Use an explicit ::text cast on the parameter to keep the types aligned.
    const cursorFilter = cursor ? Prisma.sql`${cursor}::text` : Prisma.sql`NULL::text`;

    const rows = await prisma.$queryRaw<NgoListRow[]>`
      WITH cursor_ngo AS (
        SELECT id, COALESCE(NULLIF(display_name, ''), name) AS public_name, created_at
        FROM ngos
        WHERE id = ${cursorFilter}
      )
      SELECT
        ngo.id,
        ngo.owner_address AS "ownerAddress",
        ngo.name,
        ngo.display_name AS "displayName",
        ngo.verified,
        ngo.verified_until AS "verifiedUntil",
        ngo.created_at AS "createdAt",
        ngo.updated_at AS "updatedAt"
      FROM ngos AS ngo
      WHERE ngo.verified = TRUE
        AND (ngo.verified_until IS NULL OR ngo.verified_until > (NOW() AT TIME ZONE 'UTC'))
        AND (
          ${q ?? null}::text IS NULL
          OR COALESCE(NULLIF(ngo.display_name, ''), ngo.name) ILIKE '%' || ${q ?? null} || '%'
        )
        AND (
          ${cursorFilter} IS NULL
          OR EXISTS (
            SELECT 1
            FROM cursor_ngo AS cursor_row
            WHERE
              (${sort} = 'name' AND (COALESCE(NULLIF(ngo.display_name, ''), ngo.name), ngo.id) > (cursor_row.public_name, cursor_row.id))
              OR (${sort} = 'oldest' AND (ngo.created_at, ngo.id) > (cursor_row.created_at, cursor_row.id))
              OR (${sort} = 'newest' AND (
                ngo.created_at < cursor_row.created_at
                OR (ngo.created_at = cursor_row.created_at AND ngo.id > cursor_row.id)
              ))
          )
        )
      ORDER BY
        CASE WHEN ${sort} = 'name' THEN COALESCE(NULLIF(ngo.display_name, ''), ngo.name) END ASC,
        CASE WHEN ${sort} = 'oldest' THEN ngo.created_at END ASC,
        CASE WHEN ${sort} = 'newest' THEN ngo.created_at END DESC,
        ngo.id ASC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const ngos = (hasMore ? rows.slice(0, limit) : rows).map((ngo) => ({
      ...ngo,
      name: getPublicNgoName(ngo),
    }));
    const nextCursor = hasMore ? ngos[ngos.length - 1].id : null;

    return sendPublicCacheable(request, reply, { ngos, nextCursor });
  });

  /**
   * Finds a public NGO profile by Stellar owner address.
   * @route GET /v1/ngos/lookup
   * @query address Stellar public key
   * @auth Public
   * @returns 200 NGO detail with approved application information, totals, and recent streams; 400 invalid address; 404 `{ error: "not_found" }`.
   */
  app.get('/ngos/lookup', async (request, reply) => {
    const parsedQuery = lookupQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }

    const ngo = await findNgoDetail({ ownerAddress: parsedQuery.data.address });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return sendPublicCacheable(request, reply, ngo);
  });

  /**
   * Lists the streams paying one NGO, newest first, with an optional status filter.
   * @route GET /v1/ngos/:id/streams
   * @param id NGO UUID
   * @query status, limit, cursor (a stream id from the previous page's `nextCursor`)
   * @auth Public
   * @returns 200 `{ streams: Stream[], hasMore: boolean, nextCursor: string | null }`; 400 invalid id, query or unknown cursor; 404 `{ error: "not_found" }`.
   */
  app.get('/ngos/:id/streams', async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    const parsedQuery = ngoStreamsQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const { status, limit, cursor } = parsedQuery.data;
    const ngoId = parsedParams.data.id;

    const ngo = await prisma.ngo.findUnique({ where: { id: ngoId }, select: { id: true } });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // A cursor that is not one of this NGO's streams would look like an empty last page.
    if (cursor) {
      const cursorStream = await prisma.stream.findFirst({
        where: { id: cursor, ngoId },
        select: { id: true },
      });
      if (!cursorStream) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
    }

    const rows = await prisma.stream.findMany({
      where: { ngoId, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: ngoStreamInclude,
    });

    const hasMore = rows.length > limit;
    const streams = hasMore ? rows.slice(0, limit) : rows;

    return sendPublicCacheable(request, reply, {
      streams: streams.map(serializeStream),
      hasMore,
      nextCursor: hasMore ? (streams.at(-1)?.id ?? null) : null,
    });
  });

  /**
   * Lists donors who have streams for the specified NGO.
   * @route GET /v1/ngos/:id/donors
   * @param id NGO UUID
   * @query limit, cursor
   * @auth Public
   * @returns 200 `{ donors: { id, address, totalCommitted }[], nextCursor: string | null }`; 400 invalid params/query; 404 `{ error: "not_found" }`.
   */
  app.get('/ngos/:id/donors', async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    const parsedQuery = donorListQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const { id: ngoId } = parsedParams.data;
    const { limit, cursor } = parsedQuery.data;
    const ngo = await prisma.ngo.findUnique({ where: { id: ngoId }, select: { id: true } });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const donorQuery = prisma.donor.findMany({
      where: { streams: { some: { ngoId } } },
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        address: true,
        streams: {
          where: { ngoId },
          select: { status: true, balance: true, withdrawn: true, tokenAddress: true },
        },
      },
    });
    type DonorRow = Awaited<typeof donorQuery>[number];

    let rows: DonorRow[];
    try {
      rows = await donorQuery;
    } catch (err: unknown) {
      // Prisma throws P2025 (NotFoundError) when the cursor record does not
      // exist. Treat that as "cursor is past the end of the list" and return
      // an empty page rather than a 400/500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        rows = [];
      } else {
        throw err;
      }
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const donors = page.map(({ streams, ...donor }) => ({
      ...donor,
      totalCommitted: streams.reduce((sum, stream) => sum + committedAmount(stream), 0n).toString(),
      committedByToken: committedTotalsByToken(streams),
    }));

    return sendPublicCacheable(request, reply, {
      donors,
      nextCursor: hasMore ? donors[donors.length - 1].id : null,
    });
  });

  /**
   * Returns a public NGO profile with approved application details and impact statistics.
   * @route GET /v1/ngos/:id
   * @param id NGO UUID
   * @auth Public
   * @returns 200 NGO detail with totals and recent streams; 400 invalid UUID; 404 `{ error: "not_found" }`.
   */
  app.get('/ngos/:id', async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const ngo = await findNgoDetail({ id: parsedParams.data.id });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return sendPublicCacheable(request, reply, ngo);
  });
}
