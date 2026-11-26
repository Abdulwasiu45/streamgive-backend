import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const PUBLIC_MAX_AGE_SECONDS = 30;

function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  const candidates = Array.isArray(header) ? header : (header?.split(',') ?? []);
  return candidates.some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, '');
    return normalized === '*' || normalized === etag;
  });
}

/** Send a public JSON representation with a validator and short shared-cache lifetime. */
export function sendPublicCacheable<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: T,
): FastifyReply {
  // Serialise once, then hash and send the same bytes. An ETag validates the
  // representation that is actually on the wire, so it has to be computed
  // over exactly what the client receives. Passing `payload` to
  // `reply.send()` also made Fastify serialise it a second time: double the
  // work on every cacheable response, and a validator hashed over bytes that
  // are only *usually* identical to the ones sent (a `toJSON` with state, or
  // a route-level response schema, changes the second serialisation).
  const body = JSON.stringify(payload) ?? '';
  const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;

  reply
    .header('Cache-Control', `public, max-age=${PUBLIC_MAX_AGE_SECONDS}, stale-while-revalidate=60`)
    .header('ETag', etag);

  if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
    // A 304 must carry the same Vary as the 200 it stands in for (RFC 9110
    // §15.4.5). The compression plugin only adds `Accept-Encoding` when it
    // encodes a body, and a 304 has none, so add it here; otherwise a shared
    // cache could pair a gzip body with a client that cannot decode it.
    const vary = reply.getHeader('vary');
    const existing = Array.isArray(vary) ? vary.join(', ') : vary ? String(vary) : '';
    if (!/(^|,)\s*accept-encoding\s*(,|$)/i.test(existing)) {
      reply.header('Vary', existing ? `${existing}, Accept-Encoding` : 'Accept-Encoding');
    }
    return reply.code(304).send();
  }

  // `body` is already JSON: send the string with the JSON content type so
  // Fastify passes it through instead of serialising the value again.
  return reply.type('application/json; charset=utf-8').send(body);
}
