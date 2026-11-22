import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import packageJson from '../../package.json' with { type: 'json' };

import { requireAdminSignature } from '../middleware/adminAuth.js';

export const openApiPlugin = fp(async function openApiPlugin(app: FastifyInstance) {
  app.register(swagger, {
    openapi: {
      info: {
        title: 'StreamGive API',
        description: 'API for the StreamGive platform',
        version: packageJson.version,
      },
      components: {
        securitySchemes: {
          AdminAddress: { type: 'apiKey', in: 'header', name: 'x-admin-address' },
          AdminSignature: { type: 'apiKey', in: 'header', name: 'x-admin-signature' },
          AdminTimestamp: { type: 'apiKey', in: 'header', name: 'x-admin-timestamp' },
        },
      },
      tags: [
        { name: 'Health', description: 'Service health checks' },
        { name: 'NGOs', description: 'NGO directory and profiles' },
      ],
    },
  });

  if (process.env.NODE_ENV !== 'production') {
    app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: false },
    });
  }

  app.addHook('onRoute', (route) => {
    const preHandlers = Array.isArray(route.preHandler)
      ? route.preHandler
      : route.preHandler
        ? [route.preHandler]
        : [];
    if (preHandlers.includes(requireAdminSignature)) {
      route.config = { ...route.config, adminRateLimit: true };
      route.schema = {
        ...route.schema,
        security: [
          {
            AdminAddress: [],
            AdminSignature: [],
            AdminTimestamp: [],
          },
        ],
      };
    }

    const schemas: Record<string, object> = {
      '/v1/ngos': {
        tags: ['NGOs'],
        summary: 'List verified NGOs',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            cursor: { type: 'string', format: 'uuid' },
            sort: { type: 'string', enum: ['newest', 'oldest', 'name'], default: 'newest' },
            q: { type: 'string', maxLength: 100 },
          },
        },
      },
      '/v1/ngos/all': {
        tags: ['NGOs'],
        summary: 'List all NGOs for admin review',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            cursor: { type: 'string', format: 'uuid' },
            verified: { type: 'string', enum: ['true', 'false'] },
            q: { type: 'string', maxLength: 100 },
          },
        },
      },
      '/v1/ngos/lookup': {
        tags: ['NGOs'],
        summary: 'Find an NGO by Stellar address',
        querystring: {
          type: 'object',
          properties: { address: { type: 'string', pattern: '^G[A-Z2-7]{55}$' } },
          required: ['address'],
        },
      },
      '/v1/ngos/:id/donors': {
        tags: ['NGOs'],
        summary: 'List donors for an NGO',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string', format: 'uuid' },
          },
        },
      },
      '/v1/ngos/:id': {
        tags: ['NGOs'],
        summary: 'Get an NGO profile and impact totals',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
      '/v1/donors/:address/ngos': {
        tags: ['Donors'],
        summary: 'List distinct NGOs supported by a donor with token-grouped totals',
        params: {
          type: 'object',
          properties: { address: { type: 'string', pattern: '^G[A-Z2-7]{55}$' } },
          required: ['address'],
        },
      },
    };
    const schema = schemas[route.url];
    if (schema) route.schema = { ...route.schema, ...schema };
  });
});
