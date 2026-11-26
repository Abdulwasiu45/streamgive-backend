import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/db.js';
import {
  IDEMPOTENCY_LOCK_TTL_MS,
  IDEMPOTENCY_WINDOW_MS,
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  hashRequestBody,
} from '../src/idempotency/index.js';
import { resetDb } from './helpers/db.js';

const SCOPE = 'test';
const KEY = 'my-key-1';
const BODY = hashRequestBody('{"foo":1}');

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await resetDb();
});

describe('beginIdempotentRequest', () => {
  it('returns proceed on the first call', async () => {
    const result = await beginIdempotentRequest(SCOPE, KEY, BODY);
    expect(result.kind).toBe('proceed');
  });

  it('returns invalid for a key that fails the pattern check', async () => {
    const result = await beginIdempotentRequest(SCOPE, '', BODY);
    expect(result.kind).toBe('invalid');
  });

  it('returns idempotency_key_reused when the same key is used with a different body', async () => {
    await beginIdempotentRequest(SCOPE, KEY, BODY);
    const result = await beginIdempotentRequest(SCOPE, KEY, hashRequestBody('{"foo":2}'));
    expect(result).toEqual({ kind: 'conflict', error: 'idempotency_key_reused' });
  });

  it('returns idempotency_request_in_progress when a fresh placeholder exists', async () => {
    await beginIdempotentRequest(SCOPE, KEY, BODY);
    // Same scope+key+body, placeholder still fresh
    const result = await beginIdempotentRequest(SCOPE, KEY, BODY);
    expect(result).toEqual({ kind: 'conflict', error: 'idempotency_request_in_progress' });
  });

  it('returns replay once the request is completed', async () => {
    const first = await beginIdempotentRequest(SCOPE, KEY, BODY);
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await completeIdempotentRequest(first.key, 201, { id: 'abc' });

    const replay = await beginIdempotentRequest(SCOPE, KEY, BODY);
    expect(replay).toEqual({ kind: 'replay', statusCode: 201, response: { id: 'abc' } });
  });

  it('allows a retry to take over a stale placeholder older than the lock TTL', async () => {
    // Insert a placeholder whose createdAt is in the past, beyond the lock TTL.
    const staleCutoff = new Date(Date.now() - IDEMPOTENCY_LOCK_TTL_MS - 1000);
    const compositeKey = `${SCOPE}:${KEY}`;
    await prisma.idempotencyRecord.create({
      data: {
        key: compositeKey,
        requestHash: BODY,
        statusCode: null,
        createdAt: staleCutoff,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_WINDOW_MS),
      },
    });

    // The retry should NOT get idempotency_request_in_progress — it should
    // take over the stale lock and return proceed.
    const result = await beginIdempotentRequest(SCOPE, KEY, BODY);
    expect(result.kind).toBe('proceed');
  });

  it('keeps a fresh in-progress placeholder (does not let a second request through)', async () => {
    const compositeKey = `${SCOPE}:${KEY}`;
    // A placeholder created just now — still within the lock TTL.
    await prisma.idempotencyRecord.create({
      data: {
        key: compositeKey,
        requestHash: BODY,
        statusCode: null,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_WINDOW_MS),
      },
    });

    const result = await beginIdempotentRequest(SCOPE, KEY, BODY);
    expect(result).toEqual({ kind: 'conflict', error: 'idempotency_request_in_progress' });
  });

  it('allows a new request once the window has expired', async () => {
    // Insert an already-expired record.
    const compositeKey = `${SCOPE}:${KEY}`;
    await prisma.idempotencyRecord.create({
      data: {
        key: compositeKey,
        requestHash: BODY,
        statusCode: 201,
        response: { id: 'old' },
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const result = await beginIdempotentRequest(SCOPE, KEY, BODY);
    expect(result.kind).toBe('proceed');
  });
});

describe('abandonIdempotentRequest', () => {
  it('removes an in-progress record so the client can retry immediately', async () => {
    const started = await beginIdempotentRequest(SCOPE, KEY, BODY);
    if (started.kind !== 'proceed') throw new Error('expected proceed');

    await abandonIdempotentRequest(started.key);

    const record = await prisma.idempotencyRecord.findUnique({ where: { key: started.key } });
    expect(record).toBeNull();
  });

  it('does not remove a completed record', async () => {
    const started = await beginIdempotentRequest(SCOPE, KEY, BODY);
    if (started.kind !== 'proceed') throw new Error('expected proceed');
    await completeIdempotentRequest(started.key, 200, {});

    await abandonIdempotentRequest(started.key);

    const record = await prisma.idempotencyRecord.findUnique({ where: { key: started.key } });
    expect(record).not.toBeNull();
    expect(record?.statusCode).toBe(200);
  });
});
