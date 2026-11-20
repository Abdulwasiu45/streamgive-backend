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

// An unhandled promise rejection leaves the process in an unknown state just
// like an uncaught synchronous exception — tear everything down cleanly and
// let the orchestrator (Docker / Kubernetes / Render) restart the process.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled rejection — shutting down');
  shutdown('unhandledRejection')
    .catch((err) => app.log.error({ err }, 'error during shutdown'))
    .finally(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaught exception');
  process.exit(1);
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
