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
import { sendContactVerification } from '../../src/notifications/contactVerification.js';

const updateMany = prisma.ngoApplication.updateMany as unknown as Mock;
const upsert = prisma.ngoApplicationContactChallenge.upsert as unknown as Mock;

const ENV_KEYS = ['RESEND_API_KEY', 'NOTIFY_EMAIL_FROM', 'API_PUBLIC_URL'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe('verification email text part', () => {
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

  const send = async (name = 'Test NGO') => {
    await expect(
      sendContactVerification({ id: 'app-1', name, contactEmail: 'ngo@example.com' }),
    ).resolves.toBe(true);
    return JSON.parse(fetchMock.mock.calls[0][1].body as string) as { html: string; text: string };
  };

  it('sends a text body next to the html body', async () => {
    const { html, text } = await send();

    expect(typeof html).toBe('string');
    expect(text).toBe(
      `Hello Test NGO,\n\nVerify this contact email: ${/href="([^"]+)"/.exec(html)![1]}\n\nThis link expires in 24 hours.`,
    );
  });

  it('puts the same verification URL, with the same token, in both parts', async () => {
    const { html, text } = await send();

    const htmlUrl = /href="([^"]+)"/.exec(html)![1];
    const textUrl = /https:\/\/\S+/.exec(text)![0];
    expect(textUrl).toBe(htmlUrl);
    expect(new URL(textUrl).pathname).toBe('/v1/ngo-applications/verify-contact-email');
    expect(new URL(textUrl).searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps markup out of the text part and flattens line breaks in the NGO name', async () => {
    const { text } = await send('Line one\r\nLine two');

    expect(text.startsWith('Hello Line one Line two,\n\n')).toBe(true);
    expect(text).not.toContain('<');
  });
});
