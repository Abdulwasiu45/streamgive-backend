import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  DEFAULT_RATE_LIMIT_APPLICATION_MAX,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW,
  DEFAULT_SOROBAN_RPC_URL,
  parseConfig,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_STREAM_RUNNING_LOW_DAYS,
  parseMaintenanceMode,
  parsePort,
  parseRateLimitMax,
  parseRateLimitWindow,
  parseRpcUrls,
  parseShutdownTimeoutMs,
} from '../src/config.js';

describe('parseMaintenanceMode', () => {
  it('is off when unset or false', () => {
    for (const value of [undefined, '', '  ', 'false', 'FALSE', '0']) {
      expect(parseMaintenanceMode(value)).toBe(false);
    }
  });

  it('is on for true or 1', () => {
    for (const value of ['true', ' True ', '1']) {
      expect(parseMaintenanceMode(value)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const value of ['yes', 'on', '2', 'tru']) {
      expect(() => parseMaintenanceMode(value)).toThrow(/MAINTENANCE_MODE/);
    }
  });
});

describe('parsePort', () => {
  it('uses the default when the value is unset, empty or whitespace', () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(parsePort('')).toBe(DEFAULT_PORT);
    expect(parsePort('   ')).toBe(DEFAULT_PORT);
  });

  it('accepts integers in the TCP port range', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('3000')).toBe(3000);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort(' 8080 ')).toBe(8080);
  });

  it('rejects values outside the range or not an integer', () => {
    for (const value of ['0', '65536', '-1', '3000.5', 'abc', '1e3', '0x10']) {
      expect(() => parsePort(value)).toThrow(/PORT/);
    }
  });

  it('names the variable and quotes the offending value', () => {
    expect(() => parsePort('abc')).toThrow(
      'PORT must be an integer between 1 and 65535, received "abc"',
    );
  });
});

describe('parseRateLimitMax', () => {
  it('uses the default when the value is unset, empty or whitespace', () => {
    expect(parseRateLimitMax(undefined)).toBe(DEFAULT_RATE_LIMIT_MAX);
    expect(parseRateLimitMax('')).toBe(DEFAULT_RATE_LIMIT_MAX);
    expect(parseRateLimitMax('  ')).toBe(DEFAULT_RATE_LIMIT_MAX);
  });

  it('accepts positive integers', () => {
    expect(parseRateLimitMax('1')).toBe(1);
    expect(parseRateLimitMax('100')).toBe(100);
  });

  it('rejects a non-numeric max', () => {
    expect(() => parseRateLimitMax('abc')).toThrow(/RATE_LIMIT_MAX/);
  });

  it('rejects a zero max', () => {
    expect(() => parseRateLimitMax('0')).toThrow(/RATE_LIMIT_MAX/);
  });

  it('rejects negatives and fractions', () => {
    expect(() => parseRateLimitMax('-1')).toThrow(/RATE_LIMIT_MAX/);
    expect(() => parseRateLimitMax('1.5')).toThrow(/RATE_LIMIT_MAX/);
  });
});

describe('parseRateLimitWindow', () => {
  it('uses the default when the value is unset, empty or whitespace', () => {
    expect(parseRateLimitWindow(undefined)).toBe(DEFAULT_RATE_LIMIT_WINDOW);
    expect(parseRateLimitWindow('')).toBe(DEFAULT_RATE_LIMIT_WINDOW);
    expect(parseRateLimitWindow('  ')).toBe(DEFAULT_RATE_LIMIT_WINDOW);
  });

  it('accepts bare milliseconds and human durations', () => {
    expect(parseRateLimitWindow('10000')).toBe('10000');
    expect(parseRateLimitWindow('1 minute')).toBe('1 minute');
    expect(parseRateLimitWindow(' 30s ')).toBe('30s');
    expect(parseRateLimitWindow('2 hours')).toBe('2 hours');
  });

  it('rejects an unparseable window', () => {
    expect(() => parseRateLimitWindow('fortnight')).toThrow(/RATE_LIMIT_WINDOW/);
    expect(() => parseRateLimitWindow('1 fortnight')).toThrow(/RATE_LIMIT_WINDOW/);
  });

  it('rejects zero and negative durations', () => {
    expect(() => parseRateLimitWindow('0')).toThrow(/RATE_LIMIT_WINDOW/);
    expect(() => parseRateLimitWindow('-5')).toThrow(/RATE_LIMIT_WINDOW/);
  });
});

describe('parseRpcUrls', () => {
  it('uses the default testnet RPC when unset or blank', () => {
    expect(parseRpcUrls(undefined)).toEqual([DEFAULT_SOROBAN_RPC_URL]);
    expect(parseRpcUrls('')).toEqual([DEFAULT_SOROBAN_RPC_URL]);
    expect(parseRpcUrls(' , , ')).toEqual([DEFAULT_SOROBAN_RPC_URL]);
  });

  it('parses a comma-separated list of http(s) URLs in order', () => {
    expect(
      parseRpcUrls('https://rpc-1.example.com, https://rpc-2.example.com, http://localhost:8000'),
    ).toEqual(['https://rpc-1.example.com', 'https://rpc-2.example.com', 'http://localhost:8000']);
  });

  it('rejects invalid or non-http(s) URLs', () => {
    expect(() => parseRpcUrls('not-a-url')).toThrow(/SOROBAN_RPC_URL/);
    expect(() => parseRpcUrls('https://ok.example.com, ftp://bad.example.com')).toThrow(
      /SOROBAN_RPC_URL/,
    );
  });
});

describe('parseConfig', () => {
  it('returns typed defaults when environment is empty', () => {
    const cfg = parseConfig({});
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(DEFAULT_PORT);
    expect(cfg.RATE_LIMIT_MAX).toBe(DEFAULT_RATE_LIMIT_MAX);
    expect(cfg.RATE_LIMIT_WINDOW).toBe(DEFAULT_RATE_LIMIT_WINDOW);
    expect(cfg.SOROBAN_RPC_URL).toEqual([DEFAULT_SOROBAN_RPC_URL]);
    expect(cfg.STREAM_RUNNING_LOW_DAYS).toBe(DEFAULT_STREAM_RUNNING_LOW_DAYS);
  });

  it('reports every invalid variable at once in a ConfigError', () => {
    let caught: unknown;
    try {
      parseConfig({
        NODE_ENV: 'staging',
        PORT: 'not-a-port',
        RATE_LIMIT_MAX: '0',
        RATE_LIMIT_WINDOW: 'fortnight',
        SOROBAN_RPC_URL: 'ftp://invalid.example.com',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.issues).toHaveLength(5);
    expect(error.message).toContain('NODE_ENV');
    expect(error.message).toContain('PORT');
    expect(error.message).toContain('RATE_LIMIT_MAX');
    expect(error.message).toContain('RATE_LIMIT_WINDOW');
    expect(error.message).toContain('SOROBAN_RPC_URL');
  });
});

describe('parseConfig numeric settings', () => {
  it('defaults RATE_LIMIT_APPLICATION_MAX and HEALTH_CHECK_TIMEOUT_MS when unset or blank', () => {
    for (const env of [{}, { RATE_LIMIT_APPLICATION_MAX: '  ', HEALTH_CHECK_TIMEOUT_MS: '' }]) {
      const cfg = parseConfig(env);
      expect(cfg.RATE_LIMIT_APPLICATION_MAX).toBe(DEFAULT_RATE_LIMIT_APPLICATION_MAX);
      expect(cfg.HEALTH_CHECK_TIMEOUT_MS).toBe(DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
    }
  });

  it('accepts positive integers', () => {
    const cfg = parseConfig({ RATE_LIMIT_APPLICATION_MAX: '8', HEALTH_CHECK_TIMEOUT_MS: '5000' });
    expect(cfg.RATE_LIMIT_APPLICATION_MAX).toBe(8);
    expect(cfg.HEALTH_CHECK_TIMEOUT_MS).toBe(5000);
  });

  it.each(['invalid', '0', '-1', '1.5', '5s'])(
    'rejects %s for RATE_LIMIT_APPLICATION_MAX and HEALTH_CHECK_TIMEOUT_MS with a clear error',
    (value) => {
      expect(() => parseConfig({ RATE_LIMIT_APPLICATION_MAX: value })).toThrow(
        `RATE_LIMIT_APPLICATION_MAX must be a positive integer, received "${value}"`,
      );
      expect(() => parseConfig({ HEALTH_CHECK_TIMEOUT_MS: value })).toThrow(
        `HEALTH_CHECK_TIMEOUT_MS must be a positive integer, received "${value}"`,
      );
    },
  );

  it('accepts a positive stream running-low threshold and rejects invalid values', () => {
    expect(parseConfig({ STREAM_RUNNING_LOW_DAYS: '14' }).STREAM_RUNNING_LOW_DAYS).toBe(14);
    for (const value of ['invalid', '0', '-1', '1.5']) {
      expect(() => parseConfig({ STREAM_RUNNING_LOW_DAYS: value })).toThrow(
        `STREAM_RUNNING_LOW_DAYS must be a positive integer, received "${value}"`,
      );
    }
  });
});

describe('parseShutdownTimeoutMs', () => {
  it('uses the default for unset or blank values', () => {
    expect(parseShutdownTimeoutMs(undefined)).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect(parseShutdownTimeoutMs('')).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });

  it('accepts a positive integer number of milliseconds', () => {
    expect(parseShutdownTimeoutMs('12000')).toBe(12000);
  });

  it('rejects invalid or non-positive values', () => {
    for (const value of ['abc', '0', '-1', '1.5', '9007199254740992']) {
      expect(() => parseShutdownTimeoutMs(value)).toThrow(/SHUTDOWN_TIMEOUT_MS/);
    }
  });
});
