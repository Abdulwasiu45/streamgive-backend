import type { FastifyInstance } from 'fastify';
import type { FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

import { prisma } from '../db.js';
import { getCheckpoint } from '../indexer/checkpoint.js';
import { getLatestLedgerSequence } from '../stellar/rpc.js';

interface HealthRoutesOptions {
  healthCheckTimeoutMs: number;
}

/**
 * Races a promise against a timeout so slow health dependencies do not hang
 * probes indefinitely.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`health check timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
export const healthRoutesPlugin = fp(async function healthRoutesPlugin(
  app: FastifyInstance,
  { healthCheckTimeoutMs }: HealthRoutesOptions,
) {
  const HEALTH_CHECK_TIMEOUT_MS = healthCheckTimeoutMs;

  /**
   * Liveness probe — checks the database is reachable and returns the minimal
   * contract Render and uptime pingers expect: a plain 200 with a status flag.
   *
   * @route GET /health
   * @auth Public
   * @returns 200 `{ status: "ok" }`; 503 on DB failure.
   */
  const healthHandler = async (_req: unknown, reply: FastifyReply) => {
    const dbResult = await Promise.allSettled([
      withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS),
    ]);

    const db = dbResult[0].status === 'fulfilled' ? 'ok' : 'error';
    const status = db === 'ok' ? 'ok' : 'error';
    return reply.code(status === 'ok' ? 200 : 503).send({ status, db });
  };

  app.get('/health', healthHandler);
  app.get('/v1/health', healthHandler);

  /**
   * Readiness probe — checks the database, the Stellar RPC node, and indexer
   * lag.  Each remote call is time-boxed so a slow dependency is reported as
   * degraded rather than hanging the probe indefinitely.
   *
   * @route GET /health/ready
   * @auth Public
   * @returns 200 `{ status: "ok", lag, latestLedger, checkpointLedger }`; 503 `{ status: "error", reason, ... }` when unavailable or not caught up.
   */
  app.get('/health/ready', async (request, reply) => {
    try {
      // 1. Check DB (time-boxed)
      await withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS);

      // 2. Get RPC and Indexer info (both time-boxed)
      const [latestLedger, checkpointLedger] = await Promise.all([
        withTimeout(getLatestLedgerSequence(), HEALTH_CHECK_TIMEOUT_MS),
        getCheckpoint(),
      ]);

      if (checkpointLedger === undefined) {
        return reply.code(503).send({ status: 'error', reason: 'indexer_not_started' });
      }

      const lag = latestLedger - checkpointLedger;
      const parsedThreshold = parseInt(process.env.INDEXER_LAG_THRESHOLD ?? '100', 10);
      const threshold = Number.isNaN(parsedThreshold) ? 0 : parsedThreshold;

      if (lag > threshold) {
        return reply.code(503).send({ status: 'error', reason: 'indexer_lagging', lag, threshold });
      }

      return { status: 'ok', lag, latestLedger, checkpointLedger };
    } catch (error) {
      request.log.error(error);
      return reply.code(503).send({ status: 'error', reason: 'service_unavailable' });
    }
  });
});
