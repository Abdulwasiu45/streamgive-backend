import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../src/db.js', () => ({
  prisma: {
    idempotencyRecord: {
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '../src/db.js';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  IDEMPOTENCY_WINDOW_MS,
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  hashRequestBody,
  isValidIdempotencyKey,
} from '../src/idempotency/index.js';

const records = prisma.idempotencyRecord as unknown as Record<
  'findUnique' | 'deleteMany' | 'create' | 'update',
  Mock
>;
const now = new Date('2026-01-01T00:00:00.000Z');
const hash = hashRequestBody('{"a":1}');
const later = new Date(now.getTime() + 60_000);
const earlier = new Date(now.getTime() - 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  records.findUnique.mockResolvedValue(null);
  records.create.mockResolvedValue({});
  records.deleteMany.mockResolvedValue({ count: 0 });
});

describe('isValidIdempotencyKey and hashRequestBody', () => {
  it('accepts 1-255 visible ASCII characters only', () => {
    expect(isValidIdempotencyKey('a')).toBe(true);
    expect(isValidIdempotencyKey('x'.repeat(255))).toBe(true);
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('x'.repeat(256))).toBe(false);
    expect(isValidIdempotencyKey('has space')).toBe(false);
    expect(isValidIdempotencyKey('naïve')).toBe(false);
  });

  it('hashes strings and buffers to the same sha256 hex digest', () => {
    expect(hashRequestBody('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashRequestBody(Buffer.from('abc'))).toBe(hashRequestBody('abc'));
  });
});

describe('beginIdempotentRequest', () => {
  it('rejects an invalid key without touching the database', async () => {
    await expect(beginIdempotentRequest('scope', 'not valid', hash, now)).resolves.toEqual({
      kind: 'invalid',
    });
    expect(records.findUnique).not.toHaveBeenCalled();
    expect(records.create).not.toHaveBeenCalled();
  });

  it('claims a new key with a placeholder row that expires after the window', async () => {
    const result = await beginIdempotentRequest('scope', 'key-1', hash, now);

    expect(result).toEqual({ kind: 'proceed', key: 'scope:key-1' });
    expect(records.create).toHaveBeenCalledWith({
      data: {
        key: 'scope:key-1',
        requestHash: hash,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_WINDOW_MS),
      },
    });
  });

  it('replays the stored response for the same key and body', async () => {
    records.findUnique.mockResolvedValue({
      key: 'scope:key-1',
      requestHash: hash,
      statusCode: 201,
      response: { id: 'abc' },
      expiresAt: later,
    });

    await expect(beginIdempotentRequest('scope', 'key-1', hash, now)).resolves.toEqual({
      kind: 'replay',
      statusCode: 201,
      response: { id: 'abc' },
    });
    expect(records.create).not.toHaveBeenCalled();
  });

  it('refuses the same key with a different body', async () => {
    records.findUnique.mockResolvedValue({
      requestHash: hashRequestBody('other body'),
      statusCode: 201,
      response: {},
      expiresAt: later,
    });

    await expect(beginIdempotentRequest('scope', 'key-1', hash, now)).resolves.toEqual({
      kind: 'conflict',
      error: 'idempotency_key_reused',
    });
    expect(records.create).not.toHaveBeenCalled();
  });

  it('reports a request that is still in progress', async () => {
    records.findUnique.mockResolvedValue({
      requestHash: hash,
      statusCode: null,
      response: null,
      expiresAt: later,
    });

    await expect(beginIdempotentRequest('scope', 'key-1', hash, now)).resolves.toEqual({
      kind: 'conflict',
      error: 'idempotency_request_in_progress',
    });
  });

  it('starts over when the record expired between calls, even with a different body', async () => {
    records.findUnique.mockResolvedValue({
      requestHash: hashRequestBody('old body'),
      statusCode: 201,
      response: { id: 'old' },
      expiresAt: earlier,
    });

    const result = await beginIdempotentRequest('scope', 'key-1', hash, now);

    expect(result).toEqual({ kind: 'proceed', key: 'scope:key-1' });
    expect(records.deleteMany).toHaveBeenCalledWith({
      where: { key: 'scope:key-1', expiresAt: { lte: now } },
    });
    expect(records.create).toHaveBeenCalledTimes(1);
  });

  it('treats a record that expires exactly now as expired', async () => {
    records.findUnique.mockResolvedValue({
      requestHash: hash,
      statusCode: 201,
      response: {},
      expiresAt: now,
    });

    await expect(beginIdempotentRequest('scope', 'key-1', hash, now)).resolves.toEqual({
      kind: 'proceed',
      key: 'scope:key-1',
    });
  });

  it('reports a concurrent duplicate when the unique insert loses the race', async () => {
    records.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }),
    );

    await expect(beginIdempotentRequest('scope', 'key-1', hash, now)).resolves.toEqual({
      kind: 'conflict',
      error: 'idempotency_request_in_progress',
    });
  });

  it('rethrows unexpected database errors', async () => {
    records.create.mockRejectedValue(new Error('connection lost'));

    await expect(beginIdempotentRequest('scope', 'key-1', hash, now)).rejects.toThrow(
      'connection lost',
    );
  });
});

describe('completeIdempotentRequest and abandonIdempotentRequest', () => {
  it('stores the status code and response for the claimed key', async () => {
    await completeIdempotentRequest('scope:key-1', 201, { id: 'abc' });

    expect(records.update).toHaveBeenCalledWith({
      where: { key: 'scope:key-1' },
      data: { statusCode: 201, response: { id: 'abc' } },
    });
  });

  it('stores a null response as JSON null', async () => {
    await completeIdempotentRequest('scope:key-1', 204, undefined);

    expect(records.update).toHaveBeenCalledWith({
      where: { key: 'scope:key-1' },
      data: { statusCode: 204, response: Prisma.JsonNull },
    });
  });

  it('releases only a key that has no stored response', async () => {
    await abandonIdempotentRequest('scope:key-1');

    expect(records.deleteMany).toHaveBeenCalledWith({
      where: { key: 'scope:key-1', statusCode: null },
    });
  });
});
