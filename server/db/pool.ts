import pg from 'pg';

/**
 * Postgres (Neon) connection pool. The Fly game server is a long-lived process,
 * so a standard `pg.Pool` is the right fit (not the edge/serverless HTTP driver).
 *
 * When `DATABASE_URL` is unset the pool is null and ALL persistence NO-OPS — the
 * game, lobby, and matches keep working; only leaderboards/records/ELO are off.
 * That keeps local dev and a boards-less deploy trivial. Neon connection strings
 * already carry `?sslmode=require`.
 */
const url = process.env.DATABASE_URL;

/**
 * The bits of `pg.Pool` the repo actually uses.
 *
 * Named as an interface rather than typing everything `pg.Pool` so a TEST can
 * substitute an in-process Postgres (`scripts/dbtest.ts` runs the real payment
 * paths against PGlite — there is no Postgres on a dev machine, and "verified by
 * reading" is how the first version of the Ko-fi claim shipped un-run). A
 * `pg.Pool` satisfies this structurally; nothing about production changes.
 */
export interface DbClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
}

export interface DbPool {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  connect(): Promise<DbClient>;
}

export let dbEnabled = !!url;

export let pool: DbPool | null = url
  ? new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

if (!dbEnabled) {
  console.warn(
    '[db] DATABASE_URL unset — records/leaderboards/ELO disabled (play still works)',
  );
}

if (pool instanceof pg.Pool) pool.on('error', (e) => console.error('[db] idle client error:', e));

/**
 * Point the repo at a different Postgres. TEST-ONLY — nothing in `server/` calls
 * this, and with `DATABASE_URL` set the production pool is already built by the
 * time any test could. `let` + ESM live bindings mean importers see the swap.
 */
export function setPoolForTests(p: DbPool | null): void {
  pool = p;
  dbEnabled = !!p;
}

/** parameterized query → rows. Throws if the DB is disabled; callers use the
 * repo helpers (which guard on `dbEnabled`) rather than calling this directly. */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!pool) throw new Error('DB disabled (DATABASE_URL unset)');
  const res = await pool.query<T>(text, params);
  return res.rows;
}

/** a scoped query function bound to ONE connection inside a transaction */
export type Tx = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;

/**
 * Run `fn` inside a transaction on a single pooled connection, committing on
 * return and rolling back on throw.
 *
 * `q()` takes a connection from the pool PER CALL, so a sequence of `q()`s is
 * not atomic and can even interleave across connections. Anywhere correctness
 * depends on two statements landing together — accepting a friend request is
 * "delete the request AND insert the friendship", and a half-applied version
 * either drops a request that was never honoured or mints a friendship nobody
 * asked for — the statements must share one connection. That is what this is for.
 */
export async function tx<T>(fn: (query: Tx) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('DB disabled (DATABASE_URL unset)');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const query: Tx = async <R extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
      (await client.query<R>(text, params)).rows;
    const out = await fn(query);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
