// Must be the first import: every other module (transitively, db.ts) reads
// process.env at module-load time, so the environment has to be populated
// before anything else is imported.
import 'dotenv/config';

import { parsePort } from './config.js';
import { dispatchEvent } from './indexer/dispatch.js';
import { startIndexer } from './indexer/worker.js';
import { startWebhookDeliveryWorker } from './notifications/webhookDeliveryWorker.js';
import { buildServer } from './server.js';

function fail(message: string): never {
  // A single line with the variable and the bad value is easier to act on
  // than a stack trace from inside the listen call.
  console.error(`❌ Configuration Error: ${message}`);
  process.exit(1);
}

const port = (() => {
  try {
    return parsePort(process.env.PORT);
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
const FATAL_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Tear down the indexer and HTTP server, then resolve. The caller is
 * responsible for deciding the exit code and calling process.exit().
 * Separating teardown from exit makes the function testable without
 * process.exit side-effects.
 */
export async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await stopIndexer();
  await stopWebhookDeliveryWorker();
  await app.close();
}

function shutdownAfterFatalError(source: 'unhandledRejection' | 'uncaughtException', err: unknown) {
  app.log.error({ err }, `${source} — shutting down`);
  const hardExitTimer = setTimeout(() => {
    app.log.error(
      { source, timeoutMs: FATAL_SHUTDOWN_TIMEOUT_MS },
      'shutdown timed out; forcing exit',
    );
    process.exit(1);
  }, FATAL_SHUTDOWN_TIMEOUT_MS);

  shutdown(source)
    .catch((shutdownError) => app.log.error({ err: shutdownError }, 'error during shutdown'))
    .finally(() => {
      clearTimeout(hardExitTimer);
      process.exit(1);
    });
}

// Either fatal process error leaves the application in an unknown state.
// Perform the same graceful teardown, with a hard exit if cleanup stalls.
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
