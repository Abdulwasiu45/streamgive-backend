/**
 * Store interface for replay protection.
 *
 * Implementations track used signatures to prevent replay attacks. Keys
 * include enough context (address, timestamp, signature) to uniquely
 * identify a request without false positives when two clients happen to sign
 * at the same millisecond.
 */
export interface ReplayStore {
  /**
   * Returns true when the key has already been seen within the replay window.
   */
  has(key: string): boolean;

  /**
   * Records that a signature was used at the given time (Unix epoch milliseconds).
   */
  set(key: string, timestamp: number): void;

  /**
   * Removes entries older than the given timestamp (Unix epoch milliseconds).
   * Implementations may call this automatically or leave it to the caller.
   */
  prune(olderThan: number): void;
}

/**
 * In-memory replay store with automatic pruning on a 60-second timer.
 *
 * Suitable for single-instance deployments. For horizontal scaling behind
 * a load balancer, use a shared store (Redis, database, etc.) instead.
 */
export class InMemoryReplayStore implements ReplayStore {
  private readonly store = new Map<string, number>();
  private readonly pruner: NodeJS.Timeout;

  constructor(pruneIntervalMs = 60_000) {
    this.pruner = setInterval(() => this.autoPrune(), pruneIntervalMs);
    this.pruner.unref();
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  set(key: string, timestamp: number): void {
    this.store.set(key, timestamp);
  }

  prune(olderThan: number): void {
    for (const [key, seenAt] of this.store) {
      if (seenAt < olderThan) {
        this.store.delete(key);
      }
    }
  }

  private autoPrune(): void {
    this.prune(Date.now());
  }
}
