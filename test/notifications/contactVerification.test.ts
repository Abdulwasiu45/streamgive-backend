import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { sendContactVerification } from '../../src/notifications/contactVerification.js';
import { resetDb } from '../helpers/db.js';

const RESEND_URL = 'https://api.resend.com/emails';

const application = {
  id: '',
  name: 'Test NGO',
  contactEmail: 'ngo@example.com',
};

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb();

  // Create a real NgoApplication row so the cooldown update can find it.
  const row = await prisma.ngoApplication.create({
    data: {
      ownerAddress: 'G' + 'A'.repeat(55),
      name: application.name,
      description: 'desc',
      contactEmail: application.contactEmail,
    },
  });
  application.id = row.id;

  // Minimal env required for the function to proceed.
  process.env.RESEND_API_KEY = 'test-api-key';
  process.env.NOTIFY_EMAIL_FROM = 'noreply@example.com';
  process.env.API_PUBLIC_URL = 'https://api.example.com';
  delete process.env.VERIFY_EMAIL_TIMEOUT_MS;
});

afterEach(async () => {
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_EMAIL_FROM;
  delete process.env.API_PUBLIC_URL;
  delete process.env.VERIFY_EMAIL_TIMEOUT_MS;
  await resetDb();
});

describe('sendContactVerification', () => {
  it('returns false and skips fetch when env vars are not configured', async () => {
    delete process.env.RESEND_API_KEY;
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await sendContactVerification(application);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('POSTs to the Resend API with the correct headers and body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    const result = await sendContactVerification(application);

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_URL);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-api-key');
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual([application.contactEmail]);
  });

  it('attaches an AbortSignal to the fetch request', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await sendContactVerification(application);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a fetch that never resolves within the configured timeout', async () => {
    process.env.VERIFY_EMAIL_TIMEOUT_MS = '10';
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('expected an abort signal on the fetch request'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    // The function must resolve (not throw) even when fetch never responds.
    const result = await sendContactVerification(application);

    expect(result).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // Signal must have fired — the timeout elapsed.
    expect(init.signal?.aborted).toBe(true);
  });

  it('returns false and logs when the provider returns a non-2xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 422 }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendContactVerification(application);

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('respects the resend cooldown — skips when sent recently', async () => {
    // Mark as sent just now.
    await prisma.ngoApplication.update({
      where: { id: application.id },
      data: { lastContactVerificationSentAt: new Date() },
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    const result = await sendContactVerification(application);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
