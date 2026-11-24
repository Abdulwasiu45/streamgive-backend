import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';

const SEP53_PREFIX = 'Stellar Signed Message:\n';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function main(): void {
  const secret = requiredEnv('ADMIN_SECRET');
  const target = new URL(
    process.env.ADMIN_REQUEST_URL ?? 'http://localhost:3000/v1/ngo-applications?status=PENDING',
  );
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error('ADMIN_REQUEST_URL must be an HTTP(S) URL without credentials or a fragment');
  }

  const method = (process.env.ADMIN_REQUEST_METHOD ?? 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw new Error('ADMIN_REQUEST_METHOD must contain only letters');
  }

  const body = process.env.ADMIN_REQUEST_BODY ?? '';
  const timestamp = Date.now().toString();
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const signedUrl = `${target.pathname}${target.search}`;
  const payload = `${method}:${signedUrl}:${timestamp}:${bodyHash}`;
  const messageHash = createHash('sha256')
    .update(SEP53_PREFIX, 'utf8')
    .update(payload, 'utf8')
    .digest();
  const keypair = Keypair.fromSecret(secret);
  const signature = Buffer.from(keypair.sign(messageHash)).toString('base64');

  const command = [
    'curl',
    '--request',
    shellQuote(method),
    '--url',
    shellQuote(target.href),
    '--header',
    shellQuote(`x-admin-address: ${keypair.publicKey()}`),
    '--header',
    shellQuote(`x-admin-timestamp: ${timestamp}`),
    '--header',
    shellQuote(`x-admin-signature: ${signature}`),
  ];
  if (body) {
    command.push('--header', shellQuote('content-type: application/json'));
    command.push('--data-raw', shellQuote(body));
  }

  console.log(command.join(' '));
}

main();
