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
    // Prevent process.exit from terminating the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('logs the error and exits with code 1 when an uncaught exception occurs', () => {
    const error = new Error('fatal synchronous crash');
    process.emit('uncaughtException', error);

    expect(mockApp.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      'uncaught exception',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
