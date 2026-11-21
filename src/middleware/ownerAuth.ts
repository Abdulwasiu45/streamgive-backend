import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { bodyHash, sep53Hash } from './adminAuth.js';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SECONDS_TIMESTAMP_MAXMAGNI = 100_000_000_000;
const ED25519_SIGNATURE_BYTES = 64;

const usedOwnerSignatures = new Map<string, number>();

function pruneUsedOwnerSignatures(now = Date.now()): void {
  for (const [key, seenAt] of usedOwnerSignatures) {
    if (now - seenAt > MAX_CLOCK_SKEW_MS) usedOwnerSignatures.delete(key);
  }
}

const ownerReplayPruner = setInterval(pruneUsedOwnerSignatures, 60_000);
ownerReplayPruner.unref();

/**
 * Verifies a SEP-53 Stellar signature from an arbitrary NGO/applicant owner
 * address using `x-owner-address`, `x-owner-timestamp`, and `x-owner-signature`.
 *
 * The signed payload matches adminAuth: `${method}:${url}:${timestamp}:${bodyHash}`.
 */
export async function requireOwnerSignature(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const address = request.headers['x-owner-address'];
  const timestampRaw = request.headers['x-owner-timestamp'];
  const signature = request.headers['x-owner-signature'];

  if (
    typeof address !== 'string' ||
    typeof timestampRaw !== 'string' ||
    typeof signature !== 'string' ||
    !address ||
    !timestampRaw ||
    !signature
  ) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!StrKey.isValidEd25519PublicKey(address)) {
    return reply.code(401).send({ error: 'invalid_owner_address' });
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp)) {
    return reply.code(401).send({ error: 'invalid_timestamp' });
  }
  if (timestamp > 0 && timestamp < SECONDS_TIMESTAMP_MAXMAGNI) {
    return reply.code(401).send({ error: 'timestamp_in_seconds' });
  }

  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    return reply.code(401).send({ error: 'stale_timestamp' });
  }

  const rawBody =
    (request as FastifyRequest & { rawBody?: Buffer | string }).rawBody ??
    (request.body !== undefined ? JSON.stringify(request.body) : '');
  const message = `${request.method.toUpperCase()}:${request.url}:${timestampRaw}:${bodyHash(rawBody)}`;

  let valid = false;
  try {
    const keypair = Keypair.fromPublicKey(address);
    const candidates = [Buffer.from(signature, 'base64'), Buffer.from(signature, 'hex')];
    valid = candidates.some(
      (candidate) =>
        candidate.length === ED25519_SIGNATURE_BYTES && keypair.verify(sep53Hash(message), candidate),
    );
  } catch {
    valid = false;
  }

  if (!valid) {
    return reply.code(401).send({ error: 'invalid_signature' });
  }

  const replayKey = `${address}:${timestampRaw}:${signature}`;
  pruneUsedOwnerSignatures(now);
  if (usedOwnerSignatures.has(replayKey)) {
    return reply.code(401).send({ error: 'replayed_signature' });
  }
  usedOwnerSignatures.set(replayKey, now);
}
