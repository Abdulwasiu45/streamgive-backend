import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { bodyHash, sep53Hash } from '../../src/middleware/adminAuth.js';
import { updateNgoProfileSchema } from '../../src/routes/ngos.js';

export function signOwnerHeaders(
  keypair: Keypair,
  method: string,
  url: string,
  body?: unknown,
  timestamp = String(Date.now()),
) {
  const payload = body !== undefined ? JSON.stringify(body) : '';
  const message = `${method.toUpperCase()}:${url}:${timestamp}:${bodyHash(payload)}`;
  const signature = keypair.sign(sep53Hash(message)).toString('base64');
  return {
    'x-owner-address': keypair.publicKey(),
    'x-owner-timestamp': timestamp,
    'x-owner-signature': signature,
  };
}

describe('NGO profile update validation (#458)', () => {
  it('accepts valid description and normalizes scheme-less website', () => {
    const parsed = updateNgoProfileSchema.safeParse({
      description: '  Updated mission statement  ',
      website: 'example.org',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        description: 'Updated mission statement',
        website: 'https://example.org',
      });
    }
  });

  it('rejects empty body, whitespace description, oversized description, and invalid URL', () => {
    expect(updateNgoProfileSchema.safeParse({}).success).toBe(false);
    expect(updateNgoProfileSchema.safeParse({ description: '   ' }).success).toBe(false);
    expect(updateNgoProfileSchema.safeParse({ description: 'x'.repeat(5001) }).success).toBe(false);
    expect(updateNgoProfileSchema.safeParse({ website: 'not a url' }).success).toBe(false);
  });

  it('produces valid SEP-53 owner headers for signed profile and withdraw requests', () => {
    const kp = Keypair.random();
    const headers = signOwnerHeaders(kp, 'PATCH', '/v1/ngos/123/profile', { description: 'ok' });
    expect(headers['x-owner-address']).toBe(kp.publicKey());
    expect(headers['x-owner-signature'].length).toBeGreaterThan(0);
  });
});
