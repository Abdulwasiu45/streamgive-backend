import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/notifications/service.js', () => ({ notify: vi.fn() }));

import { prisma } from '../../src/db.js';
import { MAX_APPLICATION_LIST_OFFSET } from '../../src/routes/ngoApplications.js';
import { buildServer } from '../../src/server.js';
import { notify } from '../../src/notifications/service.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { signAdminRequest } from '../helpers/adminAuth.js';
import { sep53Hash } from '../../src/middleware/adminAuth.js';

const adminKeypair = Keypair.random();
const applicationOwnerKeypair = Keypair.random();

function validApplicationPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ownerAddress: applicationOwnerKeypair.publicKey(),
    name: 'Test NGO',
    description: 'A test NGO description.',
    contactEmail: 'ngo@example.com',
    ...overrides,
  };
}

async function signedApplicationPayload(
  app: ReturnType<typeof buildServer>,
  overrides: Partial<Record<string, unknown>> = {},
  signer: Keypair = applicationOwnerKeypair,
) {
  const payload = validApplicationPayload(overrides);
  const challengeResponse = await app.inject({
    method: 'POST',
    url: '/v1/ngo-applications/challenge',
    payload: { ownerAddress: payload.ownerAddress },
  });
  if (challengeResponse.statusCode !== 201) {
    throw new Error(`Failed to issue application challenge: ${challengeResponse.statusCode}`);
  }
  const challengeData = challengeResponse.json() as { challenge: string; message: string };
  const signature = Buffer.from(signer.sign(sep53Hash(challengeData.message))).toString('base64');
  return { ...payload, challenge: challengeData.challenge, signature };
}

describe('POST /v1/ngo-applications', () => {
  const originalResendApiKey = process.env.RESEND_API_KEY;
  const originalEmailFrom = process.env.NOTIFY_EMAIL_FROM;
  const originalApiPublicUrl = process.env.API_PUBLIC_URL;

  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResendApiKey;
    if (originalEmailFrom === undefined) delete process.env.NOTIFY_EMAIL_FROM;
    else process.env.NOTIFY_EMAIL_FROM = originalEmailFrom;
    if (originalApiPublicUrl === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = originalApiPublicUrl;
    vi.mocked(notify).mockClear();
    await resetDb();
  });

  it('creates a pending application', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: await signedApplicationPayload(app),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('PENDING');
    expect(notify).toHaveBeenCalledWith({
      type: 'application_submitted',
      applicationId: response.json().id,
      ownerAddress: response.json().ownerAddress,
      name: response.json().name,
    });

    await app.close();
  });

  it('does not consume the contact email token on GET and verifies only after explicit POST', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.NOTIFY_EMAIL_FROM = 'verify@example.org';
    process.env.API_PUBLIC_URL = 'https://api.example.org';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: await signedApplicationPayload(app),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().emailVerifiedAt).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const email = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { html: string };
    const [, link] = email.html.match(/href="([^"]+)"/) ?? [];
    if (!link) throw new Error('verification link was missing from the email');
    const token = new URL(link).searchParams.get('token');
    if (!token) throw new Error('verification token was missing from the link');
    expect(token).toHaveLength(43);

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/ngo-applications/verify-contact-email?token=${token}`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('text/html');
    expect(preview.body).toContain('method="post"');

    const secondPreview = await app.inject({
      method: 'GET',
      url: `/v1/ngo-applications/verify-contact-email?token=${token}`,
    });
    expect(secondPreview.statusCode).toBe(200);
    expect(
      (await prisma.ngoApplication.findUnique({ where: { id: response.json().id } }))
        ?.emailVerifiedAt,
    ).toBeNull();

    const verified = await app.inject({
      method: 'POST',
      url: `/v1/ngo-applications/verify-contact-email?token=${token}`,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ verified: true });

    const reused = await app.inject({
      method: 'POST',
      url: `/v1/ngo-applications/verify-contact-email?token=${token}`,
    });
    expect(reused.statusCode).toBe(400);
    expect(
      (await prisma.ngoApplication.findUnique({ where: { id: response.json().id } }))
        ?.emailVerifiedAt,
    ).not.toBeNull();

    await app.close();
  });

  it('sends at most one contact verification email within the application cooldown', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.NOTIFY_EMAIL_FROM = 'verify@example.org';
    process.env.API_PUBLIC_URL = 'https://api.example.org';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const app = buildServer();
    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/v1/ngo-applications/${application.id}/contact-email-verification`;

    const first = await app.inject({ method: 'POST', url });
    const second = await app.inject({ method: 'POST', url });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(fetchSpy).toHaveBeenCalledOnce();

    await app.close();
  });

  it('replays the original response for a repeated Idempotency-Key', async () => {
    const app = buildServer();
    const payload = JSON.stringify(await signedApplicationPayload(app));
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/ngo-applications',
        payload,
        headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-123' },
      });

    const first = await send();
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    // The challenge is single-use, so without the key this retry would fail.
    const replay = await send();
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(await prisma.ngoApplication.count()).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('rejects the same Idempotency-Key with a different body', async () => {
    const app = buildServer();
    const body = await signedApplicationPayload(app);
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'same-key' };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: JSON.stringify(body),
      headers,
    });
    expect(first.statusCode).toBe(201);

    const changed = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: JSON.stringify({ ...body, name: 'A Different Name' }),
      headers,
    });
    expect(changed.statusCode).toBe(422);
    expect(changed.json()).toEqual({ error: 'idempotency_key_reused' });
    expect(await prisma.ngoApplication.count()).toBe(1);
  });

  it('rejects a malformed Idempotency-Key', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: await signedApplicationPayload(app),
      headers: { 'idempotency-key': 'x'.repeat(256) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_idempotency_key' });
  });

  it('rejects a signature from another Stellar key', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: await signedApplicationPayload(app, {}, Keypair.random()),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_signature');

    await app.close();
  });

  it('rejects an expired challenge', async () => {
    const app = buildServer();
    const payload = await signedApplicationPayload(app);
    await prisma.ngoApplicationChallenge.update({
      where: { challenge: payload.challenge },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_or_expired_challenge');

    await app.close();
  });

  it('rejects invalid input with 400', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: await signedApplicationPayload(app, { contactEmail: 'not-an-email' }),
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('accepts a scheme-less website domain and normalizes it to https://', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: await signedApplicationPayload(app, { website: 'example.org' }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().website).toBe('https://example.org');

    await app.close();
  });

  it('accepts an already-schemed https website without double-prepending', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: await signedApplicationPayload(app, { website: 'https://example.org' }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().website).toBe('https://example.org');

    await app.close();
  });

  it('rejects a malformed ownerAddress with 400', async () => {
    const app = buildServer();

    const payload = validApplicationPayload({ ownerAddress: 'invalid-stellar-address' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: { ...payload, challenge: '00000000-0000-4000-8000-000000000000', signature: 'invalid' },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('rejects a second pending application from the same address with 409', async () => {
    const app = buildServer();
    const payload = await signedApplicationPayload(app);

    const first = await app.inject({ method: 'POST', url: '/v1/ngo-applications', payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications',
      payload: await signedApplicationPayload(app),
    });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it('rejects a new application from an already-approved NGO with 409 already_approved', async () => {
    const app = buildServer();
    const payload = await signedApplicationPayload(app);

    await prisma.ngoApplication.create({
      data: { ...validApplicationPayload(), status: 'APPROVED' },
    });

    const response = await app.inject({ method: 'POST', url: '/v1/ngo-applications', payload });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('already_approved');

    await app.close();
  });

  it('allows a rejected applicant to submit a new application', async () => {
    const app = buildServer();
    const payload = await signedApplicationPayload(app);

    await prisma.ngoApplication.create({
      data: { ...validApplicationPayload(), status: 'REJECTED' },
    });

    const response = await app.inject({ method: 'POST', url: '/v1/ngo-applications', payload });
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('PENDING');

    await app.close();
  });

  it('lets only one of two concurrent submissions through', async () => {
    const app = buildServer();
    const [firstPayload, secondPayload] = await Promise.all([
      signedApplicationPayload(app),
      signedApplicationPayload(app),
    ]);

    // Fired together rather than awaited in sequence: sequential requests are
    // already covered above, and only a genuine overlap exercises the race
    // where both requests read "nothing blocking" before either inserts.
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/ngo-applications', payload: firstPayload }),
      app.inject({ method: 'POST', url: '/v1/ngo-applications', payload: secondPayload }),
    ]);

    expect([first.statusCode, second.statusCode].sort((a, b) => a - b)).toEqual([201, 409]);

    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json().error).toBe('application_already_pending');

    const stored = await prisma.ngoApplication.findMany({
      where: { ownerAddress: firstPayload.ownerAddress },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('PENDING');

    await app.close();
  });
});

describe('POST /v1/ngo-applications/:id/contact-email-verification', () => {
  const originalResendApiKey = process.env.RESEND_API_KEY;
  const originalEmailFrom = process.env.NOTIFY_EMAIL_FROM;
  const originalApiPublicUrl = process.env.API_PUBLIC_URL;

  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.NOTIFY_EMAIL_FROM = 'verify@example.org';
    process.env.API_PUBLIC_URL = 'https://api.example.org';
  });

  afterEach(async () => {
    if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResendApiKey;
    if (originalEmailFrom === undefined) delete process.env.NOTIFY_EMAIL_FROM;
    else process.env.NOTIFY_EMAIL_FROM = originalEmailFrom;
    if (originalApiPublicUrl === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = originalApiPublicUrl;
    vi.restoreAllMocks();
    await resetDb();
  });

  it('answers 202 and sends nothing when the id is not a valid UUID', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications/not-a-valid-uuid/contact-email-verification',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ message: 'If eligible, a verification email has been sent.' });
    expect(fetchSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 202 and sends nothing when the application does not exist', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const app = buildServer();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ngo-applications/00000000-0000-4000-8000-000000000000/contact-email-verification',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ message: 'If eligible, a verification email has been sent.' });
    expect(fetchSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 202 and sends nothing when the application is already verified', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const app = buildServer();

    const application = await prisma.ngoApplication.create({
      data: {
        ...validApplicationPayload(),
        emailVerifiedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/ngo-applications/${application.id}/contact-email-verification`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ message: 'If eligible, a verification email has been sent.' });
    expect(fetchSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it('answers 202 and sends exactly one email for an eligible unverified application', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const app = buildServer();

    const application = await prisma.ngoApplication.create({
      data: {
        ...validApplicationPayload(),
        emailVerifiedAt: null,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/ngo-applications/${application.id}/contact-email-verification`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ message: 'If eligible, a verification email has been sent.' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const email = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { to: string[] };
    expect(email.to).toEqual([application.contactEmail]);

    await app.close();
  });
});

describe('GET /v1/ngo-applications/status', () => {
  afterEach(async () => {
    vi.mocked(notify).mockClear();
    await resetDb();
  });

  it('returns the review note for the latest reviewed application without exposing submitted details', async () => {
    const app = buildServer();
    const ownerAddress = fakeAddress('S');

    await prisma.ngoApplication.create({
      data: validApplicationPayload({ ownerAddress, status: 'REJECTED' }),
    });
    const latest = await prisma.ngoApplication.create({
      data: validApplicationPayload({
        ownerAddress,
        status: 'REJECTED',
        reviewNote: 'Please provide registration documents.',
      }),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngo-applications/status?ownerAddress=${ownerAddress}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('REJECTED');
    expect(body.createdAt).toBe(latest.createdAt.toISOString());
    expect(body.updatedAt).toBe(latest.updatedAt.toISOString());
    expect(body.reviewNote).toBe('Please provide registration documents.');
    // No contact details or other application fields leak out.
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'reviewNote', 'status', 'updatedAt']);

    await app.close();
  });

  it('returns 404 when the address has no application', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngo-applications/status?ownerAddress=${fakeAddress('N')}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');

    await app.close();
  });

  it('rejects a malformed address with 400', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngo-applications/status?ownerAddress=not-an-address',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    await app.close();
  });

  it('rejects a missing address with 400', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications/status' });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('admin NGO application review', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    vi.mocked(notify).mockClear();
    await resetDb();
  });

  it('rejects an unsigned request with 401', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('returns 503 when admin authentication is not configured', async () => {
    const app = buildServer();
    const configuredAddress = process.env.ADMIN_ADDRESS;
    delete process.env.ADMIN_ADDRESS;

    try {
      const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications' });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe('admin_auth_not_configured');
    } finally {
      if (configuredAddress === undefined) delete process.env.ADMIN_ADDRESS;
      else process.env.ADMIN_ADDRESS = configuredAddress;
      await app.close();
    }
  });

  it('rejects a validly encoded signature with the wrong byte length', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications');
    headers['x-admin-signature'] = Buffer.alloc(63).toString('base64');

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications', headers });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('unauthorized');

    await app.close();
  });

  it('allows a correctly signed admin request', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications');

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications', headers });
    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it('rejects a seconds-based timestamp with a clear unit error', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications', Math.floor(Date.now() / 1000).toString());

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications', headers });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('timestamp_unit_mismatch');

    await app.close();
  });

  it('rejects replaying the same signed request within the freshness window', async () => {
    const app = buildServer();
    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications');

    const first = await app.inject({ method: 'GET', url: '/v1/ngo-applications', headers });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({ method: 'GET', url: '/v1/ngo-applications', headers });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('replayed_signature');

    await app.close();
  });

  it('paginates applications while reporting the full total', async () => {
    const app = buildServer();
    await Promise.all(
      ['A', 'B', 'C'].map((suffix) =>
        prisma.ngoApplication.create({
          data: validApplicationPayload({ ownerAddress: fakeAddress(suffix) }),
        }),
      ),
    );

    const url = '/v1/ngo-applications?limit=2&offset=1';
    const headers = signAdminRequest(adminKeypair, 'GET', url);
    const response = await app.inject({ method: 'GET', url, headers });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.applications).toHaveLength(2);

    await app.close();
  });
  it('approves a pending application', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({
      data: { ...validApplicationPayload(), emailVerifiedAt: new Date() },
    });
    const url = `/v1/ngo-applications/${application.id}/approve`;
    const body = JSON.stringify({});
    const headers = signAdminRequest(adminKeypair, 'POST', url, undefined, body);

    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('APPROVED');
    expect(response.json().reviewedBy).toBe(adminKeypair.publicKey());
    expect(response.json().reviewedAt).toBeTypeOf('string');

    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('APPROVED');
    expect(stored?.reviewedBy).toBe(adminKeypair.publicKey());
    expect(stored?.reviewedAt).toBeInstanceOf(Date);
    expect(notify).toHaveBeenCalledWith({
      type: 'application_reviewed',
      applicationId: application.id,
      ownerAddress: application.ownerAddress,
      status: 'APPROVED',
    });

    await app.close();
  });

  it('notifies when a pending application is rejected', async () => {
    const app = buildServer();
    const application = await prisma.ngoApplication.create({
      data: { ...validApplicationPayload(), emailVerifiedAt: new Date() },
    });
    const url = `/v1/ngo-applications/${application.id}/reject`;
    const body = JSON.stringify({ reviewNote: 'Insufficient documentation' });
    const headers = signAdminRequest(adminKeypair, 'POST', url, undefined, body);

    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { reviewNote: 'Insufficient documentation' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('REJECTED');
    expect(response.json().reviewedBy).toBe(adminKeypair.publicKey());
    expect(response.json().reviewedAt).toBeTypeOf('string');
    expect(notify).toHaveBeenCalledWith({
      type: 'application_reviewed',
      applicationId: application.id,
      ownerAddress: application.ownerAddress,
      status: 'REJECTED',
      reviewNote: 'Insufficient documentation',
    });

    await app.close();
  });

  it('rejects a non-object (array) body on approve with 400 invalid_request', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/v1/ngo-applications/${application.id}/approve`;
    const body = JSON.stringify([]);
    const headers = signAdminRequest(adminKeypair, 'POST', url, undefined, body);

    const response = await app.inject({ method: 'POST', url, headers, payload: [] as never });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    // The invalid request must not have touched the application.
    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('PENDING');

    await app.close();
  });

  it('rejects a non-object (array) body on reject with 400 invalid_request', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const url = `/v1/ngo-applications/${application.id}/reject`;
    const body = JSON.stringify(['not', 'an', 'object']);
    const headers = signAdminRequest(adminKeypair, 'POST', url, undefined, body);

    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: ['not', 'an', 'object'] as never,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');

    const stored = await prisma.ngoApplication.findUnique({ where: { id: application.id } });
    expect(stored?.status).toBe('PENDING');

    await app.close();
  });

  it('rejects a signature for a different URL than the one requested', async () => {
    const app = buildServer();

    const application = await prisma.ngoApplication.create({ data: validApplicationPayload() });
    const realUrl = `/v1/ngo-applications/${application.id}/approve`;
    // Signed for a *different* application's approve endpoint.
    const body = JSON.stringify({});
    const headers = signAdminRequest(adminKeypair, 'POST', '/v1/ngo-applications/other-id/approve', undefined, body);

    const response = await app.inject({ method: 'POST', url: realUrl, headers, payload: {} });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('returns 404 when approving or rejecting a non-existent application id', async () => {
    const app = buildServer();

    const nonExistentId = '00000000-0000-0000-0000-000000000000';
    const approveUrl = `/v1/ngo-applications/${nonExistentId}/approve`;
    const approveBody = JSON.stringify({});
    const approveHeaders = signAdminRequest(adminKeypair, 'POST', approveUrl, undefined, approveBody);

    const approveResponse = await app.inject({
      method: 'POST',
      url: approveUrl,
      headers: approveHeaders,
      payload: {},
    });
    expect(approveResponse.statusCode).toBe(404);
    expect(approveResponse.json().error).toBe('not_found');

    const rejectUrl = `/v1/ngo-applications/${nonExistentId}/reject`;
    const rejectBody = JSON.stringify({});
    const rejectHeaders = signAdminRequest(adminKeypair, 'POST', rejectUrl, undefined, rejectBody);

    const rejectResponse = await app.inject({
      method: 'POST',
      url: rejectUrl,
      headers: rejectHeaders,
      payload: {},
    });
    expect(rejectResponse.statusCode).toBe(404);
    expect(rejectResponse.json().error).toBe('not_found');

    await app.close();
  });
});

describe('GET /v1/ngo-applications/stats', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    vi.mocked(notify).mockClear();
    await resetDb();
  });

  it('rejects an unsigned request with 401', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/ngo-applications/stats' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('returns counts grouped by status for a signed admin', async () => {
    const app = buildServer();

    await prisma.ngoApplication.createMany({
      data: [
        validApplicationPayload({ ownerAddress: fakeAddress('P'), status: 'PENDING' }),
        validApplicationPayload({ ownerAddress: fakeAddress('P'), status: 'PENDING' }),
        validApplicationPayload({ ownerAddress: fakeAddress('A'), status: 'APPROVED' }),
        validApplicationPayload({ ownerAddress: fakeAddress('R'), status: 'REJECTED' }),
      ],
    });

    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications/stats');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngo-applications/stats',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.counts).toEqual({ PENDING: 2, APPROVED: 1, REJECTED: 1 });
    expect(body.total).toBe(4);

    await app.close();
  });

  it('returns zero counts when there are no applications', async () => {
    const app = buildServer();

    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngo-applications/stats');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngo-applications/stats',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.counts).toEqual({ PENDING: 0, APPROVED: 0, REJECTED: 0 });
    expect(body.total).toBe(0);

    await app.close();
  });
});

describe('GET /ngo-applications status filter', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    vi.mocked(notify).mockClear();
    await resetDb();
  });

  /**
   * Seeds two PENDING rows plus one APPROVED and one REJECTED, and returns the
   * row ids grouped by status.
   *
   * Two rows share the PENDING status deliberately. With exactly one row per
   * status, a `status` filter that was silently ignored would still come back
   * with a single row for every query — the per-status assertions below would
   * pass while testing nothing. Two PENDING rows make the filtered count (2)
   * distinct from both the page size (1) and the unfiltered total (4), so
   * dropping the filter anywhere changes a number we actually assert on.
   */
  async function seedMixedStatuses() {
    const [pendingOne, pendingTwo, approved, rejected] = await Promise.all([
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('A'),
          name: 'Pending One',
          status: 'PENDING',
        }),
      }),
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('B'),
          name: 'Pending Two',
          status: 'PENDING',
        }),
      }),
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('C'),
          name: 'Approved One',
          status: 'APPROVED',
        }),
      }),
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('D'),
          name: 'Rejected One',
          status: 'REJECTED',
        }),
      }),
    ]);

    return {
      PENDING: [pendingOne.id, pendingTwo.id].sort(),
      APPROVED: [approved.id],
      REJECTED: [rejected.id],
      all: [pendingOne.id, pendingTwo.id, approved.id, rejected.id].sort(),
    };
  }

  it('returns only the applications matching each status value', async () => {
    const app = buildServer();
    const expected = await seedMixedStatuses();

    for (const status of ['PENDING', 'APPROVED', 'REJECTED'] as const) {
      const url = `/v1/ngo-applications?status=${status}`;
      // The signature covers `${method}:${url}`, query string included, so
      // signing the bare path here would 401 instead of exercising the filter.
      const headers = signAdminRequest(adminKeypair, 'GET', url);

      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Assert the exact expected id set, not merely "no other status leaked
      // in": a filter matching nothing would satisfy the latter, and it is a
      // far easier bug to introduce than an over-broad filter.
      const returnedIds = body.applications
        .map((application: { id: string }) => application.id)
        .sort();
      expect(returnedIds).toEqual(expected[status]);

      // The complement: every returned row actually carries the requested
      // status. This is the acceptance criterion stated directly, so a future
      // refactor to, say, a substring match on `status` fails loudly here.
      for (const application of body.applications as Array<{ status: string }>) {
        expect(application.status).toBe(status);
      }

      // `total` comes from a separate `count` query in the route. It shares
      // the `where` clause with `findMany` today, but nothing enforces that
      // pairing — a filter applied to one and not the other is a classic way
      // for pagination to disagree with itself.
      expect(body.total).toBe(expected[status].length);
    }

    await app.close();
  });

  it('returns every application when no status filter is given', async () => {
    const app = buildServer();
    const expected = await seedMixedStatuses();

    const url = '/v1/ngo-applications';
    const headers = signAdminRequest(adminKeypair, 'GET', url);

    const response = await app.inject({ method: 'GET', url, headers });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // This doubles as a check on the fixture itself. If seeding had quietly
    // produced four rows of one status, the per-status test above could pass
    // without any filtering happening; an unfiltered request that returns all
    // four ids proves the rows really are mixed.
    const returnedIds = body.applications
      .map((application: { id: string }) => application.id)
      .sort();
    expect(returnedIds).toEqual(expected.all);
    expect(body.total).toBe(expected.all.length);

    await app.close();
  });

  it('rejects a status value outside the enum with 400 invalid_request', async () => {
    const app = buildServer();

    // 'pending' is not a typo to tolerate: the column stores uppercase enum
    // values, so accepting it would need a case-insensitive `where`, which is
    // a decision the schema has not made — and silently answering with an
    // empty list would be worse than complaining.
    //
    // The enum is also what keeps an unknown status a clean 400. Passing the
    // raw string through to Prisma instead makes Prisma throw on the invalid
    // enum value, which surfaces to the client as a 500 — so this assertion
    // pins a client-error contract, not just a validation detail.
    for (const status of ['DELETED', 'pending']) {
      const url = `/v1/ngo-applications?status=${status}`;
      const headers = signAdminRequest(adminKeypair, 'GET', url);

      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_request');
    }

    await app.close();
  });

  it('applies limit and offset inside the filtered set while total counts the whole filtered set', async () => {
    const app = buildServer();
    const expected = await seedMixedStatuses();

    const url = '/v1/ngo-applications?status=PENDING&limit=1&offset=1';
    const headers = signAdminRequest(adminKeypair, 'GET', url);

    const response = await app.inject({ method: 'GET', url, headers });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // One row, drawn from the two PENDING rows — not from the four-row table.
    // If `offset` paginated the unfiltered result set, the single row returned
    // here could be a non-PENDING row; the `total` assertion below is what
    // makes that failure deterministic rather than order-dependent.
    expect(body.applications).toHaveLength(1);
    expect(body.applications[0].status).toBe('PENDING');
    expect(expected.PENDING).toContain(body.applications[0].id);

    // `total` describes the filtered set, so it stays 2 even though only one
    // row is on this page. A client paging through PENDING applications needs
    // 2 here to know a second page exists.
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);

    await app.close();
  });
});

describe('GET /ngo-applications search and date filters', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    vi.mocked(notify).mockClear();
    await resetDb();
  });

  async function seedFilterableApplications() {
    const [alpha, beta, gamma] = await Promise.all([
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('A'),
          name: 'Alpha Aid',
          contactEmail: 'alpha@example.org',
          status: 'PENDING',
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
        }),
      }),
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('B'),
          name: 'Beta Relief',
          contactEmail: 'beta@example.org',
          status: 'APPROVED',
          createdAt: new Date('2024-02-01T00:00:00.000Z'),
        }),
      }),
      prisma.ngoApplication.create({
        data: validApplicationPayload({
          ownerAddress: fakeAddress('C'),
          name: 'Gamma Trust',
          contactEmail: 'gamma@example.org',
          status: 'PENDING',
          createdAt: new Date('2024-03-01T00:00:00.000Z'),
        }),
      }),
    ]);

    return { alpha, beta, gamma };
  }

  async function list(query: string) {
    const app = buildServer();
    const url = `/v1/ngo-applications?${query}`;
    const headers = signAdminRequest(adminKeypair, 'GET', url);
    const response = await app.inject({ method: 'GET', url, headers });
    await app.close();
    return response;
  }

  it('searches names and contact emails case-insensitively', async () => {
    const { alpha, beta } = await seedFilterableApplications();

    const byName = await list('search=alpha');
    expect(byName.statusCode).toBe(200);
    expect(byName.json().applications.map((application: { id: string }) => application.id)).toEqual(
      [alpha.id],
    );
    expect(byName.json().total).toBe(1);

    const byEmail = await list('search=BETA%40EXAMPLE');
    expect(byEmail.statusCode).toBe(200);
    expect(byEmail.json().applications.map((application: { id: string }) => application.id)).toEqual(
      [beta.id],
    );

    const noMatch = await list('search=gamma&status=APPROVED');
    expect(noMatch.statusCode).toBe(200);
    expect(noMatch.json().applications).toEqual([]);
    expect(noMatch.json().total).toBe(0);
  });

  it('combines the search with the status filter', async () => {
    const { alpha, beta, gamma } = await seedFilterableApplications();

    const pending = await list('search=%40example&status=PENDING');
    expect(pending.statusCode).toBe(200);
    expect(
      pending.json().applications.map((application: { id: string }) => application.id).sort(),
    ).toEqual([alpha.id, gamma.id].sort());

    const approved = await list('search=%40example&status=APPROVED');
    expect(approved.statusCode).toBe(200);
    expect(
      approved.json().applications.map((application: { id: string }) => application.id),
    ).toEqual([beta.id]);
  });

  it('filters by inclusive submission date bounds combined with status', async () => {
    const { alpha, beta, gamma } = await seedFilterableApplications();

    const after = await list(
      `submittedAfter=${encodeURIComponent('2024-02-01T00:00:00.000Z')}&status=APPROVED`,
    );
    expect(after.statusCode).toBe(200);
    expect(after.json().applications.map((application: { id: string }) => application.id)).toEqual([
      beta.id,
    ]);

    const before = await list(
      `submittedBefore=${encodeURIComponent('2024-01-31T23:59:59.999Z')}&status=PENDING`,
    );
    expect(before.statusCode).toBe(200);
    expect(
      before.json().applications.map((application: { id: string }) => application.id),
    ).toEqual([alpha.id]);

    const between = await list(
      `submittedAfter=${encodeURIComponent('2024-01-15T00:00:00.000Z')}&submittedBefore=${encodeURIComponent('2024-03-15T00:00:00.000Z')}&status=PENDING`,
    );
    expect(between.statusCode).toBe(200);
    expect(
      between.json().applications.map((application: { id: string }) => application.id),
    ).toEqual([gamma.id]);
  });

  it('rejects an invalid submission date with 400 invalid_request', async () => {
    const response = await list('submittedAfter=not-a-date');

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });
});

describe('GET /v1/ngo-applications offset bound and stable paging', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(notify).mockClear();
    await resetDb();
  });

  async function list(app: ReturnType<typeof buildServer>, query: string) {
    const url = `/v1/ngo-applications?${query}`;
    const headers = signAdminRequest(adminKeypair, 'GET', url);
    return app.inject({ method: 'GET', url, headers });
  }

  it('accepts offset 0', async () => {
    const app = buildServer();

    const response = await list(app, 'offset=0');

    expect(response.statusCode).toBe(200);
    expect(response.json().offset).toBe(0);

    await app.close();
  });

  it('accepts the maximum offset and returns an empty page past the end', async () => {
    const app = buildServer();
    await prisma.ngoApplication.create({ data: validApplicationPayload() });

    const response = await list(app, `offset=${MAX_APPLICATION_LIST_OFFSET}`);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.offset).toBe(MAX_APPLICATION_LIST_OFFSET);
    expect(body.applications).toEqual([]);
    expect(body.total).toBe(1);

    await app.close();
  });

  it('rejects an offset one above the maximum with 400', async () => {
    const app = buildServer();

    const response = await list(app, `offset=${MAX_APPLICATION_LIST_OFFSET + 1}`);

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
    expect(body.details.fieldErrors.offset).toBeDefined();

    await app.close();
  });

  it('rejects very large and negative offsets with 400', async () => {
    const app = buildServer();

    for (const offset of ['2147483648', '9007199254740991', '1e12', '-1']) {
      const response = await list(app, `offset=${offset}`);

      expect(response.statusCode, `offset=${offset}`).toBe(400);
      expect(response.json().error).toBe('invalid_request');
    }

    await app.close();
  });

  it('does not query the database for a rejected offset', async () => {
    const app = buildServer();
    const findMany = vi.spyOn(prisma.ngoApplication, 'findMany');
    const count = vi.spyOn(prisma.ngoApplication, 'count');

    const response = await list(app, `offset=${MAX_APPLICATION_LIST_OFFSET + 1}`);

    expect(response.statusCode).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();

    await app.close();
  });

  it('breaks createdAt ties by id so offset pages never repeat or skip a row', async () => {
    const app = buildServer();
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((suffix) =>
        prisma.ngoApplication.create({
          data: validApplicationPayload({
            ownerAddress: fakeAddress(suffix),
            createdAt: sameInstant,
          }),
        }),
      ),
    );

    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const response = await list(app, `limit=2&offset=${offset}`);
      expect(response.statusCode).toBe(200);
      for (const row of response.json().applications) seen.push(row.id);
    }

    // Every row exactly once, in a fixed order: id descending.
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort().reverse());

    // The same pages requested again return the same rows in the same order.
    const again: string[] = [];
    for (const offset of [0, 2, 4]) {
      const response = await list(app, `limit=2&offset=${offset}`);
      for (const row of response.json().applications) again.push(row.id);
    }
    expect(again).toEqual(seen);

    await app.close();
  });

  it('still lists newer applications before older ones', async () => {
    const app = buildServer();
    const older = await prisma.ngoApplication.create({
      data: validApplicationPayload({
        ownerAddress: fakeAddress('A'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    });
    const newer = await prisma.ngoApplication.create({
      data: validApplicationPayload({
        ownerAddress: fakeAddress('B'),
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    });

    const response = await list(app, 'limit=2');

    expect(response.json().applications.map((a: { id: string }) => a.id)).toEqual([
      newer.id,
      older.id,
    ]);

    await app.close();
  });
});
