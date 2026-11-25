import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { prisma } from '../../db.js';
import { sep53Hash } from '../../middleware/adminAuth.js';

export const APPLICATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Submission body: `ownerAddress` must be a Stellar G... public key;
 * `name` and `description` are required (1–200 and 1–5000 characters after
 * trimming — whitespace-only values are rejected); `contactEmail` is a
 * required email (max 254 characters per RFC 5321); optional `website` is
 * normalized to HTTPS when scheme-less, must be a URL, and is capped at 2048
 * characters; optional `country` is at most 100 characters. `challenge` and
 * `signature` prove control of ownerAddress.
 */
export const applicationSchema = z.object({
  ownerAddress: z.string().regex(/^G[A-Z2-7]{55}$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  // Normalize scheme-less domains (e.g. "example.org") to "https://example.org"
  // before URL validation so applicants who omit the scheme aren't blocked.
  // Already-schemed URLs are passed through unchanged to avoid double-prefixing.
  website: z
    .string()
    .transform((val) => (val && !/^https?:\/\//i.test(val) ? `https://${val}` : val))
    .pipe(z.string().url().max(2048))
    .optional(),
  contactEmail: z.string().email().max(254),
  country: z.string().max(100).optional(),
});

export const applicationSubmissionSchema = applicationSchema.extend({
  challenge: z.string().uuid(),
  signature: z.string().min(1),
});

export const challengeRequestSchema = z.object({
  ownerAddress: z.string().regex(/^G[A-Z2-7]{55}$/),
});

export function applicationChallengeMessage(
  ownerAddress: string,
  challenge: string,
  expiresAt: Date,
) {
  return [
    'StreamGive NGO application address verification',
    `Owner address: ${ownerAddress}`,
    `Challenge: ${challenge}`,
    `Expires at: ${expiresAt.toISOString()}`,
  ].join('\n');
}

export function verifyApplicationSignature(
  ownerAddress: string,
  message: string,
  signature: string,
): boolean {
  try {
    if (!StrKey.isValidEd25519PublicKey(ownerAddress)) return false;
    const keypair = Keypair.fromPublicKey(ownerAddress);
    const candidates = [Buffer.from(signature, 'base64'), Buffer.from(signature, 'hex')];
    return candidates.some(
      (candidate) => candidate.length === 64 && keypair.verify(sep53Hash(message), candidate),
    );
  } catch {
    return false;
  }
}

/**
 * Largest `offset` the admin list accepts. The database scans and discards
 * `offset` rows on every page, so an unbounded value lets one request force a
 * scan of the whole table. Requests above this are rejected with 400.
 */
export const MAX_APPLICATION_LIST_OFFSET = 10_000;

/**
 * Query for the admin list: optional status (`PENDING`, `APPROVED`, or
 * `REJECTED`), case-insensitive `search` over name and contact email,
 * inclusive `submittedAfter` / `submittedBefore` bounds on `createdAt`,
 * `limit` from 1–100 (default 100), and `offset` from
 * 0–`MAX_APPLICATION_LIST_OFFSET` (default 0).
 */
export const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN']).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  submittedAfter: z.coerce.date().optional(),
  submittedBefore: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).max(MAX_APPLICATION_LIST_OFFSET).default(0),
});

/** Params for application detail and review routes; `id` must be an application UUID. */
export const idParamSchema = z.object({ id: z.string().uuid() });

/** Query for the public status lookup; `ownerAddress` must be a Stellar G... public key. */
export const statusQuerySchema = z.object({
  // Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
  // Same regex as GET /ngos/lookup.
  ownerAddress: z.string().regex(/^G[A-Z2-7]{55}$/),
});

export const contactVerificationTokenSchema = z.object({ token: z.string().length(43) });

/** Review body for approve/reject; optional `reviewNote` is at most 2000 characters. */
export const reviewBodySchema = z.object({
  reviewNote: z.string().max(2000).optional(),
});

/**
 * Inserts a PENDING application, or reports the application that already
 * blocks this address.
 *
 * Read-then-write is a race on its own: two POSTs that arrive together both
 * read "nothing blocking", both insert, and one address ends up with two
 * PENDING applications. The obvious remedy — a partial unique index on
 * (owner_address) WHERE status = 'PENDING' — is not available here. This
 * project syncs its schema with `prisma db push` and has no migration files
 * (see DEPLOYMENT.md), so a raw index would never be applied, and Prisma's
 * schema language cannot express a partial index anyway.
 *
 * So the insert is serialised in the database instead: a transaction-scoped
 * advisory lock keyed on the owner address. The second request blocks until
 * the first transaction commits, then re-reads inside its own transaction and
 * sees the row the winner inserted, taking the 409 path. Postgres releases
 * the lock at COMMIT or ROLLBACK, so a crashed request cannot wedge the
 * address, and a `hashtext` collision only serialises two unrelated addresses
 * — it can never let a duplicate through.
 */
export async function createApplicationUnlessBlocked(data: z.infer<typeof applicationSchema>) {
  return prisma.$transaction(async (tx) => {
    // `::text` pins the bind parameter's type instead of leaving it to the
    // server to infer.
    // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns `void`, which
    // the pg driver adapter cannot deserialize into a JS value. $executeRaw
    // only needs the row count, so it sidesteps the unsupported column type.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${data.ownerAddress}::text)::bigint)`;

    const existingApp = await tx.ngoApplication.findFirst({
      where: {
        ownerAddress: data.ownerAddress,
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    if (existingApp) {
      return { ok: false as const, status: existingApp.status };
    }

    return { ok: true as const, application: await tx.ngoApplication.create({ data }) };
  });
}
