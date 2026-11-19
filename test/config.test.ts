import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW,
  parsePort,
  parseRateLimitMax,
  parseRateLimitWindow,
} from '../src/config.js';

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
