// Parsing and validation for the small set of environment variables whose
// values are used directly at startup. Each parser is pure so it can be unit
// tested without a running server; the callers decide how to fail.
//
// The error messages name the variable and quote the offending value: a typo
// in a deployment dashboard is the common failure, and the default Node
// "listen EADDRNOTAVAIL" style error never mentions the variable that caused
// it.

export const DEFAULT_PORT = 3000;
export const DEFAULT_RATE_LIMIT_MAX = 100;
export const DEFAULT_RATE_LIMIT_WINDOW = '1 minute';

/** Undefined, empty and whitespace-only values are treated as unset. */
function configured(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Validates PORT as an integer TCP port. An empty value means "unset" and
 * gets the default, matching how the rest of the environment is read.
 */
export function parsePort(value: string | undefined): number {
  const raw = configured(value);
  if (raw === undefined) {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${raw}"`);
  }

  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${raw}"`);
  }

  return port;
}

/**
 * Validates RATE_LIMIT_MAX as a positive integer. Zero is rejected: a limit
 * of zero would block every request, which is a typo more often than an
 * intentional configuration.
 */
export function parseRateLimitMax(value: string | undefined): number {
  const raw = configured(value);
  if (raw === undefined) {
    return DEFAULT_RATE_LIMIT_MAX;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`RATE_LIMIT_MAX must be a positive integer, received "${raw}"`);
  }

  const max = Number(raw);
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new Error(`RATE_LIMIT_MAX must be a positive integer, received "${raw}"`);
  }

  return max;
}

// The units @fastify/rate-limit accepts for `timeWindow`, plus the bare
// millisecond form documented in ENVIRONMENT.md ("1 minute" or "10000").
const DURATION_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)?$/i;

/**
 * Validates RATE_LIMIT_WINDOW as a positive duration. The value is returned
 * unchanged (trimmed) because @fastify/rate-limit does its own conversion;
 * this only rejects values that would make the limiter throw on the first
 * request instead of at startup.
 */
export function parseRateLimitWindow(value: string | undefined): string {
  const raw = configured(value);
  if (raw === undefined) {
    return DEFAULT_RATE_LIMIT_WINDOW;
  }

  const match = DURATION_PATTERN.exec(raw);
  const amount = match === null ? Number.NaN : Number(match[1]);
  if (match === null || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `RATE_LIMIT_WINDOW must be a positive duration such as "1 minute" or "10000", received "${raw}"`,
    );
  }

  return raw;
}
