import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
const { readiness } = await import('../../scripts/liekan-wait-ready.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liekan-wait-ready-'));
  const upstream = path.join(root, 'prisma');
  const liekan = path.join(root, 'liekan');
  await mkdir(path.join(upstream, '01_init'), { recursive: true });
  await writeFile(path.join(upstream, '01_init', 'migration.sql'), 'SELECT 1;');
  await mkdir(liekan);
  await writeFile(path.join(liekan, '001_a.sql'), 'SELECT 1;');
  await writeFile(path.join(liekan, '002_b.sql'), 'SELECT 2;');
  const checksum = createHash('sha256').update('SELECT 1;').digest('hex');
  return {
    options: {
      migrationDirectory: liekan,
      upstream: { migrationDirectory: upstream, declaredMigration: '01_init' },
    },
    checksum,
  };
}

function database({ upstream = true, tables = [], liekan = [], queue = false, checksum }) {
  return async sql => {
    if (sql.includes('_prisma_migrations') && sql.includes('EXISTS')) return [{ exists: upstream }];
    if (sql.includes('_prisma_migrations'))
      return [
        { migration_name: '01_init', checksum, finished_at: new Date(), rolled_back_at: null },
      ];
    if (sql.includes('information_schema.tables'))
      return tables.map(table_name => ({ table_name }));
    if (sql.includes('liekan_migration')) return liekan.map(name => ({ name }));
    if (sql.includes('liekan_queue_installation')) return queue ? [{ '?column?': 1 }] : [];
    throw new Error(`Unexpected query: ${sql}`);
  };
}

test('workers wait for upstream migrations, Liekan migrations and queue setup in order', async () => {
  const { options, checksum } = await fixture();
  assert.equal(
    await readiness(database({ upstream: false, checksum }), options),
    'upstream-migrations-pending',
  );
  assert.equal(await readiness(database({ checksum }), options), 'liekan-migrations-pending');
  assert.equal(
    await readiness(
      database({ tables: ['liekan_migration'], liekan: ['001_a.sql'], checksum }),
      options,
    ),
    'liekan-migrations-pending',
  );
  const migrated = {
    tables: ['liekan_migration', 'liekan_queue_installation'],
    liekan: ['001_a.sql', '002_b.sql'],
    checksum,
  };
  assert.equal(await readiness(database(migrated), options), 'queue-pending');
  assert.equal(await readiness(database({ ...migrated, queue: true }), options), 'ready');
});

test('readiness rejects unsafe schema names before querying', async () => {
  const { options } = await fixture();
  await assert.rejects(
    readiness(async () => [], { ...options, schema: 'public;drop' }),
    /Invalid PostgreSQL schema/,
  );
});

test('Railway Dockerfile matches the release Dockerfile apart from the unscoped cache mount', async () => {
  const release = (await readFile('Dockerfile.liekan', 'utf8')).split('\n');
  // The first two lines are the Railway header comment.
  const railway = (await readFile('Dockerfile.railway', 'utf8')).split('\n').slice(2);
  assert.ok(!railway.some(line => line.includes('--mount=type=cache')));
  assert.deepEqual(
    railway,
    release.map(line => line.replace(/^RUN --mount=type=cache,id=[^ ]+ \\$/, 'RUN \\')),
  );
});
