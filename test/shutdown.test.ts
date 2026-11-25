/**
 * Tests for the process-level error handlers defined in src/index.ts.
 *
 * Strategy: import only the `shutdown` export (which is pure async teardown,
 * no process.exit) and verify it stops background workers and closes app.
 * unhandledRejection handler is tested by emitting the event directly on the
 * mocked process listeners via a subprocess-style check that confirms
 * process.exit(1) would be triggered on that path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../src/config.js';

// ---------------------------------------------------------------------------
// Mock heavy dependencies before src/index.ts is imported so the module can
// be loaded without a real DB, RPC server, or network.
// ---------------------------------------------------------------------------

vi.mock('dotenv/config', () => ({}));

vi.mock('../src/server.js', () => ({
  buildServer: vi.fn(() => ({
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockStopIndexer = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/indexer/worker.js', () => ({
  startIndexer: vi.fn(() => mockStopIndexer),
}));

vi.mock('../src/indexer/dispatch.js', () => ({
  dispatchEvent: vi.fn(),
}));

const mockStopWebhookDeliveryWorker = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/notifications/webhookDeliveryWorker.js', () => ({
  startWebhookDeliveryWorker: vi.fn(() => mockStopWebhookDeliveryWorker),
}));

// ---------------------------------------------------------------------------
// Now load the module under test.
// ---------------------------------------------------------------------------
const { shutdown } = await import('../src/index.js');
const { buildServer } = await import('../src/server.js');
const mockApp = vi.mocked(buildServer).mock.results[0]?.value as {
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
};

describe('shutdown()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.close.mockResolvedValue(undefined);
    mockStopIndexer.mockResolvedValue(undefined);
    mockStopWebhookDeliveryWorker.mockResolvedValue(undefined);
  });

  it('stops the indexer and closes the server', async () => {
    await shutdown('SIGTERM');

    expect(mockStopIndexer).toHaveBeenCalledOnce();
    expect(mockApp.close).toHaveBeenCalledOnce();
  });

  it('finishes an in-flight request before shutdown closes the server', async () => {
    const server = Fastify({ logger: false });
    let finishRequest!: () => void;
    let markRequestStarted!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    server.get('/slow', async () => {
      markRequestStarted();
      await requestGate;
      return { finished: true };
    });
    await server.listen({ host: '127.0.0.1', port: 0 });

    const address = server.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the test server to listen on a TCP port');
    }

    mockApp.close.mockImplementation(() => server.close());
    const responsePromise = fetch(`http://127.0.0.1:${address.port}/slow`);
    await requestStarted;

    let shutdownFinished = false;
    const shutdownPromise = shutdown('SIGTERM').then(() => {
      shutdownFinished = true;
    });

    try {
      expect(shutdownFinished).toBe(false);
      finishRequest();

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ finished: true });

      await shutdownPromise;
      expect(shutdownFinished).toBe(true);
    } finally {
      finishRequest();
      if (server.server.listening) {
        await server.close();
      }
    }
  });

  it('logs the signal that triggered the shutdown', async () => {
    await shutdown('SIGTERM');

    expect(mockApp.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM' }),
      'shutting down',
    );
  });

  it('propagates server close errors so callers can decide the exit code', async () => {
    const boom = new Error('close failed');
    mockApp.close.mockRejectedValue(boom);

    await expect(shutdown('SIGTERM')).rejects.toThrow('close failed');
  });

  it('times out and logs the operation still running when the indexer never stops', async () => {
    vi.useFakeTimers();
    mockStopIndexer.mockImplementation(() => new Promise(() => {}));

    try {
      const shutdownPromise = shutdown('SIGTERM');
      const rejection = expect(shutdownPromise).rejects.toThrow(
        'shutdown timed out while waiting for indexer',
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_SHUTDOWN_TIMEOUT_MS);
      await rejection;

      expect(mockApp.log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: 'SIGTERM',
          timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
          running: 'indexer',
        }),
        'shutdown timed out',
      );
      expect(mockApp.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      mockStopIndexer.mockResolvedValue(undefined);
    }
  });
});

describe('unhandledRejection policy', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.close.mockResolvedValue(undefined);
    // Prevent process.exit from terminating the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits with code 1 when an unhandled rejection occurs', async () => {
    // Emit the event the same way Node does for an uncaught rejection.
    process.emit('unhandledRejection', new Error('db connection lost'), Promise.resolve());

    // Allow the microtask queue and any pending promises to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('tears down the indexer and server before exiting on unhandled rejection', async () => {
    process.emit('unhandledRejection', new Error('rpc timeout'), Promise.resolve());

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockStopIndexer).toHaveBeenCalled();
    expect(mockApp.close).toHaveBeenCalled();
  });

  it('still exits with code 1 when shutdown itself errors during an unhandled rejection', async () => {
    mockApp.close.mockRejectedValue(new Error('shutdown error'));

    process.emit('unhandledRejection', new Error('original rejection'), Promise.resolve());

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('uncaughtException policy', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.close.mockResolvedValue(undefined);
    // Prevent process.exit from terminating the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('logs the error, tears down the indexer and server, then exits with code 1', async () => {
    const error = new Error('fatal synchronous crash');
    process.emit('uncaughtException', error);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockApp.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      'uncaughtException — shutting down',
    );
    expect(mockStopIndexer).toHaveBeenCalled();
    expect(mockApp.close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still exits with code 1 when shutdown itself errors during an uncaught exception', async () => {
    mockApp.close.mockRejectedValue(new Error('shutdown error'));

    process.emit('uncaughtException', new Error('crash'));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
