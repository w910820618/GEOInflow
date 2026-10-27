import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assertUpstreamMigrations } from './liekan-schema-check.mjs';

// Platforms without compose dependency ordering start workers beside the app. Workers wait
// until the app has applied every bundled migration and initialized the fixed queues.
export async function readiness(query, options = {}) {
  const schema =
    options.schema || new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema');
  try {
    await assertUpstreamMigrations({ $queryRawUnsafe: query }, { ...options.upstream, schema });
  } catch {
    return 'upstream-migrations-pending';
  }
  const tables = new Set(
    (
      await query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', schema)
    ).map(row => row.table_name),
  );
  if (!tables.has('liekan_migration')) return 'liekan-migrations-pending';
  const applied = new Set(
    (await query(`SELECT name FROM "${schema}".liekan_migration`)).map(row => row.name),
  );
  const bundled = (
    await readdir(options.migrationDirectory || resolve('db/liekan/migrations'))
  ).filter(file => file.endsWith('.sql'));
  if (bundled.some(name => !applied.has(name))) return 'liekan-migrations-pending';
  if (!tables.has('liekan_queue_installation')) return 'queue-pending';
  const queue = await query(
    `SELECT 1 FROM "${schema}".liekan_queue_installation WHERE id='liekan_jobs'`,
  );
  return queue.length ? 'ready' : 'queue-pending';
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const timeoutMs = Number(process.env.LIEKAN_WAIT_READY_TIMEOUT_SECONDS || 3600) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    let state;
    try {
      await client.connect();
      state = await readiness((sql, ...params) => client.query(sql, params).then(r => r.rows));
    } catch {
      state = 'database-unavailable';
    } finally {
      await client.end().catch(() => {});
    }
    if (state === 'ready') break;
    if (state !== last) console.log(`Waiting for application initialization: ${state}`);
    last = state;
    if (Date.now() > deadline) {
      console.error('Application initialization did not finish in time');
      process.exit(1);
    }
    await delay(5000);
  }
  console.log('Application initialization complete.');
}
