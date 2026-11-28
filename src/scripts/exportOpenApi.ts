import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildServer } from '../server.js';
import { createScriptLogger } from './logger.js';

const logger = createScriptLogger({ json: process.argv.includes('--json') });

export async function generateOpenApiDocument(): Promise<Record<string, unknown>> {
  const app = buildServer();
  await app.ready();
  try {
    return app.swagger() as unknown as Record<string, unknown>;
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const outputPath = resolve(process.cwd(), 'openapi.json');
  const doc = await generateOpenApiDocument();
  writeFileSync(outputPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  logger.info('Exported OpenAPI document', { path: outputPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    logger.error('Export failed', { error: String(err) });
    process.exit(1);
  });
}
