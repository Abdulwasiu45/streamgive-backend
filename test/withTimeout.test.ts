import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTimeout } from '../src/server.js';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves with the value when the promise resolves before the deadline', async () => {
    const promise = Promise.resolve('healthy');
    const result = await withTimeout(promise, 1000);

    expect(result).toBe('healthy');
  });

  it('rejects with a timeout error when the deadline is reached before the promise resolves', async () => {
    const neverEnding = new Promise<string>(() => {});
    const assertion = expect(withTimeout(neverEnding, 1000)).rejects.toThrow(
      'health check timed out after 1000 ms',
    );

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('clears the timer when the promise resolves successfully before the deadline', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const promise = Promise.resolve(42);

    const result = await withTimeout(promise, 2000);

    expect(result).toBe(42);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('passes through rejection from the wrapped promise and clears the timer', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const failure = new Error('database connection refused');
    const rejectingPromise = Promise.reject(failure);

    await expect(withTimeout(rejectingPromise, 3000)).rejects.toThrow(
      'database connection refused',
    );
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reject after the promise has already resolved', async () => {
    let resolvedValue: string | undefined;
    const promise = Promise.resolve('fast');

    const resultPromise = withTimeout(promise, 500).then((v) => {
      resolvedValue = v;
      return v;
    });

    await resultPromise;
    expect(resolvedValue).toBe('fast');

    // Advance past the timeout to verify no delayed rejection occurs
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolvedValue).toBe('fast');
  });
});
