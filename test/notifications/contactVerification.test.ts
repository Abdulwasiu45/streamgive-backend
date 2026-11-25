import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    ngoApplication: { updateMany: vi.fn() },
    ngoApplicationContactChallenge: { upsert: vi.fn() },
  },
}));
vi.mock('../../src/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { sendContactVerification } from '../../src/notifications/contactVerification.js';

const updateMany = prisma.ngoApplication.updateMany as unknown as Mock;
const upsert = prisma.ngoApplicationContactChallenge.upsert as unknown as Mock;
const application = { id: 'app-1', name: 'Test NGO', contactEmail: 'ngo@example.com' };

const ENV_KEYS = ['RESEND_API_KEY', 'NOTIFY_EMAIL_FROM', 'API_PUBLIC_URL'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe('sendContactVerification', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.NOTIFY_EMAIL_FROM = 'StreamGive <no-reply@streamgive.test>';
    process.env.API_PUBLIC_URL = 'https://api.streamgive.test';
    updateMany.mockResolvedValue({ count: 1 });
    upsert.mockResolvedValue({});
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it('sends the email through the provider and returns true on success', async () => {
    await expect(sendContactVerification(application)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer re_test_key');
    const body = sentBody();
    expect(body.to).toEqual(['ngo@example.com']);
    expect(body.subject).toBe('Verify your StreamGive NGO contact email');
    expect(body.html).toContain('https://api.streamgive.test/v1/ngo-applications/verify-contact-email?token=');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('returns false and logs when the provider rejects the email', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 422 }));

    await expect(sendContactVerification(application)).resolves.toBe(false);

    expect(logger.error).toHaveBeenCalledWith(
      { status: 422 },
      'contact verification email was rejected',
    );
  });

  it('returns false when the request to the provider fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(sendContactVerification(application)).resolves.toBe(false);

    expect(logger.error).toHaveBeenCalled();
  });

  it('sends nothing when the provider is not configured', async () => {
    delete process.env.RESEND_API_KEY;

    await expect(sendContactVerification(application)).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('contact email verification is not configured');
  });

  it('stops a second send inside the cooldown window', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(sendContactVerification(application)).resolves.toBe(true);
    await expect(sendContactVerification(application)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    const where = updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'app-1', emailVerifiedAt: null });
    expect(where.OR).toHaveLength(2);
  });
});
