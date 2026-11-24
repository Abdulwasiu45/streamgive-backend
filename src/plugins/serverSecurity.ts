import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';

import { MAINTENANCE_RETRY_AFTER_SECONDS } from '../config.js';
import { configuredAdminAddresses } from '../middleware/adminAuth.js';

interface ServerSecurityOptions {
  allowedOrigins: string[];
  rateLimitMax: number;
  rateLimitWindow: string;
  maintenanceMode: boolean;
}

export const serverSecurityPlugin = fp(async function serverSecurityPlugin(
  app: FastifyInstance,
  { allowedOrigins, rateLimitMax, rateLimitWindow, maintenanceMode }: ServerSecurityOptions,
) {
  // Register helmet for security headers
  app.register(helmet, {
    contentSecurityPolicy: false, // Disabled for API-only server
    global: true,
  });

  // The browser app runs on a different origin to this API (a different
  // port in development, a different host in deployment), so every call
  // from it is cross-origin and fails as an opaque "Failed to fetch"
  // without these headers.
  //
  // Allowed origins are an explicit list, not a wildcard: the admin routes
  // authenticate with a signature the browser sends as a header, so any
  // origin allowed here can ask a signed-in admin's browser to call them.
  app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'x-admin-address',
      'x-admin-signature',
      'x-admin-timestamp',
      'x-request-id',
    ],
    // Access-Control-Expose-Headers: without these, a browser on another
    // origin cannot read the limiter's headers even though the response
    // carries them. `Retry-After` is the machine-readable backoff contract;
    // the x-ratelimit-* headers show the remaining budget.
    exposedHeaders: [
      'x-request-id',
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ],
  });

  app.register(rateLimit, {
    global: true,
    max: rateLimitMax,
    timeWindow: rateLimitWindow,
    keyGenerator: (request) => {
      const address = request.headers['x-admin-address'];
      if (
        request.routeOptions.config.adminRateLimit === true &&
        typeof address === 'string' &&
        configuredAdminAddresses().includes(address)
      ) {
        return `admin:${address}`;
      }
      return request.ip;
    },
    // Spell the headers out instead of leaning on the plugin's defaults:
    // `Retry-After` is the machine-readable contract clients back off on
    // (RFC 9110 §10.2.3), and the `x-ratelimit-*` headers let a client see
    // its remaining budget before it is throttled.
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  app.log.info({ max: rateLimitMax, timeWindow: rateLimitWindow }, 'global rate limit configured');

  // Maintenance mode stops writes during a migration or RPC incident while
  // reads, health checks and CORS preflights keep working.
  if (maintenanceMode) {
    app.log.warn('maintenance mode is on: write requests answer 503');
    const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
    app.addHook('onRequest', async (request, reply) => {
      if (!readMethods.has(request.method)) {
        return reply
          .code(503)
          .header('retry-after', String(MAINTENANCE_RETRY_AFTER_SECONDS))
          .send({ error: 'maintenance' });
      }
    });
  }

  // Root routes are declared before the limiter plugin's global onRoute hook runs.
  const rootRateLimitedRoutes = new Set(['/metrics', '/health', '/health/ready']);
  app.addHook('onRequest', async (request, reply) => {
    if (rootRateLimitedRoutes.has(request.routeOptions.url ?? '')) {
      await request.server.rateLimit.call(request.server).call(request.server, request, reply);
    }
  });
});
