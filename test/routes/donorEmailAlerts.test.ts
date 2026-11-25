import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { bodyHash, sep53Hash } from '../../src/middleware/adminAuth.js';
import { _resetDeliveredEventIdsForTest, notify } from '../../src/notifications/service.js';
import { buildServer } from '../../src/server.js';
import { resetDb } from '../helpers/db.js';

const donorKey = Keypair.random();
const donorAddress = donorKey.publicKey();
const ENV_KEYS = [
  'RESEND_API_KEY',
  'NOTIFY_EMAIL_FROM',
  'API_PUBLIC_URL',
  'NOTIFY_WEBHOOK_URL',
  'RATE_LIMIT_APPLICATION_MAX',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const URL = `/v1/donors/${donorAddress}/email-alerts`;

let offset = 0;
function signed(keypair: Keypair, url: string, body: string) {
  const timestamp = String(Date.now() + offset++);
  const message = `POST:${url}:${timestamp}:${bodyHash(body)}`;
  return {
    'content-type': 'application/json',
    'x-owner-address': keypair.publicKey(),
    'x-owner-timestamp': timestamp,
    'x-owner-signature': Buffer.from(keypair.sign(sep53Hash(message))).toString('base64'),
  };
}

describe('donor email alerts', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.NOTIFY_EMAIL_FROM = 'StreamGive <no-reply@streamgive.test>';
    process.env.API_PUBLIC_URL = 'https://api.streamgive.test';
    delete process.env.NOTIFY_WEBHOOK_URL;
    // The registration routes are rate limited; these tests make several requests per server.
    process.env.RATE_LIMIT_APPLICATION_MAX = '100';
    _resetDeliveredEventIdsForTest();
    await resetDb();
    await prisma.donorEmailAlert.deleteMany();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.donorEmailAlert.deleteMany();
    await resetDb();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  const sentEmail = (call = 0) => JSON.parse((fetchSpy.mock.calls[call][1] as { body: string }).body) as {
    to: string[];
    subject: string;
    html: string;
    text: string;
    headers?: Record<string, string>;
  };

  async function register(app: ReturnType<typeof buildServer>, email = 'Donor@Example.com') {
    const body = JSON.stringify({ email });
    return app.inject({ method: 'POST', url: URL, payload: body, headers: signed(donorKey, URL, body) });
  }

  it('registers a signed request, emails a confirmation link and alerts nobody yet', async () => {
    const app = buildServer();

    const response = await register(app);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'verification_sent' });
    const row = await prisma.donorEmailAlert.findFirstOrThrow({ where: { donorAddress } });
    expect(row).toMatchObject({ email: 'donor@example.com', verifiedAt: null });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const email = sentEmail();
    expect(email.to).toEqual(['donor@example.com']);
    expect(email.html).toContain('https://api.streamgive.test/v1/donor-email-alerts/verify?token=');
    expect(email.html).toContain(`/v1/donor-email-alerts/unsubscribe?token=${row.unsubscribeToken}`);

    await app.close();
  });

  it('sends no second email inside the cooldown, and rejects bad requests', async () => {
    const app = buildServer();
    await register(app);

    expect((await register(app)).statusCode).toBe(202);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const stranger = Keypair.random();
    const body = JSON.stringify({ email: 'x@example.com' });
    const wrongSigner = await app.inject({ method: 'POST', url: URL, payload: body, headers: signed(stranger, URL, body) });
    expect(wrongSigner.statusCode).toBe(403);
    const unsigned = await app.inject({ method: 'POST', url: URL, payload: body, headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(401);
    expect((await register(app, 'not-an-email')).statusCode).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('answers 503 when email is not configured', async () => {
    delete process.env.RESEND_API_KEY;
    const app = buildServer();

    expect((await register(app)).statusCode).toBe(503);
    expect(await prisma.donorEmailAlert.count()).toBe(0);

    await app.close();
  });

  it('verifies only on the confirmed POST, once, and not after expiry', async () => {
    const app = buildServer();
    await register(app);
    const token = /verify\?token=([A-Za-z0-9_-]+)/.exec(sentEmail().html)![1];
    const verifyUrl = `/v1/donor-email-alerts/verify?token=${token}`;

    const page = await app.inject({ method: 'GET', url: verifyUrl });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect((await prisma.donorEmailAlert.findFirstOrThrow()).verifiedAt).toBeNull();

    const confirmed = await app.inject({ method: 'POST', url: verifyUrl });
    expect(confirmed.json()).toEqual({ verified: true });
    expect((await prisma.donorEmailAlert.findFirstOrThrow()).verifiedAt).not.toBeNull();
    expect((await app.inject({ method: 'POST', url: verifyUrl })).statusCode).toBe(400);

    await prisma.donorEmailAlert.deleteMany();
    await register(app, 'second@example.com');
    const second = /verify\?token=([A-Za-z0-9_-]+)/.exec(sentEmail(1).html)![1];
    await prisma.donorEmailAlert.updateMany({ data: { verificationExpiresAt: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: 'POST', url: `/v1/donor-email-alerts/verify?token=${second}` })).statusCode).toBe(400);

    await app.close();
  });

  describe('alerts', () => {
    async function seedStream() {
      const donor = await prisma.donor.create({ data: { address: donorAddress } });
      const ngo = await prisma.ngo.create({
        data: { ownerAddress: Keypair.random().publicKey(), name: 'Helping Hands', verified: true },
      });
      await prisma.stream.create({
        data: {
          onChainId: 5n,
          donorId: donor.id,
          ngoId: ngo.id,
          tokenAddress: Keypair.random().publicKey(),
          rate: '777',
          balance: '123456',
          withdrawn: '0',
        },
      });
      const verified = await prisma.donorEmailAlert.create({
        data: { donorAddress, email: 'verified@example.com', verifiedAt: new Date(), unsubscribeToken: 'unsub-verified-token-0001' },
      });
      await prisma.donorEmailAlert.create({
        data: { donorAddress, email: 'pending@example.com', unsubscribeToken: 'unsub-pending-token-00001' },
      });
      await prisma.donorEmailAlert.create({
        data: {
          donorAddress: Keypair.random().publicKey(),
          email: 'other@example.com',
          verifiedAt: new Date(),
          unsubscribeToken: 'unsub-other-token-000001',
        },
      });
      return { verified, ngoId: ngo.id };
    }

    it('emails only the verified addresses of the stream donor, with a summary and an unsubscribe link', async () => {
      const { verified, ngoId } = await seedStream();

      await notify({ type: 'stream_created', streamId: '5', donorAddress, ngoId, eventId: '0000000100-0000000001' });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const email = sentEmail();
      expect(email.to).toEqual(['verified@example.com']);
      expect(email.subject).toBe('StreamGive: stream #5 was created');
      expect(email.html).toContain('Your stream #5 to Helping Hands was created.');
      expect(email.html).toContain(`/v1/donor-email-alerts/unsubscribe?token=${verified.unsubscribeToken}`);
      expect(email.headers?.['List-Unsubscribe']).toContain(verified.unsubscribeToken);
      for (const secret of ['777', '123456', donorAddress]) {
        expect(email.html).not.toContain(secret);
        expect(email.text).not.toContain(secret);
      }

      fetchSpy.mockClear();
      await notify({ type: 'stream_cancelled', streamId: '5', settledToNgo: '1', refundToDonor: '2', eventId: '0000000101-0000000001' });
      expect(sentEmail().subject).toBe('StreamGive: stream #5 has ended');
    });

    it('sends nothing for other events or unknown streams', async () => {
      await seedStream();

      await notify({ type: 'stream_withdrawn', streamId: '5', amount: '1', eventId: '0000000102-0000000001' });
      await notify({ type: 'stream_created', streamId: '404', donorAddress, ngoId: 'x', eventId: '0000000103-0000000001' });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('unsubscribes with one click by GET or POST, repeatedly, and then sends nothing', async () => {
      const { verified, ngoId } = await seedStream();
      const app = buildServer();
      const url = `/v1/donor-email-alerts/unsubscribe?token=${verified.unsubscribeToken}`;

      const first = await app.inject({ method: 'GET', url });
      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('no longer get StreamGive stream alerts');
      expect(await prisma.donorEmailAlert.count({ where: { email: 'verified@example.com' } })).toBe(0);
      expect((await app.inject({ method: 'POST', url })).json()).toEqual({ unsubscribed: true });
      expect((await app.inject({ method: 'GET', url: '/v1/donor-email-alerts/unsubscribe?token=short' })).statusCode).toBe(400);

      await notify({ type: 'stream_created', streamId: '5', donorAddress, ngoId, eventId: '0000000104-0000000001' });
      expect(fetchSpy).not.toHaveBeenCalled();

      await app.close();
    });
  });
});
