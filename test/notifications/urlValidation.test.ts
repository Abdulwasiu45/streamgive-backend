import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

import { lookup } from 'node:dns/promises';

import { isSafeWebhookUrl } from '../../src/notifications/urlValidation.js';

const resolver = vi.mocked(lookup) as unknown as ReturnType<typeof vi.fn>;
const answer = (...addresses: string[]) =>
  resolver.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

beforeEach(() => {
  resolver.mockReset();
  answer('93.184.216.34');
});

describe('isSafeWebhookUrl', () => {
  it('accepts public IPv4 and IPv6 literals and public hostnames, with or without a port', async () => {
    for (const url of [
      'https://8.8.8.8/hook',
      'https://8.8.8.8:8443/hook',
      'https://[2606:4700:4700::1111]/hook',
      'https://[2a00:1450:4001::200e]:8443/hook',
      'https://hooks.example.com/hook',
      'https://hooks.example.com:8443/hook?x=1',
    ]) {
      expect(await isSafeWebhookUrl(url), url).toBe(true);
    }
  });

  it('rejects private, loopback, link-local, shared and reserved IPv4 literals', async () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.255',
      '127.0.0.1',
      '127.255.255.254',
      '100.64.0.1',
      '100.127.255.255',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(await isSafeWebhookUrl(`https://${ip}/hook`), ip).toBe(false);
    }
  });

  it('accepts addresses just outside the blocked ranges', async () => {
    for (const ip of ['100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '169.253.1.1', '198.17.0.1', '198.20.0.1']) {
      expect(await isSafeWebhookUrl(`https://${ip}/hook`), ip).toBe(true);
    }
  });

  it('rejects loopback, unique-local, link-local, documentation, 6to4 and mapped IPv6 literals', async () => {
    for (const ip of ['::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '2001:db8::1', '2002:c000:204::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
      expect(await isSafeWebhookUrl(`https://[${ip}]/hook`), ip).toBe(false);
    }
  });

  it('rejects numeric host spellings that resolve to a private address', async () => {
    for (const host of ['2130706433', '0x7f000001', '0x7f.1', '127.1', '017700000001']) {
      expect(await isSafeWebhookUrl(`https://${host}/hook`), host).toBe(false);
    }
  });

  it('rejects userinfo, even on a public address', async () => {
    expect(await isSafeWebhookUrl('https://user:pass@8.8.8.8/hook')).toBe(false);
    expect(await isSafeWebhookUrl('https://user@8.8.8.8/hook')).toBe(false);
    expect(await isSafeWebhookUrl('https://:pass@hooks.example.com/hook')).toBe(false);
  });

  it('rejects anything that is not https, and values that are not URLs', async () => {
    for (const url of [
      'http://8.8.8.8/hook',
      'http://hooks.example.com/hook',
      'ftp://8.8.8.8/hook',
      'ws://8.8.8.8/hook',
      'file:///etc/passwd',
      'javascript:alert(1)',
      '//hooks.example.com/hook',
      'hooks.example.com',
      'not a url',
      '',
    ]) {
      expect(await isSafeWebhookUrl(url), url).toBe(false);
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects internal hostnames without asking the resolver', async () => {
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'printer.local', 'db.internal', 'router.home.arpa']) {
      expect(await isSafeWebhookUrl(`https://${host}/hook`), host).toBe(false);
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it('resolves a hostname with the mocked resolver and requires every answer to be public', async () => {
    expect(await isSafeWebhookUrl('https://hooks.example.com/hook')).toBe(true);
    expect(resolver).toHaveBeenCalledWith('hooks.example.com', { all: true, verbatim: true });

    answer('93.184.216.34', '10.0.0.5');
    expect(await isSafeWebhookUrl('https://hooks.example.com/hook')).toBe(false);

    answer('93.184.216.34', '2606:4700:4700::1111');
    expect(await isSafeWebhookUrl('https://hooks.example.com/hook')).toBe(true);

    answer('2606:4700:4700::1111', 'fe80::1');
    expect(await isSafeWebhookUrl('https://hooks.example.com/hook')).toBe(false);
  });

  it('rejects a hostname that resolves to nothing or fails to resolve', async () => {
    resolver.mockResolvedValue([]);
    expect(await isSafeWebhookUrl('https://hooks.example.com/hook')).toBe(false);

    resolver.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await isSafeWebhookUrl('https://missing.example.com/hook')).toBe(false);
  });

  it('does not resolve IP literals', async () => {
    await isSafeWebhookUrl('https://8.8.8.8/hook');
    await isSafeWebhookUrl('https://[2606:4700:4700::1111]/hook');
    expect(resolver).not.toHaveBeenCalled();
  });
});
