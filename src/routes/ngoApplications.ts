import type { FastifyInstance } from 'fastify';

import { ngoApplicationAdminRoutes } from './ngoApplications/admin.js';
import { ngoApplicationContactVerificationRoutes } from './ngoApplications/contactVerification.js';
import { ngoApplicationStatusRoutes } from './ngoApplications/status.js';
import { ngoApplicationSubmissionRoutes } from './ngoApplications/submission.js';

export { MAX_APPLICATION_LIST_OFFSET } from './ngoApplications/shared.js';

export async function ngoApplicationRoutes(app: FastifyInstance): Promise<void> {
  await ngoApplicationSubmissionRoutes(app);
  await ngoApplicationContactVerificationRoutes(app);
  await ngoApplicationStatusRoutes(app);
  await ngoApplicationAdminRoutes(app);
}
