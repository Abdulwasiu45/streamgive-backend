import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { bodyHash, sep53Hash } from '../../src/middleware/adminAuth.js';
import { requireOwnerSignature } from '../../src/middleware/ownerAuth.js';

const URL = '/v1/ngos/11111111-1111-4111-8111-111111111111/profile';
const BODY = { description: 'We feed people.' };

type Headers = Record<string, string | undefined>;

// Each signature gets its own timestamp, so no test trips the replay check of another.
const baseTime = Date.now();
let tick = 0;
const nextTimestamp = () => String(baseTime + tick++);

/** Signs `${METHOD}:${url}:${timestamp}:${bodyHash(body)}` the way a wallet would. */
function sign(
  keypair: Keypair,
  { method = 'PATCH', url = URL, timestamp = nextTimestamp(), body = JSON.stringify(BODY) } = {},
  encoding: 'base64' | 'hex' = 'base64',
): Headers {
  const message = `${method}:${url}:${timestamp}:${bodyHash(body)}`;
  return {
    'x-owner-address': keypair.publicKey(),
    'x-owner-timestamp': timestamp,
    'x-owner-signature': Buffer.from(keypair.sign(sep53Hash(message))).toString(encoding),
  };
}

/** Runs the middleware against a minimal request/reply and returns what it answered, if anything. */
async function check(headers: Headers, overrides: { body?: unknown; rawBody?: Buffer | string } = {}) {
  const reply = {
    statusCode: undefined as number | undefined,
    payload: undefined as unknown,
    code(status: number) {
      this.statusCode = status;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  const request = { headers, method: 'PATCH', url: URL, body: BODY, ...overrides };
  await requireOwnerSignature(request as never, reply as never);
  return { status: reply.statusCode, body: reply.payload };
}

describe('requireOwnerSignature', () => {
  const owner = Keypair.random();

  it('accepts a valid signature and answers nothing', async () => {
    expect(await check(sign(owner))).toEqual({ status: undefined, body: undefined });
  });

  it('rejects a request with a missing owner header', async () => {
    for (const header of ['x-owner-address', 'x-owner-timestamp', 'x-owner-signature']) {
      const headers = sign(owner);
      delete headers[header];
      expect(await check(headers), header).toEqual({ status: 401, body: { error: 'unauthorized' } });
    }
  });

  it('rejects an address that is not a Stellar public key', async () => {
    const headers = { ...sign(owner), 'x-owner-address': 'not-a-stellar-address' };
    expect(await check(headers)).toEqual({ status: 401, body: { error: 'invalid_owner_address' } });
  });

  it('rejects a non-integer timestamp', async () => {
    for (const timestamp of ['abc', '1.5']) {
      expect(await check(sign(owner, { timestamp })), timestamp).toEqual({
        status: 401,
        body: { error: 'invalid_timestamp' },
      });
    }
  });

  it('rejects a timestamp in seconds instead of milliseconds', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(await check(sign(owner, { timestamp }))).toEqual({
      status: 401,
      body: { error: 'timestamp_in_seconds' },
    });
  });

  it('rejects a stale or future timestamp outside the five minute window', async () => {
    for (const offset of [-6 * 60 * 1000, 6 * 60 * 1000]) {
      const timestamp = String(Date.now() + offset);
      expect(await check(sign(owner, { timestamp })), String(offset)).toEqual({
        status: 401,
        body: { error: 'stale_timestamp' },
      });
    }
  });

  it('rejects a signature made with a different key than the claimed owner', async () => {
    const headers = { ...sign(Keypair.random()), 'x-owner-address': owner.publicKey() };
    expect(await check(headers)).toEqual({ status: 401, body: { error: 'invalid_signature' } });
  });

  it('rejects a tampered body, url or method', async () => {
    const headers = sign(owner);
    expect(await check(headers, { body: { description: 'tampered' } })).toMatchObject({ status: 401 });
    expect(await check(sign(owner, { url: '/v1/ngos/other/profile' }))).toEqual({
      status: 401,
      body: { error: 'invalid_signature' },
    });
    expect(await check(sign(owner, { method: 'POST' }))).toEqual({
      status: 401,
      body: { error: 'invalid_signature' },
    });
  });

  it('verifies the raw body when one is present', async () => {
    const rawBody = '{"description":"raw  spacing"}';
    expect(await check(sign(owner, { body: rawBody }), { rawBody })).toEqual({
      status: undefined,
      body: undefined,
    });
    expect(await check(sign(owner, { body: rawBody }), { rawBody: Buffer.from(rawBody) })).toEqual({
      status: undefined,
      body: undefined,
    });
  });

  it('rejects a replayed signature', async () => {
    const headers = sign(owner);

    expect(await check(headers)).toEqual({ status: undefined, body: undefined });
    expect(await check(headers)).toEqual({ status: 401, body: { error: 'replayed_signature' } });
  });

  it('accepts base64 and hex encoded signatures', async () => {
    const base64 = sign(owner, {}, 'base64');
    const hex = sign(owner, {}, 'hex');

    expect(await check(base64)).toEqual({ status: undefined, body: undefined });
    expect(await check(hex)).toEqual({ status: undefined, body: undefined });
  });
});
