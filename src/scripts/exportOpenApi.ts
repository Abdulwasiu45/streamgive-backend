import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildServer } from '../server.js';

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
  console.log(`Exported OpenAPI document to ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
