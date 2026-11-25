import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { renderMetrics } from '../metrics.js';

/**
 * Compares the bearer token in constant time so response timing cannot be
 * used to discover METRICS_TOKEN one character at a time.
 */
function hasValidBearerToken(header: string | undefined, expectedToken: string): boolean {
  if (header === undefined) {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) {
    return false;
  }

  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export const metricsRoutePlugin = fp(async function metricsRoutePlugin(app: FastifyInstance) {
  /**
   * Exposes process-local Prometheus metrics.
   *
   * When METRICS_TOKEN is set, the endpoint requires a matching
   * `Authorization: Bearer <token>` header so operators can protect it
   * without a network-level rule. When it is unset the endpoint stays public.
   *
   * @route GET /metrics
   * @auth Public, or bearer token when METRICS_TOKEN is set
   * @returns 200 Prometheus text format (`text/plain; version=0.0.4`); 401 `{ error: "unauthorized" }` when the token is missing or wrong.
   */
  app.get(
    '/metrics',
    {
      onRequest: async (request, reply) => {
        const token = process.env.METRICS_TOKEN?.trim();
        if (!token) {
          return;
        }

        if (!hasValidBearerToken(request.headers.authorization, token)) {
          return reply
            .code(401)
            .header('www-authenticate', 'Bearer')
            .send({ error: 'unauthorized' });
        }
      },
    },
    async (_request, reply) => {
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics());
    },
  );
});
