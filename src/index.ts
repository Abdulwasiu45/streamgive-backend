// Must be the first import: every other module (transitively, db.ts) reads
// process.env at module-load time, so the environment has to be populated
// before anything else is imported.
import 'dotenv/config';

import { parseConfig, parseShutdownTimeoutMs } from './config.js';
import { dispatchEvent } from './indexer/dispatch.js';
import { startIndexer } from './indexer/worker.js';
import { logger } from './logger.js';
import { startWebhookDeliveryWorker } from './notifications/webhookDeliveryWorker.js';
import { startStreamRunningLowWorker } from './notifications/streamRunningLowWorker.js';
import { buildServer } from './server.js';

function fail(message: string): never {
  // Print every configuration problem at once rather than a stack trace from listen().
  process.stderr.write(`${message}\n`);
  logger.error({ message }, 'Configuration Error');
  process.exit(1);
}

const config = (() => {
  try {
    return parseConfig(process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
})();

const port = config.PORT;
const shutdownTimeoutMs = (() => {
  try {
    return parseShutdownTimeoutMs(process.env.SHUTDOWN_TIMEOUT_MS);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
})();

const app = (() => {
  try {
    return buildServer();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
})();

// Left unwrapped so a handler failure propagates: worker.ts's own catch
// logs it and, crucially, leaves the checkpoint unadvanced so the failed
// event gets retried on the next poll instead of silently skipped.
const stopIndexer = startIndexer(dispatchEvent);
const stopWebhookDeliveryWorker = startWebhookDeliveryWorker();
const stopStreamRunningLowWorker = startStreamRunningLowWorker(config.STREAM_RUNNING_LOW_DAYS);

/**
 * Tear down the indexer and HTTP server, then resolve. The caller is
 * responsible for deciding the exit code and calling process.exit().
 * Separating teardown from exit makes the function testable without
 * process.exit side-effects.
 */
export async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  let running = 'indexer';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanup = async () => {
    await stopIndexer();
    running = 'webhook delivery worker';
    await stopWebhookDeliveryWorker();
    running = 'stream running low worker';
    await stopStreamRunningLowWorker();
    running = 'HTTP server and database connections';
    await app.close();
  };

  try {
    await Promise.race([
      cleanup(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          app.log.error({ signal, timeoutMs: shutdownTimeoutMs, running }, 'shutdown timed out');
          reject(new Error(`shutdown timed out while waiting for ${running}`));
        }, shutdownTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function shutdownAfterFatalError(source: 'unhandledRejection' | 'uncaughtException', err: unknown) {
  app.log.error({ err }, `${source} — shutting down`);
  // shutdown() is bounded by SHUTDOWN_TIMEOUT_MS and rejects when cleanup
  // stalls, so this always reaches process.exit(1).
  shutdown(source)
    .catch((shutdownError) => app.log.error({ err: shutdownError }, 'error during shutdown'))
    .finally(() => process.exit(1));
}

// Either fatal process error leaves the application in an unknown state.
// Perform the same graceful teardown, bounded by SHUTDOWN_TIMEOUT_MS.
process.on('unhandledRejection', (reason) => {
  shutdownAfterFatalError('unhandledRejection', reason);
});

process.on('uncaughtException', (err) => {
  shutdownAfterFatalError('uncaughtException', err);
});

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// SIGTERM is what Docker/Kubernetes send on `docker stop`/pod termination;
// SIGINT is Ctrl+C locally. Without this, both just kill the process
// mid-request instead of finishing in-flight work and closing the DB pool.
process.on('SIGTERM', () => {
  shutdown('SIGTERM')
    .then(() => process.exit(0))
    .catch((err) => {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    });
});

process.on('SIGINT', () => {
  shutdown('SIGINT')
    .then(() => process.exit(0))
    .catch((err) => {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    });
});
