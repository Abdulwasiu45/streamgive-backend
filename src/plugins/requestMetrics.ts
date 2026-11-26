import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { recordHttpRequest } from '../metrics.js';

interface RequestMetricsOptions {
  slowRequestThresholdMs: number;
}

export const requestMetricsPlugin = fp(async function requestMetricsPlugin(
  app: FastifyInstance,
  { slowRequestThresholdMs }: RequestMetricsOptions,
) {
  const requestStartedAt = new WeakMap<object, bigint>();
  app.addHook('onRequest', async (request) => {
    requestStartedAt.set(request, process.hrtime.bigint());
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    if (startedAt === undefined) return;
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    const route = request.routeOptions.url ?? 'unmatched';
    recordHttpRequest(request.method, route, reply.statusCode, durationSeconds);

    const durationMs = Math.round(durationSeconds * 1000);
    if (slowRequestThresholdMs > 0 && durationMs > slowRequestThresholdMs) {
      // Route template (not the raw URL) so ids and query strings never leak
      // into logs and slow requests group by endpoint.
      app.log.warn(
        {
          reqId: request.id,
          method: request.method,
          route,
          statusCode: reply.statusCode,
          durationMs,
          thresholdMs: slowRequestThresholdMs,
        },
        'slow request',
      );
    }
  });
});
