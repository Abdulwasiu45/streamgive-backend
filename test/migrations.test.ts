import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { Client } from 'pg';
import { Prisma } from '../src/generated/prisma/client.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const EXPECTED_TABLES = Prisma.dmmf.datamodel.models.map((model) => ({
  table: model.dbName ?? model.name,
  columns: model.fields
    .filter((field) => field.kind !== 'object')
    .map((field) => field.dbName ?? field.name),
}));

/** Tables managed by Prisma Migrate itself — not part of the app schema. */
const PRISMA_INTERNAL_TABLES = new Set(['_prisma_migrations']);

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');

function findSchemaDrift(
  expectedTables: readonly { table: string; columns: readonly string[] }[],
  actualTables: ReadonlySet<string>,
  actualColumns: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const drift: string[] = [];

  for (const { table, columns } of expectedTables) {
    if (!actualTables.has(table)) {
      drift.push(`Table "${table}" is missing`);
      continue;
    }

    const actual = actualColumns.get(table) ?? new Set();
    for (const column of columns) {
      if (!actual.has(column)) {
        drift.push(`Column "${table}"."${column}" is missing`);
      }
    }
  }

  const expectedTableNames = new Set(expectedTables.map(({ table }) => table));
  for (const table of actualTables) {
    if (!expectedTableNames.has(table)) {
      drift.push(`Table "${table}" exists in the database but is not declared in schema.prisma`);
    }
  }

  return drift;
}

describe('Prisma schema and migrations', () => {
  let client: Client;
  let dbAvailable = false;

  it('detects a deliberately missing schema column', () => {
    expect(
      findSchemaDrift(
        [{ table: 'donors', columns: ['id', 'address'] }],
        new Set(['donors']),
        new Map([['donors', new Set(['id'])]]),
      ),
    ).toEqual(['Column "donors"."address" is missing']);
  });

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) return;

    client = new Client({ connectionString: url });
    try {
      await client.connect();
      dbAvailable = true;
    } catch {
      // Postgres is not running — tests will be skipped below.
    }
  }, 10_000);

  it(
    'applying all migrations to an empty database produces no drift against schema.prisma',
    async () => {
      if (!dbAvailable) {
        console.warn(
          '[skip] Postgres is not reachable — skipping migration drift check.\n' +
            '       Run `docker compose up -d postgres` and re-run the tests to enable it.',
        );
        return;
      }

      // ------------------------------------------------------------------
      // Step 1: wipe the public schema and re-create it so we start fresh.
      // This is safe because the test suite always uses the dedicated
      // streamgive_test database, never the development one.
      // ------------------------------------------------------------------
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');

      // ------------------------------------------------------------------
      // Step 2: apply every migration SQL file in chronological order.
      // We run them in the same order Prisma would: sorted by directory name
      // (which starts with a timestamp).
      // ------------------------------------------------------------------
      const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
      const migrationDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      for (const dir of migrationDirs) {
        const sqlPath = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
        let sql: string;
        try {
          sql = await readFile(sqlPath, 'utf8');
        } catch {
          // Directory exists but has no migration.sql (e.g. a baseline-only
          // folder).  Skip it.
          continue;
        }
        try {
          await client.query(sql);
        } catch (err) {
          throw new Error(
            `Migration ${dir} failed to apply:\n${(err as Error).message}\n\n` +
              'Fix the SQL in the migration file or regenerate the migration with ' +
              '`prisma migrate dev`.',
            { cause: err },
          );
        }
      }

      // ------------------------------------------------------------------
      // Step 3: inspect the resulting database and compare against the
      // expected shape derived from schema.prisma.
      // ------------------------------------------------------------------

      // 3a. Collect actual tables in the public schema.
      const tablesResult = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      const actualTables = new Set(
        tablesResult.rows.map((r) => r.table_name).filter((t) => !PRISMA_INTERNAL_TABLES.has(t)),
      );

      // 3b. Collect actual columns per table.
      const colsResult = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'`,
      );
      const actualColumns = new Map<string, Set<string>>();
      for (const { table_name, column_name } of colsResult.rows) {
        if (!actualColumns.has(table_name)) actualColumns.set(table_name, new Set());
        actualColumns.get(table_name)!.add(column_name);
      }

      // 3c. Compare the database shape against the Prisma schema metadata.
      const missing = findSchemaDrift(EXPECTED_TABLES, actualTables, actualColumns);

      expect(
        missing,
        'Migration drift detected between migrations and schema.prisma.\n' +
          'Run `prisma migrate dev` to generate a migration for the pending changes.\n\n' +
          missing.join('\n'),
      ).toHaveLength(0);
    },
    60_000,
  );

  // Clean up the connection after all tests in this file have run.
  // We intentionally do not restore the schema — resetDb() in other test
  // files truncates tables rather than dropping schemas, and this test
  // always runs in its own file (fileParallelism: false in vitest.config.ts).
  // The next test run will wipe and re-apply anyway.
  afterAll(async () => {
    if (dbAvailable) await client.end();
  });
});
