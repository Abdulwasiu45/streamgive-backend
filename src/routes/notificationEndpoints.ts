import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { recordAdminAction } from '../audit/adminAudit.js';
import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';
import { sendWebhookPing } from '../notifications/service.js';
import { NOTIFICATION_EVENT_TYPES } from '../notifications/types.js';
import { isSafeWebhookUrl } from '../notifications/urlValidation.js';

const eventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);

const createBodySchema = z.object({
  url: z.string().url().max(2048),
  secret: z.string().min(1).max(4096),
  eventTypes: z.array(eventTypeSchema).max(NOTIFICATION_EVENT_TYPES.length),
  enabled: z.boolean().default(true),
});

const updateBodySchema = z
  .object({
    url: z.string().url().max(2048).optional(),
    secret: z.string().min(1).max(4096).optional(),
    eventTypes: z.array(eventTypeSchema).max(NOTIFICATION_EVENT_TYPES.length).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

const idParamsSchema = z.object({ id: z.string().uuid() });

function publicEndpoint(endpoint: {
  id: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  secret: string;
}) {
  const { id, url, eventTypes, enabled, createdAt, updatedAt } = endpoint;
  return { id, url, eventTypes, enabled, createdAt, updatedAt };
}

export async function notificationEndpointRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/notification-endpoints',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'List notification endpoints',
        response: {
          200: { type: 'array', items: { type: 'object', additionalProperties: true } },
          401: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async () => {
      const endpoints = await prisma.notificationEndpoint.findMany({
        orderBy: { createdAt: 'desc' },
      });
      return endpoints.map(publicEndpoint);
    },
  );

  app.post(
    '/admin/notification-endpoints',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'Create a notification endpoint',
        body: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri', maxLength: 2048 },
            secret: { type: 'string', minLength: 1, maxLength: 4096 },
            eventTypes: {
              type: 'array',
              items: { type: 'string', enum: [...NOTIFICATION_EVENT_TYPES] },
            },
            enabled: { type: 'boolean', default: true },
          },
          required: ['url', 'secret', 'eventTypes'],
          additionalProperties: false,
        },
        response: {
          201: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          401: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      if (!(await isSafeWebhookUrl(parsed.data.url))) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const adminAddress = request.headers['x-admin-address'];
      if (typeof adminAddress !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const endpoint = await prisma.$transaction(async (tx) => {
        const created = await tx.notificationEndpoint.create({ data: parsed.data });
        await recordAdminAction(
          tx,
          adminAddress,
          'notification_endpoint.created',
          created.id,
          'Created notification endpoint',
        );
        return created;
      });
      return reply.code(201).send(publicEndpoint(endpoint));
    },
  );

  app.patch(
    '/admin/notification-endpoints/:id',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'Update a notification endpoint',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri', maxLength: 2048 },
            secret: { type: 'string', minLength: 1, maxLength: 4096 },
            eventTypes: {
              type: 'array',
              items: { type: 'string', enum: [...NOTIFICATION_EVENT_TYPES] },
            },
            enabled: { type: 'boolean' },
          },
          minProperties: 1,
          additionalProperties: false,
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          401: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      const parsedBody = updateBodySchema.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      if (parsedBody.data.url && !(await isSafeWebhookUrl(parsedBody.data.url))) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const adminAddress = request.headers['x-admin-address'];
      if (typeof adminAddress !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const endpoint = await prisma.$transaction(async (tx) => {
        const exists = await tx.notificationEndpoint.findUnique({
          where: { id: parsedParams.data.id },
          select: { id: true },
        });
        if (!exists) return null;

        const updated = await tx.notificationEndpoint.update({
          where: { id: parsedParams.data.id },
          data: parsedBody.data,
        });
        await recordAdminAction(
          tx,
          adminAddress,
          'notification_endpoint.updated',
          updated.id,
          'Updated notification endpoint',
        );
        return updated;
      });
      if (!endpoint) return reply.code(404).send({ error: 'not_found' });
      return publicEndpoint(endpoint);
    },
  );

  /**
   * Sends a signed `ping` event to one endpoint and reports how it answered.
   * Not retried and not recorded as a delivery.
   * @route POST /v1/admin/notification-endpoints/:id/test
   * @returns 200 `{ ok, statusCode, latencyMs, deliveryId, error? }`; 404 unknown endpoint.
   */
  app.post(
    '/admin/notification-endpoints/:id/test',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'Send a test ping to a notification endpoint',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          401: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const endpoint = await prisma.notificationEndpoint.findUnique({
        where: { id: parsedParams.data.id },
        select: { id: true, url: true, secret: true },
      });
      if (!endpoint) return reply.code(404).send({ error: 'not_found' });

      const result = await sendWebhookPing(endpoint);
      const adminAddress = request.headers['x-admin-address'];
      if (typeof adminAddress !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      await recordAdminAction(
        prisma,
        adminAddress,
        'notification_endpoint.tested',
        endpoint.id,
        'Sent notification endpoint test ping',
      );
      return result;
    },
  );

  app.delete(
    '/admin/notification-endpoints/:id',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'Delete a notification endpoint',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          204: { type: 'null' },
          400: { type: 'object', additionalProperties: true },
          401: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const adminAddress = request.headers['x-admin-address'];
      if (typeof adminAddress !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const deleted = await prisma.$transaction(async (tx) => {
        const result = await tx.notificationEndpoint.deleteMany({
          where: { id: parsedParams.data.id },
        });
        if (result.count > 0) {
          await recordAdminAction(
            tx,
            adminAddress,
            'notification_endpoint.deleted',
            parsedParams.data.id,
            'Deleted notification endpoint',
          );
        }
        return result;
      });
      if (deleted.count === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    },
  );
}
