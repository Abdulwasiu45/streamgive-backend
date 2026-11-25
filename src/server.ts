import Fastify from 'fastify';

import { parseConfig } from './config.js';
import { donorRoutes } from './routes/donors.js';
import { impactRoutes } from './routes/impact.js';
import { indexerStatusRoutes } from './routes/indexerStatus.js';
import { ngoApplicationRoutes } from './routes/ngoApplications.js';
import { ngoRoutes } from './routes/ngos.js';
import { deadLetterRoutes } from './routes/deadLetters.js';
import { notificationEndpointRoutes } from './routes/notificationEndpoints.js';
import { notificationLogRoutes } from './routes/notificationLogs.js';
import { streamRoutes } from './routes/streams.js';
import { tokenRoutes } from './routes/tokens.js';
import { registerRequestIdHeader, requestIdOptions } from './requestId.js';
import { registerCompression } from './plugins/compression.js';
import { healthRoutesPlugin } from './plugins/healthRoutes.js';
import { metricsRoutePlugin } from './plugins/metricsRoute.js';
import { openApiPlugin } from './plugins/openapi.js';
import { requestMetricsPlugin } from './plugins/requestMetrics.js';
import { serverLifecyclePlugin } from './plugins/serverLifecycle.js';
import { serverSecurityPlugin } from './plugins/serverSecurity.js';
import { versionRoutePlugin } from './plugins/versionRoute.js';
import { registerLogRetention } from './maintenance/logRetention.js';

// pino-pretty uses a worker thread; avoid its overhead in production and tests.
const USE_PRETTY_LOGS = !['production', 'test'].includes(process.env.NODE_ENV ?? '');

export type TrustProxySetting =
  boolean | string | string[] | ((address: string, hop: number) => boolean);

/**
 * Parses the TRUST_PROXY environment variable into a valid Fastify trustProxy configuration.
 *
 * Behind a reverse proxy (such as Render's load balancer or Cloudflare), Fastify's
 * socket.remoteAddress is the proxy's IP. Without trustProxy enabled, @fastify/rate-limit
 * keys all clients to that single proxy IP, throttling all users collectively.
 *
 * Supported values:
 * - undefined or empty: defaults to `true` (enabling proxy trust by default behind Render)
 * - 'true': trusts all proxies, reading client IP from the first entry of X-Forwarded-For
 * - 'false': disables proxy trust, using socket remoteAddress
 * - integer string (e.g. '1', '2'): bounded hop count function trusting the specified number of proxy hops
 * - comma-separated list or single string: IP or CIDR ranges to trust
 */
export function parseTrustProxy(value: string | undefined): TrustProxySetting {
  if (value === undefined || value.trim() === '') {
    return true;
  }
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  const num = Number(trimmed);
  if (!Number.isNaN(num) && Number.isInteger(num)) {
    const hops = envInt(trimmed, 'TRUST_PROXY', {
      min: -Number.MAX_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
    });
    if (hops === undefined) return true;
    if (hops <= 0) {
      return false;
    }
    return (_address: string, hop: number) => hop < hops;
  }
  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return trimmed;
}

export interface BuildServerOptions {
  trustProxy?: TrustProxySetting;
}

export { withTimeout } from './plugins/healthRoutes.js';

export function buildServer(options?: BuildServerOptions) {
  const cfg = parseConfig(process.env);
  const trustProxySetting =
    options?.trustProxy !== undefined ? options.trustProxy : parseTrustProxy(cfg.TRUST_PROXY);

  const app = Fastify({
    ...requestIdOptions,
    bodyLimit: cfg.BODY_LIMIT_BYTES,
    logger: {
      level: cfg.LOG_LEVEL,
      transport: USE_PRETTY_LOGS ? { target: 'pino-pretty' } : undefined,
    },
    trustProxy: trustProxySetting,
  });

  registerRequestIdHeader(app);
  app.register(registerCompression);
  app.register(serverLifecyclePlugin, { bodyLimit: cfg.BODY_LIMIT_BYTES });
  app.register(serverSecurityPlugin, {
    allowedOrigins: cfg.CORS_ORIGINS,
    rateLimitMax: cfg.RATE_LIMIT_MAX,
    rateLimitWindow: cfg.RATE_LIMIT_WINDOW,
    maintenanceMode: cfg.MAINTENANCE_MODE,
  });
  app.register(requestMetricsPlugin, {
    slowRequestThresholdMs: cfg.SLOW_REQUEST_THRESHOLD_MS,
  });
  app.register(metricsRoutePlugin);
  app.register(openApiPlugin);
  app.register(healthRoutesPlugin, {
    healthCheckTimeoutMs: cfg.HEALTH_CHECK_TIMEOUT_MS,
    indexerLagThreshold: cfg.INDEXER_LAG_THRESHOLD,
  });
  app.register(versionRoutePlugin);

  const apiPrefix = { prefix: '/v1' };
  app.register(ngoRoutes, apiPrefix);
  app.register(donorRoutes, apiPrefix);
  app.register(streamRoutes, apiPrefix);
  app.register(tokenRoutes, apiPrefix);
  app.register(impactRoutes, apiPrefix);
  app.register(ngoApplicationRoutes, apiPrefix);
  app.register(indexerStatusRoutes, apiPrefix);
  app.register(deadLetterRoutes, apiPrefix);
  app.register(notificationEndpointRoutes, apiPrefix);
  app.register(notificationLogRoutes, apiPrefix);
  registerLogRetention(app);

  return app;
}
