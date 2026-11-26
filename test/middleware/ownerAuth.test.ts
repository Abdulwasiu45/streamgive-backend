import { Keypair } from '@stellar/stellar-sdk';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bodyHash, sep53Hash } from '../../src/middleware/adminAuth.js';
import { requireOwnerSignature } from '../../src/middleware/ownerAuth.js';

describe('requireOwnerSignature replay cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not scan more cached signatures as the replay cache grows', async () => {
    const app = Fastify({ logger: false });
    app.get('/signed/:id', { preHandler: requireOwnerSignature }, async () => ({ ok: true }));

    const keypair = Keypair.random();
    let requestNumber = 0;
    async function sendSignedRequest() {
      const url = `/signed/${requestNumber}`;
      const timestamp = String(Date.now() + requestNumber);
      const payload = `GET:${url}:${timestamp}:${bodyHash('')}`;
      const signature = Buffer.from(keypair.sign(sep53Hash(payload))).toString('base64');
      requestNumber += 1;
      return app.inject({
        method: 'GET',
        url,
        headers: {
          'x-owner-address': keypair.publicKey(),
          'x-owner-timestamp': timestamp,
          'x-owner-signature': signature,
        },
      });
    }

    const originalIterator = Map.prototype[Symbol.iterator];
    let visitedEntries = 0;
    const iteratorSpy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>,
    ) {
      visitedEntries += this.size;
      return originalIterator.call(this);
    });

    try {
      expect((await sendSignedRequest()).statusCode).toBe(200);
      visitedEntries = 0;
      expect((await sendSignedRequest()).statusCode).toBe(200);
      const smallCacheCost = visitedEntries;

      for (let i = 0; i < 100; i += 1) {
        expect((await sendSignedRequest()).statusCode).toBe(200);
      }

      visitedEntries = 0;
      expect((await sendSignedRequest()).statusCode).toBe(200);
      expect(visitedEntries).toBe(smallCacheCost);
    } finally {
      iteratorSpy.mockRestore();
      await app.close();
    }
  });
});
