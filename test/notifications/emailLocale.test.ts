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
import {
  SUPPORTED_EMAIL_LOCALES,
  contactVerificationEmail,
  resolveEmailLocale,
} from '../../src/notifications/emailTemplates.js';
import { applicationSchema } from '../../src/routes/ngoApplications/shared.js';

const URL = 'https://api.streamgive.test/v1/ngo-applications/verify-contact-email?token=abc';

describe('resolveEmailLocale', () => {
  it('maps supported tags and regional variants to their language', () => {
    expect(resolveEmailLocale('es')).toBe('es');
    expect(resolveEmailLocale('es-MX')).toBe('es');
    expect(resolveEmailLocale('PT_br')).toBe('pt');
    expect(resolveEmailLocale(' fr ')).toBe('fr');
  });

  it('falls back to English for an unsupported, malformed or missing locale', () => {
    for (const locale of ['xx', 'de-DE', 'zh-Hans', '???', '', null, undefined]) {
      expect(resolveEmailLocale(locale), String(locale)).toBe('en');
    }
  });
});

describe('contactVerificationEmail', () => {
  it('keeps the English wording and markup when no locale is given', () => {
    expect(contactVerificationEmail(undefined, 'Test NGO', URL)).toEqual({
      subject: 'Verify your StreamGive NGO contact email',
      html: `<p>Hello Test NGO,</p><p><a href="${URL}">Verify this contact email</a>. This link expires in 24 hours.</p>`,
      text: `Hello Test NGO,\n\nVerify this contact email: ${URL}\n\nThis link expires in 24 hours.`,
    });
  });

  it('uses the Spanish template for a supported locale', () => {
    const email = contactVerificationEmail('es-MX', 'Test ONG', URL);

    expect(email.subject).toBe('Verifica el correo de contacto de tu ONG en StreamGive');
    expect(email.html).toContain('Hola Test ONG,');
    expect(email.html).toContain('Verificar este correo de contacto');
    expect(email.html).toContain(`href="${URL}"`);
    expect(email.text).toContain('Hola Test ONG,');
  });

  it('uses the English template for an unsupported locale', () => {
    expect(contactVerificationEmail('xx', 'Test NGO', URL)).toEqual(
      contactVerificationEmail('en', 'Test NGO', URL),
    );
  });

  it('escapes the NGO name in every template', () => {
    const name = `<img src=x onerror="alert('x')"> & Co`;
    for (const locale of SUPPORTED_EMAIL_LOCALES) {
      const { html } = contactVerificationEmail(locale, name, URL);
      expect(html, locale).toContain('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; Co');
      expect(html, locale).not.toContain('<img');
    }
  });
});

describe('applicationSchema locale', () => {
  const base = {
    ownerAddress: 'G' + 'A'.repeat(55),
    name: 'Test NGO',
    description: 'A description.',
    contactEmail: 'ngo@example.com',
  };

  it('accepts an optional well-formed locale and rejects a malformed one', () => {
    expect(applicationSchema.safeParse(base).success).toBe(true);
    for (const locale of ['es', 'pt-BR', 'zh-Hans-CN', 'xx']) {
      expect(applicationSchema.safeParse({ ...base, locale }).success, locale).toBe(true);
    }
    for (const locale of ['', 'e', 'english!', 'es;drop', 'x'.repeat(40)]) {
      expect(applicationSchema.safeParse({ ...base, locale }).success, locale).toBe(false);
    }
  });
});

describe('sendContactVerification locale', () => {
  const updateMany = prisma.ngoApplication.updateMany as unknown as Mock;
  const upsert = prisma.ngoApplicationContactChallenge.upsert as unknown as Mock;
  const fetchMock = vi.fn();
  const ENV_KEYS = ['RESEND_API_KEY', 'NOTIFY_EMAIL_FROM', 'API_PUBLIC_URL'] as const;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

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

  const sent = async (locale: string | null | undefined) => {
    fetchMock.mockClear();
    await sendContactVerification({ id: 'app-1', name: 'Test NGO', contactEmail: 'ngo@example.com', locale });
    return JSON.parse(fetchMock.mock.calls[0][1].body as string) as { subject: string; html: string };
  };

  it('sends the subject and body in a supported locale and in English for an unsupported one', async () => {
    const french = await sent('fr');
    expect(french.subject).toBe("Vérifiez l'adresse e-mail de contact de votre ONG sur StreamGive");
    expect(french.html).toContain('Bonjour Test NGO,');

    for (const locale of ['xx', null, undefined]) {
      const fallback = await sent(locale);
      expect(fallback.subject, String(locale)).toBe('Verify your StreamGive NGO contact email');
      expect(fallback.html, String(locale)).toContain('Hello Test NGO,');
    }
  });
});
