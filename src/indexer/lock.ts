import { Client } from 'pg';

import { getDatabaseUrl } from '../db.js';

const LOCK_CLASS_ID = 1_398_038_612;
const LOCK_OBJECT_ID = 1;

export interface IndexerLock {
  isHeld(): boolean;
  release(): Promise<void>;
}

/**
 * Takes a session-scoped advisory lock on a dedicated PostgreSQL connection.
 * The connection must stay open for the entire time the indexer owns the lock.
 */
export async function tryAcquireIndexerLock(): Promise<IndexerLock | null> {
  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();

  let held: boolean;
  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [LOCK_CLASS_ID, LOCK_OBJECT_ID],
    );
    held = result.rows[0]?.locked === true;
  } catch (error) {
    try {
      await client.end();
    } catch (closeError) {
      console.error('failed to close indexer lock connection after acquisition error', closeError);
    }
    throw error;
  }

  if (!held) {
    await client.end();
    return null;
  }

  let active = true;
  client.on('error', () => {
    active = false;
  });

  return {
    isHeld: () => active,
    release: async () => {
      if (!active) return;

      active = false;
      try {
        const result = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1, $2) AS unlocked',
          [LOCK_CLASS_ID, LOCK_OBJECT_ID],
        );
        if (result.rows[0]?.unlocked !== true) {
          throw new Error('indexer advisory lock was not held during release');
        }
      } finally {
        await client.end();
      }
    },
  };
}
