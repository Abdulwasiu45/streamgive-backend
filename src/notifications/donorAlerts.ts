import { createHash, randomBytes } from 'node:crypto';

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { escapeHtml } from './emailTemplates.js';
import type { NotificationEvent } from './types.js';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

export type RegisterResult = 'sent' | 'cooldown' | 'already_verified' | 'not_configured' | 'failed';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Provider settings shared with the NGO contact emails; null when email is not configured. */
function emailConfig(): { apiKey: string; from: string; baseUrl: URL } | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_EMAIL_FROM;
  const publicApiUrl = process.env.API_PUBLIC_URL;
  if (!apiKey || !from || !publicApiUrl) return null;
  try {
    const baseUrl = new URL(publicApiUrl);
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') return null;
    return { apiKey, from, baseUrl };
  } catch {
    return null;
  }
}

async function sendEmail(
  config: { apiKey: string; from: string },
  message: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> },
): Promise<boolean> {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.from, ...message, to: [message.to] }),
    });
    if (!response.ok) {
      logger.error({ status: response.status }, 'donor email alert was rejected');
      return false;
    }
    return true;
  } catch (error) {
    logger.error({ err: error }, 'failed to send donor email alert');
    return false;
  }
}

function unsubscribeUrl(baseUrl: URL, token: string): string {
  const url = new URL('/v1/donor-email-alerts/unsubscribe', baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Registers an email for a donor address and sends a confirmation link. Nothing is
 * alerted until the link is used; a repeat request inside the cooldown sends nothing new.
 */
export async function registerDonorEmailAlert(
  donorAddress: string,
  email: string,
): Promise<RegisterResult> {
  const config = emailConfig();
  if (!config) return 'not_configured';

  const normalized = email.trim().toLowerCase();
  const key = { donorAddress_email: { donorAddress, email: normalized } };
  const existing = await prisma.donorEmailAlert.findUnique({ where: key });
  if (existing?.verifiedAt) return 'already_verified';
  const now = new Date();
  if (
    existing?.lastVerificationSentAt &&
    now.getTime() - existing.lastVerificationSentAt.getTime() < VERIFICATION_COOLDOWN_MS
  ) {
    return 'cooldown';
  }

  const token = randomBytes(32).toString('base64url');
  const fresh = {
    verificationTokenHash: hashToken(token),
    verificationExpiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    lastVerificationSentAt: now,
  };
  const row = await prisma.donorEmailAlert.upsert({
    where: key,
    create: {
      donorAddress,
      email: normalized,
      unsubscribeToken: randomBytes(24).toString('base64url'),
      ...fresh,
    },
    update: fresh,
  });

  const confirmUrl = new URL('/v1/donor-email-alerts/verify', config.baseUrl);
  confirmUrl.searchParams.set('token', token);
  const stop = unsubscribeUrl(config.baseUrl, row.unsubscribeToken);
  const sent = await sendEmail(config, {
    to: normalized,
    subject: 'Confirm your StreamGive stream alerts',
    html: `<p>Confirm that you want email alerts about your StreamGive streams.</p><p><a href="${escapeHtml(confirmUrl.toString())}">Confirm email alerts</a>. This link expires in 24 hours.</p><p>If you did not ask for this, ignore this email or <a href="${escapeHtml(stop)}">unsubscribe</a>.</p>`,
    text: `Confirm that you want email alerts about your StreamGive streams: ${confirmUrl.toString()}\n\nThis link expires in 24 hours. If you did not ask for this, ignore this email or unsubscribe: ${stop}`,
  });
  return sent ? 'sent' : 'failed';
}

/** Marks the address verified when the one-time token is valid and unexpired. */
export async function confirmDonorEmailAlert(token: string): Promise<boolean> {
  const confirmed = await prisma.donorEmailAlert.updateMany({
    where: {
      verificationTokenHash: hashToken(token),
      verificationExpiresAt: { gt: new Date() },
      verifiedAt: null,
    },
    data: { verifiedAt: new Date(), verificationTokenHash: null, verificationExpiresAt: null },
  });
  return confirmed.count === 1;
}

/** Removes the subscription behind an unsubscribe token; repeating it changes nothing. */
export async function unsubscribeDonorEmailAlert(token: string): Promise<void> {
  await prisma.donorEmailAlert.deleteMany({ where: { unsubscribeToken: token } });
}

const ALERT_WORDING = {
  stream_created: 'was created',
  stream_cancelled: 'has ended',
} as const;

/**
 * Emails the verified addresses of the stream's donor when a stream is created or ends.
 * Each email carries only a summary (stream number, NGO name, what happened) and an
 * unsubscribe link. Top-up and running-low alerts need indexer events that do not exist yet.
 */
export async function notifyDonorAlerts(event: NotificationEvent): Promise<void> {
  if (event.type !== 'stream_created' && event.type !== 'stream_cancelled') return;
  try {
    const config = emailConfig();
    if (!config) return;

    const stream = await prisma.stream.findUnique({
      where: { onChainId: BigInt(event.streamId) },
      select: {
        onChainId: true,
        donor: { select: { address: true } },
        ngo: { select: { name: true, displayName: true } },
      },
    });
    if (!stream) return;

    const subscribers = await prisma.donorEmailAlert.findMany({
      where: { donorAddress: stream.donor.address, verifiedAt: { not: null } },
    });
    const ngoName = stream.ngo.displayName || stream.ngo.name || 'an NGO';
    const summary = `Your stream #${stream.onChainId} to ${ngoName} ${ALERT_WORDING[event.type]}.`;

    for (const subscriber of subscribers) {
      const stop = unsubscribeUrl(config.baseUrl, subscriber.unsubscribeToken);
      await sendEmail(config, {
        to: subscriber.email,
        subject: `StreamGive: stream #${stream.onChainId} ${ALERT_WORDING[event.type]}`,
        html: `<p>${escapeHtml(summary)}</p><p><a href="${escapeHtml(stop)}">Unsubscribe from stream alerts</a></p>`,
        text: `${summary}\n\nUnsubscribe from stream alerts: ${stop}`,
        headers: {
          'List-Unsubscribe': `<${stop}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
    }
  } catch (error) {
    logger.error({ err: error }, 'donor email alerts failed');
  }
}
