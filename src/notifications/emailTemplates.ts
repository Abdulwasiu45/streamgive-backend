const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for use in HTML element content and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ENTITIES[character]);
}

export const SUPPORTED_EMAIL_LOCALES = ['en', 'es', 'fr', 'pt'] as const;
export type EmailLocale = (typeof SUPPORTED_EMAIL_LOCALES)[number];

interface ContactVerificationTemplate {
  subject: string;
  greeting: (name: string) => string;
  linkLabel: string;
  expiry: string;
}

const CONTACT_VERIFICATION: Record<EmailLocale, ContactVerificationTemplate> = {
  en: {
    subject: 'Verify your StreamGive NGO contact email',
    greeting: (name) => `Hello ${name},`,
    linkLabel: 'Verify this contact email',
    expiry: 'This link expires in 24 hours.',
  },
  es: {
    subject: 'Verifica el correo de contacto de tu ONG en StreamGive',
    greeting: (name) => `Hola ${name},`,
    linkLabel: 'Verificar este correo de contacto',
    expiry: 'Este enlace caduca en 24 horas.',
  },
  fr: {
    subject: "Vérifiez l'adresse e-mail de contact de votre ONG sur StreamGive",
    greeting: (name) => `Bonjour ${name},`,
    linkLabel: 'Vérifier cette adresse e-mail de contact',
    expiry: 'Ce lien expire dans 24 heures.',
  },
  pt: {
    subject: 'Verifique o e-mail de contato da sua ONG no StreamGive',
    greeting: (name) => `Olá ${name},`,
    linkLabel: 'Verificar este e-mail de contato',
    expiry: 'Este link expira em 24 horas.',
  },
};

/**
 * Picks a template language from a BCP 47 tag: the primary subtag decides
 * (`es-MX` -> `es`), and anything unsupported, malformed or missing falls back to English.
 */
export function resolveEmailLocale(locale?: string | null): EmailLocale {
  const primary = (locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_EMAIL_LOCALES as readonly string[]).includes(primary)
    ? (primary as EmailLocale)
    : 'en';
}

/** Subject, HTML and plain text body of the contact verification email; every dynamic value is escaped or flattened. */
export function contactVerificationEmail(
  locale: string | null | undefined,
  name: string,
  verificationUrl: string,
): { subject: string; html: string; text: string } {
  const template = CONTACT_VERIFICATION[resolveEmailLocale(locale)];
  return {
    subject: template.subject,
    html: `<p>${template.greeting(escapeHtml(name))}</p><p><a href="${escapeHtml(verificationUrl)}">${template.linkLabel}</a>. ${template.expiry}</p>`,
    text: `${template.greeting(name.replace(/\s+/g, ' '))}\n\n${template.linkLabel}: ${verificationUrl}\n\n${template.expiry}`,
  };
}
