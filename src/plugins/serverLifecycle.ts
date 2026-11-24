import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

interface ServerLifecycleOptions {
  bodyLimit: number;
}

export const serverLifecyclePlugin = fp(async function serverLifecyclePlugin(
  app: FastifyInstance,
  { bodyLimit }: ServerLifecycleOptions,
) {
  // Capture the raw request body before Fastify parses it so the admin
  // signature middleware can hash the exact bytes the client sent.
  // `request.rawBody` is not populated by default in Fastify; we attach
  // it via a preParsing hook so it's available by the time any route
  // handler (or preHandler hook like requireAdminSignature) runs.
  //
  // Only consume the payload for methods that can carry a body. For
  // bodyless methods (GET, HEAD, DELETE, OPTIONS) the payload stream may
  // not emit an 'end' event in all Fastify versions, causing the
  // `for await` to hang. Bodyless requests get an empty Buffer so the
  // body-hash in the admin signature is always the SHA-256 of zero bytes.
  app.addHook('preParsing', async (request, _reply, payload) => {
    const bodylessMethods = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);
    if (bodylessMethods.has(request.method)) {
      (request as typeof request & { rawBody: Buffer }).rawBody = Buffer.alloc(0);
      return payload;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    for await (const chunk of payload) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      receivedBytes += bytes.length;
      if (receivedBytes > bodyLimit) {
        const error = new Error('Request body is too large.') as FastifyError;
        error.statusCode = 413;
        throw error;
      }
      chunks.push(bytes);
    }
    const raw = Buffer.concat(chunks);
    (request as typeof request & { rawBody: Buffer }).rawBody = raw;
    // Re-create a readable stream from the captured bytes so Fastify can
    // still parse the body normally after we've consumed the original stream.
    const { Readable } = await import('node:stream');
    return Readable.from(raw);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    const candidateStatusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const statusCode =
      typeof candidateStatusCode === 'number' &&
      candidateStatusCode >= 400 &&
      candidateStatusCode < 600
        ? candidateStatusCode
        : 500;
    const errorString =
      statusCode === 404
        ? 'not_found'
        : statusCode === 400
          ? 'invalid_request'
          : statusCode === 413
            ? 'payload_too_large'
            : statusCode === 415
              ? 'unsupported_media_type'
              : statusCode === 429
                ? 'rate_limited'
                : 'internal_server_error';
    reply.code(statusCode).send({ error: errorString });
  });

  // Fastify's default 404 body is `{ message, error, statusCode }`, while
  // every route-level 404 in this API returns `{ error: 'not_found' }`.
  // Clients should only need one parser, so use the same shape here.
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: 'not_found' });
  });
});
