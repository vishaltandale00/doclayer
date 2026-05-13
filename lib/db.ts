/**
 * Neon (Vercel Postgres) client wrapper.
 * Uses `pg` directly rather than @vercel/postgres to keep the surface small
 * and avoid an extra dependency layer. @vercel/postgres provisions the same
 * connection string under the hood; we just use it directly.
 *
 * Connection strategy:
 *   - Pooled connection (POSTGRES_URL) for normal queries. Neon's pooler
 *     handles serverless cold-start churn.
 *   - For migrations or transactions that need session-level state, use
 *     POSTGRES_URL_NON_POOLING.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');
  pool = new Pool({
    connectionString: url,
    max: 5, // serverless: keep the count low; Neon's pooler does the heavy lifting
    idleTimeoutMillis: 10_000,
  });
  return pool;
}

/** Run a parameterized query and return rows. */
export async function sql<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

/** Run a parameterized query and return the first row or null. */
export async function sqlOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] ?? null;
}

/** Run a callback inside a transaction. Auto-rollback on throw. */
export async function tx<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
