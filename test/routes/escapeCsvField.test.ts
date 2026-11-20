import { describe, expect, it } from 'vitest';

import { escapeCsvField } from '../../src/routes/donors.js';

describe('escapeCsvField', () => {
  describe('empty values', () => {
    it('returns empty string for null', () => {
      expect(escapeCsvField(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(escapeCsvField(undefined)).toBe('');
    });

    it('returns empty string for empty string', () => {
      expect(escapeCsvField('')).toBe('');
    });
  });

  describe('standard non-empty values', () => {
    it('returns plain string unchanged', () => {
      expect(escapeCsvField('hello')).toBe('hello');
      expect(escapeCsvField('normal text 123')).toBe('normal text 123');
    });

    it('converts numbers to string without modification', () => {
      expect(escapeCsvField(0)).toBe('0');
      expect(escapeCsvField(12345)).toBe('12345');
      expect(escapeCsvField(99.99)).toBe('99.99');
    });

    it('converts booleans to string without modification', () => {
      expect(escapeCsvField(true)).toBe('true');
      expect(escapeCsvField(false)).toBe('false');
    });
  });

  describe('quotes', () => {
    it('wraps fields with double quotes and escapes internal double quotes', () => {
      expect(escapeCsvField('"')).toBe('""""');
      expect(escapeCsvField('""')).toBe('""""""');
      expect(escapeCsvField('he said "hello"')).toBe('"he said ""hello"""');
      expect(escapeCsvField('"quoted"')).toBe('"""quoted"""');
    });
  });

  describe('commas', () => {
    it('wraps fields containing commas in double quotes', () => {
      expect(escapeCsvField('foo,bar')).toBe('"foo,bar"');
      expect(escapeCsvField('a,b,c')).toBe('"a,b,c"');
      expect(escapeCsvField(',')).toBe('","');
    });
  });

  describe('CR and LF (newlines)', () => {
    it('wraps fields containing LF in double quotes', () => {
      expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
      expect(escapeCsvField('\n')).toBe('"\n"');
    });

    it('wraps fields containing CR in double quotes', () => {
      expect(escapeCsvField('line1\rline2')).toBe('"line1\rline2"');
    });

    it('wraps fields containing CRLF in double quotes', () => {
      expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
      expect(escapeCsvField('a\r\n')).toBe('"a\r\n"');
    });
  });

  describe('spreadsheet formula prefixes (=, +, -, @, \\t, \\r)', () => {
    it('prefixes leading equals (=) with a single quote', () => {
      expect(escapeCsvField('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
    });

    it('prefixes leading plus (+) with a single quote', () => {
      expect(escapeCsvField('+12345')).toBe("'+12345");
    });

    it('prefixes leading minus (-) with a single quote', () => {
      expect(escapeCsvField('-500')).toBe("'-500");
    });

    it('prefixes leading at (@) with a single quote', () => {
      expect(escapeCsvField('@mention')).toBe("'@mention");
    });

    it('prefixes leading tab (\\t) with a single quote', () => {
      expect(escapeCsvField('\tdata')).toBe("'\tdata");
    });

    it('prefixes leading CR (\\r) with a single quote and wraps in double quotes due to CR', () => {
      expect(escapeCsvField('\rdata')).toBe('"\'\rdata"');
    });

    it('protects formula prefixes and escapes quotes/commas/newlines when present', () => {
      expect(escapeCsvField('=1+1,2')).toBe('"\'=1+1,2"');
      expect(escapeCsvField('="hello"')).toBe('"\'=""hello"""');
      expect(escapeCsvField('=A1\n+B1')).toBe('"\'=A1\n+B1"');
      expect(escapeCsvField('+foo,bar')).toBe('"\'+foo,bar"');
      expect(escapeCsvField('-foo,bar')).toBe('"\'-foo,bar"');
      expect(escapeCsvField('@foo,bar')).toBe('"\'@foo,bar"');
    });
  });

  describe('combined edge cases', () => {
    it('handles commas, quotes, and newlines in a single field', () => {
      expect(escapeCsvField('Hello,\n"World"')).toBe('"Hello,\n""World"""');
    });
  });
});
