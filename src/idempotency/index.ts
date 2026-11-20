import { createHash } from 'node:crypto';

import { Prisma } from '../generated/prisma/client.js';

import { prisma } from '../db.js';

/** How long a stored response is replayed for a repeated key. */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Header clients send; 1–255 visible ASCII characters. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export type IdempotencyStart =
  | { kind: 'proceed'; key: string }
  | { kind: 'replay'; statusCode: number; response: unknown }
  | { kind: 'conflict'; error: 'idempotency_key_reused' | 'idempotency_request_in_progress' }
  | { kind: 'invalid' };

export function hashRequestBody(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * Claims `clientKey` for this request. The first request with a key proceeds
 * (a placeholder row reserves it, so a concurrent duplicate is refused);
 * a later request with the same key and body gets the stored response; the
 * same key with a different body is a conflict. Expired keys start over.
 */
export async function beginIdempotentRequest(
  scope: string,
  clientKey: string,
  requestHash: string,
  now: Date = new Date(),
): Promise<IdempotencyStart> {
  if (!isValidIdempotencyKey(clientKey)) return { kind: 'invalid' };
  const key = `${scope}:${clientKey}`;

  const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
  if (existing && existing.expiresAt > now) {
    if (existing.requestHash !== requestHash) {
      return { kind: 'conflict', error: 'idempotency_key_reused' };
    }
    if (existing.statusCode === null) {
      return { kind: 'conflict', error: 'idempotency_request_in_progress' };
    }
    return { kind: 'replay', statusCode: existing.statusCode, response: existing.response };
  }
  if (existing) {
    await prisma.idempotencyRecord.deleteMany({ where: { key, expiresAt: { lte: now } } });
  }

  try {
    await prisma.idempotencyRecord.create({
      data: { key, requestHash, expiresAt: new Date(now.getTime() + IDEMPOTENCY_WINDOW_MS) },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { kind: 'conflict', error: 'idempotency_request_in_progress' };
    }
    throw err;
  }
  return { kind: 'proceed', key };
}

/** Stores the final response for a claimed key so retries can replay it. */
export async function completeIdempotentRequest(
  key: string,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await prisma.idempotencyRecord.update({
    where: { key },
    data: { statusCode, response: (response ?? Prisma.JsonNull) as Prisma.InputJsonValue },
  });
}

/** Releases a claimed key after an unexpected failure so the client can retry. */
export async function abandonIdempotentRequest(key: string): Promise<void> {
  await prisma.idempotencyRecord.deleteMany({ where: { key, statusCode: null } });
}
