import { z } from 'zod';

export const DEFAULT_PORT = 3000;
export const DEFAULT_RATE_LIMIT_MAX = 100;
export const DEFAULT_RATE_LIMIT_WINDOW = '1 minute';
export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
export const DEFAULT_SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
export const DEFAULT_CORS_ORIGIN = 'http://localhost:3001';
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 3000;
export const DEFAULT_INDEXER_LAG_THRESHOLD = 100;
export const DEFAULT_INDEXER_POLL_INTERVAL_MS = 5000;
export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const DEFAULT_RATE_LIMIT_APPLICATION_MAX = 5;
export const DEFAULT_RATE_LIMIT_APPLICATION_WINDOW = '1 minute';
export const DEFAULT_NOTIFY_WEBHOOK_TIMEOUT_MS = 5000;
export const DEFAULT_SLOW_REQUEST_THRESHOLD_MS = 1000;
export const MAINTENANCE_RETRY_AFTER_SECONDS = 300;

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

/**
 * Parses a comma-separated list of Soroban RPC URLs, validating each entry is
 * an http(s) URL. Falls back to the default testnet RPC when unset.
 */
export function parseRpcUrls(value: string | undefined): string[] {
  const raw = configured(value);
  if (raw === undefined) {
    return [DEFAULT_SOROBAN_RPC_URL];
  }

  const urls = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (urls.length === 0) {
    return [DEFAULT_SOROBAN_RPC_URL];
  }

  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`SOROBAN_RPC_URL contains invalid URL "${url}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`SOROBAN_RPC_URL must use http:// or https://, received "${url}"`);
    }
  }

  return urls;
}

function positiveIntSchema(name: string, defaultValue: number) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const raw = configured(value);
      if (raw === undefined) return defaultValue;
      if (!/^\d+$/.test(raw)) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a positive integer, received "${raw}"`,
        });
        return z.NEVER;
      }
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a positive integer, received "${raw}"`,
        });
        return z.NEVER;
      }
      return parsed;
    });
}

function nonNegativeIntSchema(name: string, defaultValue: number) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const raw = configured(value);
      if (raw === undefined) return defaultValue;
      if (!/^\d+$/.test(raw)) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a non-negative integer, received "${raw}"`,
        });
        return z.NEVER;
      }
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a non-negative integer, received "${raw}"`,
        });
        return z.NEVER;
      }
      return parsed;
    });
}

function optionalPositiveIntSchema(name: string) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const raw = configured(value);
      if (raw === undefined) return undefined;
      if (!/^\d+$/.test(raw)) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a positive integer, received "${raw}"`,
        });
        return z.NEVER;
      }
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a positive integer, received "${raw}"`,
        });
        return z.NEVER;
      }
      return parsed;
    });
}

function durationSchema(name: string, defaultValue: string) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      const raw = configured(value);
      if (raw === undefined) return defaultValue;
      const match = DURATION_PATTERN.exec(raw);
      const amount = match === null ? Number.NaN : Number(match[1]);
      if (match === null || !Number.isFinite(amount) || amount <= 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a positive duration such as "1 minute" or "10000", received "${raw}"`,
        });
        return z.NEVER;
      }
      return raw;
    });
}

export const configSchema = z.object({
  NODE_ENV: z
    .string()
    .optional()
    .transform((v) => configured(v) ?? 'development')
    .pipe(z.enum(['development', 'production', 'test'])),
  PORT: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return parsePort(value);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    }),
  DATABASE_URL: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => configured(v) ?? 'info'),
  BODY_LIMIT_BYTES: positiveIntSchema('BODY_LIMIT_BYTES', DEFAULT_BODY_LIMIT_BYTES),
  RATE_LIMIT_MAX: positiveIntSchema('RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX),
  RATE_LIMIT_WINDOW: durationSchema('RATE_LIMIT_WINDOW', DEFAULT_RATE_LIMIT_WINDOW),
  RATE_LIMIT_APPLICATION_MAX: positiveIntSchema(
    'RATE_LIMIT_APPLICATION_MAX',
    DEFAULT_RATE_LIMIT_APPLICATION_MAX,
  ),
  RATE_LIMIT_APPLICATION_WINDOW: durationSchema(
    'RATE_LIMIT_APPLICATION_WINDOW',
    DEFAULT_RATE_LIMIT_APPLICATION_WINDOW,
  ),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((value) => {
      const raw = configured(value) ?? DEFAULT_CORS_ORIGIN;
      return raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
    }),
  METRICS_TOKEN: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  HEALTH_CHECK_TIMEOUT_MS: positiveIntSchema(
    'HEALTH_CHECK_TIMEOUT_MS',
    DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  ),
  INDEXER_LAG_THRESHOLD: nonNegativeIntSchema(
    'INDEXER_LAG_THRESHOLD',
    DEFAULT_INDEXER_LAG_THRESHOLD,
  ),
  INDEXER_POLL_INTERVAL_MS: positiveIntSchema(
    'INDEXER_POLL_INTERVAL_MS',
    DEFAULT_INDEXER_POLL_INTERVAL_MS,
  ),
  INDEXER_START_LEDGER: optionalPositiveIntSchema('INDEXER_START_LEDGER'),
  INDEXER_MAX_EVENTS_PER_POLL: optionalPositiveIntSchema('INDEXER_MAX_EVENTS_PER_POLL'),
  SOROBAN_RPC_URL: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return parseRpcUrls(value);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    }),
  STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  NGO_REGISTRY_CONTRACT_ID: z
    .string()
    .optional()
    .transform((v) => configured(v) ?? ''),
  DONATION_VAULT_CONTRACT_ID: z
    .string()
    .optional()
    .transform((v) => configured(v) ?? ''),
  WATCHED_CONTRACT_IDS: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  CONTRACT_IDS: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  ADMIN_ADDRESSES: z
    .string()
    .optional()
    .transform((v) => configured(v) ?? ''),
  ADMIN_ADDRESS: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  LOG_RETENTION_DAYS: positiveIntSchema('LOG_RETENTION_DAYS', DEFAULT_LOG_RETENTION_DAYS),
  RESEND_API_KEY: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  NOTIFY_EMAIL_FROM: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  API_PUBLIC_URL: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  NOTIFY_WEBHOOK_TIMEOUT_MS: positiveIntSchema(
    'NOTIFY_WEBHOOK_TIMEOUT_MS',
    DEFAULT_NOTIFY_WEBHOOK_TIMEOUT_MS,
  ),
  NOTIFY_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  NOTIFY_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((v) => configured(v)),
  MAINTENANCE_MODE: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return parseMaintenanceMode(value);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    }),
  SLOW_REQUEST_THRESHOLD_MS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return parseSlowRequestThresholdMs(value);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    }),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Validates every application setting at once and returns typed values.
 * Throws a `ConfigError` listing every invalid variable when validation fails.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path && !issue.message.startsWith(path) ? `${path}: ${issue.message}` : issue.message;
    });
    throw new ConfigError(issues);
  }
  return result.data;
}

/**
 * Validates MAINTENANCE_MODE. Only `true`/`false`/`1`/`0` are accepted, so a
 * typo fails startup instead of silently leaving writes open.
 */
export function parseMaintenanceMode(value: string | undefined): boolean {
  const raw = configured(value)?.toLowerCase();
  if (raw === undefined || raw === 'false' || raw === '0') {
    return false;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  throw new Error(`MAINTENANCE_MODE must be "true" or "false", received "${value?.trim()}"`);
}

/**
 * Validates SLOW_REQUEST_THRESHOLD_MS: requests slower than this are logged
 * as warnings. `0` turns the warning off.
 */
export function parseSlowRequestThresholdMs(value: string | undefined): number {
  const raw = configured(value);
  if (raw === undefined) {
    return DEFAULT_SLOW_REQUEST_THRESHOLD_MS;
  }

  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(
      `SLOW_REQUEST_THRESHOLD_MS must be a non-negative integer (milliseconds), received "${raw}"`,
    );
  }

  return Number(raw);
}
