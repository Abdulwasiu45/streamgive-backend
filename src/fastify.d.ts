import 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    adminRateLimit?: boolean;
  }
}
