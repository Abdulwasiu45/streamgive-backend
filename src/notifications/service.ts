import { createHmac, randomUUID } from 'node:crypto';

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { recordNotificationDelivery } from '../metrics.js';
import { DEFAULT_NOTIFY_WEBHOOK_TIMEOUT_MS } from '../config.js';
import { envInt } from '../config/env.js';
import type { NotificationEvent } from './types.js';
import { isSafeWebhookUrl } from './urlValidation.js';

const deliveredEventIds = new Set<string>();
const MAX_DELIVERED_EVENT_IDS = 10_000;

export function _resetDeliveredEventIdsForTest(): void {
  deliveredEventIds.clear();
}

export function _deliveredEventIdCountForTest(): number {
  return deliveredEventIds.size;
}

export const _MAX_DELIVERED_EVENT_IDS_FOR_TEST = MAX_DELIVERED_EVENT_IDS;

/** Remembers a delivered event id, evicting the oldest ids past the cap. */
function rememberDelivered(eventId: string): void {
  deliveredEventIds.add(eventId);
  while (deliveredEventIds.size > MAX_DELIVERED_EVENT_IDS) {
    const oldest = deliveredEventIds.values().next().value;
    if (oldest === undefined) break;
    deliveredEventIds.delete(oldest);
  }
}

/**
 * Versioned HMAC-SHA256 over the timestamp, delivery id, and exact request
 * body. See docs/NOTIFICATIONS.md for receiver-side verification.
 */
const SIGNATURE_HEADER = 'x-streamgive-signature';
const DELIVERY_ID_HEADER = 'x-streamgive-delivery-id';
const TIMESTAMP_HEADER = 'x-streamgive-timestamp';
export const MAX_WEBHOOK_DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60 * 60 * 1_000;

type WebhookTarget = { url: string; secret?: string; channel: string };
type WebhookResult = { success: boolean; recordNoop: boolean };
type WebhookAttemptResult = { success: boolean; error?: string };

function webhookLocation(target: WebhookTarget): string {
  try {
    return new URL(target.url).origin;
  } catch {
    return '[invalid-url]';
  }
}

function getWebhookTimeoutMs(): number {
  const configured = envInt(process.env.NOTIFY_WEBHOOK_TIMEOUT_MS, 'NOTIFY_WEBHOOK_TIMEOUT_MS', {
    defaultValue: DEFAULT_NOTIFY_WEBHOOK_TIMEOUT_MS,
    min: 1,
  });
  return Math.min(configured, 2_147_483_647);
}

/** Posts one durable delivery attempt to its destination. */
async function sendWebhookAttempt(
  event: NotificationEvent,
  target: WebhookTarget,
  deliveryId: string,
  body: string,
): Promise<WebhookAttemptResult> {
  if (event.eventId) {
    try {
      const delivered = await prisma.notificationLog.findFirst({
        where: { eventId: event.eventId, channel: target.channel, success: true },
      });
      if (delivered) return { success: true };
    } catch (error) {
      logger.error({ err: error }, 'failed to check persisted endpoint delivery');
      return { success: false, error: 'failed to check persisted endpoint delivery' };
    }
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [DELIVERY_ID_HEADER]: deliveryId,
    [TIMESTAMP_HEADER]: timestamp,
  };

  // Read per call rather than at module load so deployments can rotate the
  // secret without a restart, and so tests can set it per case.
  const secret = target.secret;
  if (secret) {
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${deliveryId}.${body}`)
      .digest('hex');
    headers[SIGNATURE_HEADER] = `v1=${signature}`;
  }

  let success = false;
  let error: string | undefined;

  try {
    if (target.channel.startsWith('webhook:') && !(await isSafeWebhookUrl(target.url))) {
      error = 'unsafe webhook destination';
    } else {
      const res = await fetch(target.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(getWebhookTimeoutMs()),
        redirect: 'error',
      });

      if (res.ok) {
        success = true;
      } else {
        error = `status ${res.status}`;
        logger.error(
          { status: res.status, url: webhookLocation(target) },
          'webhook notification failed',
        );
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.name : 'unknown_error';
    logger.error({ err }, 'webhook notification failed');
  }

  recordNotificationDelivery(success ? 'success' : 'failure');

  try {
    const data = {
      eventId: event.eventId ?? null,
      eventType: event.type,
      channel: target.channel,
      success,
      error,
    };
    if (event.eventId) {
      await prisma.notificationLog.upsert({
        where: { eventId_channel: { eventId: event.eventId, channel: target.channel } },
        create: data,
        update: { success, error },
      });
    } else {
      await prisma.notificationLog.create({ data });
    }
  } catch (err) {
    logger.error({ err }, 'failed to write notification log');
  }

  return { success, error };
}

export type WebhookPingResult = {
  ok: boolean;
  /** HTTP status from the receiver; null when no response arrived. */
  statusCode: number | null;
  latencyMs: number;
  deliveryId: string;
  error?: string;
};

/**
 * Sends one signed `ping` event to a webhook receiver so an operator can check
 * it after adding or editing it. Uses the same headers, signature and
 * delivery timeout as real deliveries, but never retries and never writes a
 * notification log, delivery row or metric: a ping is not a delivery.
 */
export async function sendWebhookPing(target: {
  id: string;
  url: string;
  secret: string;
}): Promise<WebhookPingResult> {
  const deliveryId = `ping-${randomUUID()}`;
  const body = JSON.stringify({
    type: 'ping',
    endpointId: target.id,
    sentAt: new Date().toISOString(),
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', target.secret)
    .update(`${timestamp}.${deliveryId}.${body}`)
    .digest('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [DELIVERY_ID_HEADER]: deliveryId,
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: `v1=${signature}`,
  };

  if (!(await isSafeWebhookUrl(target.url))) {
    return { ok: false, statusCode: null, latencyMs: 0, deliveryId, error: 'unsafe_destination' };
  }

  const started = performance.now();
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(getWebhookTimeoutMs()),
      redirect: 'error',
    });
    return {
      ok: res.ok,
      statusCode: res.status,
      latencyMs: Math.round(performance.now() - started),
      deliveryId,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown_error';
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.round(performance.now() - started),
      deliveryId,
      error: name === 'TimeoutError' ? 'timeout' : name,
    };
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

/**
 * Claims and attempts one queued delivery. Conditional updates provide a
 * database-backed lease so multiple application instances cannot send the
 * same retry concurrently.
 */
export async function processWebhookDelivery(deliveryId: string): Promise<boolean> {
  const now = new Date();
  const candidate = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
  });
  if (!candidate) return false;
  if (candidate.status === 'SUCCEEDED') return true;
  if (candidate.status === 'FAILED' || candidate.nextAttemptAt > now) return false;
  if (candidate.attempts >= candidate.maxAttempts) return false;

  const claimed = await prisma.webhookDelivery.updateMany({
    where: {
      id: candidate.id,
      status: 'PENDING',
      attempts: candidate.attempts,
      nextAttemptAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: {
      attempts: { increment: 1 },
      lockedUntil: new Date(now.getTime() + getWebhookTimeoutMs() + 60_000),
    },
  });
  if (claimed.count === 0) return false;

  const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
  });
  const event = JSON.parse(delivery.payload) as NotificationEvent;
  const target: WebhookTarget = {
    url: delivery.url,
    secret: delivery.secret ?? undefined,
    channel: delivery.channel,
  };
  const result = await sendWebhookAttempt(event, target, delivery.id, delivery.payload);

  if (result.success) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        lockedUntil: null,
        lastError: null,
      },
    });
    return true;
  }

  const finished = delivery.attempts >= delivery.maxAttempts;
  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: finished ? 'FAILED' : 'PENDING',
      completedAt: finished ? new Date() : null,
      nextAttemptAt: new Date(Date.now() + retryDelayMs(delivery.attempts)),
      lockedUntil: null,
      lastError: result.error ?? 'delivery failed',
    },
  });
  return false;
}

async function queueWebhookDelivery(
  event: NotificationEvent,
  target: WebhookTarget,
): Promise<boolean> {
  const payload = JSON.stringify(event);
  const deliveryKey = event.eventId
    ? JSON.stringify([event.eventId, target.channel])
    : randomUUID();
  const data = {
    deliveryKey,
    eventId: event.eventId ?? null,
    eventType: event.type,
    channel: target.channel,
    url: target.url,
    secret: target.secret ?? null,
    payload,
    maxAttempts: MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  };

  const delivery = await prisma.webhookDelivery.upsert({
    where: { deliveryKey },
    create: data,
    update: {},
  });

  return processWebhookDelivery(delivery.id);
}

/** Delivers to every enabled endpoint subscribed to the event. */
async function notifyWebhook(event: NotificationEvent): Promise<WebhookResult> {
  let endpoints: Awaited<ReturnType<typeof prisma.notificationEndpoint.findMany>>;
  try {
    endpoints = await prisma.notificationEndpoint.findMany({ where: { enabled: true } });
  } catch (error) {
    logger.error({ err: error }, 'failed to load webhook endpoints');
    return { success: false, recordNoop: false };
  }

  const configured = endpoints.length > 0;
  const targets: WebhookTarget[] = endpoints
    .filter((endpoint) => endpoint.eventTypes.includes(event.type))
    .map((endpoint) => ({
      url: endpoint.url,
      secret: endpoint.secret,
      channel: `webhook:${endpoint.id}`,
    }));

  // Keep the original single-endpoint environment configuration working for
  // existing deployments until they migrate destinations into the table.
  if (!configured && process.env.NOTIFY_WEBHOOK_URL) {
    targets.push({
      url: process.env.NOTIFY_WEBHOOK_URL,
      secret: process.env.NOTIFY_WEBHOOK_SECRET,
      channel: 'webhook',
    });
  }

  if (targets.length === 0) {
    return { success: true, recordNoop: !configured };
  }

  const results = await Promise.all(targets.map((target) => queueWebhookDelivery(event, target)));
  return { success: results.every(Boolean), recordNoop: false };
}

/** Stub: no email provider wired up yet — picking one (SendGrid, Postmark,
 * Resend, ...) is a separate decision. `notify()` below is the only thing
 * the rest of the app calls, so swapping this out later touches no call
 * sites. */
async function notifyEmail(event: NotificationEvent): Promise<void> {
  logger.info({ event }, '[notify:email:stub]');

  try {
    await prisma.notificationLog.create({
      data: {
        eventType: event.type,
        channel: 'email',
        success: true,
      },
    });
  } catch (err) {
    logger.error({ err }, 'failed to write email notification log');
  }
}

export async function notify(event: NotificationEvent): Promise<void> {
  if (event.eventId) {
    if (deliveredEventIds.has(event.eventId)) return;
  }

  const [webhookResult] = await Promise.all([notifyWebhook(event), notifyEmail(event)]);

  // Mark delivered only after successful delivery
  if (event.eventId && webhookResult.success) {
    rememberDelivered(event.eventId);

    if (webhookResult.recordNoop) {
      try {
        await prisma.notificationLog.create({
          data: {
            eventId: event.eventId,
            eventType: event.type,
            channel: 'webhook',
            success: true,
          },
        });
      } catch (err) {
        logger.error({ err }, 'failed to persist delivery record');
      }
    }
  }
}

/**
 * Dispatches a notification asynchronously after transaction commit,
 * ensuring any errors are caught and do not propagate back into the handler
 * or block the indexer.
 */
export function dispatchNotification(event: NotificationEvent): void {
  notify(event).catch((err) => {
    logger.error({ err }, 'asynchronous notification dispatch failed');
  });
}
