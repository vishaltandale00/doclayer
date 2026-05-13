/**
 * Migration runner — applies db/migrations/*.sql in lexical order.
 * Tracks applied migrations in `_migrations` table so reruns are idempotent.
 * Run with: `node --experimental-strip-types db/migrate.ts`
 *
 * Reads POSTGRES_URL from env. If running locally, source .env.development.local first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!url) {
    console.error('POSTGRES_URL_NON_POOLING or POSTGRES_URL must be set');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  await client.query(`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const dir = join(__dirname, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const { rows: applied } = await client.query<{ name: string }>(
    'select name from _migrations'
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`skip   ${file}`);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    console.log(`apply  ${file}`);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into _migrations (name) values ($1)', [file]);
      await client.query('commit');
      count++;
    } catch (e) {
      await client.query('rollback');
      console.error(`FAILED ${file}:`, e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }

  await client.end();
  console.log(`\n${count} migration(s) applied.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
