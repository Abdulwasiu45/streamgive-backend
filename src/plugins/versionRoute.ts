import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { getBuildVersionInfo } from '../version.js';

export const versionRoutePlugin = fp(async function versionRoutePlugin(app: FastifyInstance) {
  /**
   * Returns build metadata (package version, git commit, and build time) with no secrets.
   * @route GET /version
   * @auth Public
   */
  app.register(async (versionRoutes) => {
    versionRoutes.get(
      '/version',
      {
        schema: {
          tags: ['System'],
          summary: 'Get build version and commit metadata',
          response: {
            200: {
              type: 'object',
              properties: {
                version: { type: 'string' },
                commit: { type: 'string' },
                buildTime: { type: 'string', nullable: true },
              },
              required: ['version', 'commit', 'buildTime'],
            },
          },
        },
      },
      async () => getBuildVersionInfo(),
    );
  });
});
