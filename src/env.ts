// src/env.ts
import { z } from 'zod';

import { logger } from './logger.js';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required and must be a valid connection string'),
  PORT: z.coerce.number().positive('PORT must be a positive number').default(3000),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().positive('INDEXER_POLL_INTERVAL_MS must be a positive number').default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    logger.error('Configuration Error: Invalid or missing environment variables');
    const formattedErrors = result.error.format();

    for (const [key, value] of Object.entries(formattedErrors)) {
      if (key !== '_errors' && typeof value === 'object' && value !== null && '_errors' in value) {
        const errs = (value as { _errors: string[] })._errors;
        if (errs.length > 0) {
          logger.error({ key, errors: errs }, 'Invalid environment variable');
        }
      }
    }
    logger.error('Please check your .env file or environment configuration');
    process.exit(1);
  }

  return result.data;
}

export const env = validateEnv();
export type Environment = z.infer<typeof envSchema>;