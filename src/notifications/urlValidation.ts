import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [a, b, c] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  // Only global-unicast IPv6 addresses are accepted. Exclude transition and
  // documentation prefixes, which can encode or disguise non-public targets.
  return (
    (normalized.startsWith('2') || normalized.startsWith('3')) &&
    !normalized.startsWith('2001:db8:') &&
    !normalized.startsWith('2001:0:') &&
    !normalized.startsWith('2002:')
  );
}

/** Allows only HTTPS destinations whose literal or DNS-resolved addresses are public. */
export async function isSafeWebhookUrl(value: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === ''
  ) {
    return false;
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    return false;
  }

  const family = isIP(hostname);
  if (family !== 0) return isPublicAddress(hostname);

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
  } catch {
    return false;
  }
}
