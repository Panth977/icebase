// Where the IceBase server keeps its data: SQLite (node:sqlite, one file per store in the data
// directory — emulator mode and `icebase serve`) or Postgres (vm mode: one schema per store in
// one database). The services speak SQL through the async Store below; the SQL they write is
// the common subset of both, and where the two differ (JSON, collation, index catalogs) they
// branch on `dialect`.
//
// A transaction is atomic and the only writer of its store while it runs: SQLite takes the write
// lock (BEGIN IMMEDIATE), Postgres an advisory lock per schema. That keeps Firestore commits
// (preconditions, the version counter, the change feed) as ordered as they are on one SQLite file.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type Dialect = 'sqlite' | 'postgres';

/** Statements on one store (or inside one of its transactions). `?` placeholders on both dialects. */
export interface Sql {
  readonly dialect: Dialect;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
}

export interface Store extends Sql {
  /** Column types: text that compares bytewise (as Firestore orders strings), 64-bit integer, binary, JSON. */
  readonly types: { text: string; int: string; blob: string; json: string };
  /** Several statements, no parameters (schemas). */
  exec(sql: string): Promise<void>;
  /** Atomic, and the store's only writer while it runs. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** The stores of one server: 'firestore', 'auth', 'storage', 'tasks', 'database', … */
export interface Stores {
  readonly dialect: Dialect;
  /** For logs: the data directory, or the database (no password). */
  readonly where: string;
  open(name: string): Promise<Store>;
  /** The stores that exist (migrate). */
  list(): Promise<string[]>;
  /** Closes every store opened; ephemeral ones (':memory:') are dropped. */
  close(): Promise<void>;
}

// ─── SQLite ──────────────────────────────────────────────────────────────────────

class SqliteStore implements Store {
  readonly dialect = 'sqlite' as const;
  readonly types = { text: 'TEXT', int: 'INTEGER', blob: 'BLOB', json: 'TEXT' };
  private readonly stmts = new Map<string, StatementSync>();
  /** Set while a transaction runs: statements from outside it wait. */
  private gate: Promise<void> | null = null;
  private readonly inner: Sql;

  constructor(readonly db: DatabaseSync) {
    const stmt = (sql: string) => {
      let s = this.stmts.get(sql);
      if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
      return s;
    };
    this.inner = {
      dialect: 'sqlite',
      all: async <T>(sql: string, ...p: unknown[]) => stmt(sql).all(...(p as never[])) as T[],
      get: async <T>(sql: string, ...p: unknown[]) => stmt(sql).get(...(p as never[])) as T | undefined,
      run: async (sql: string, ...p: unknown[]) => ({ changes: Number(stmt(sql).run(...(p as never[])).changes) }),
    };
  }

  // Each waits for a running transaction and then runs with no await in between (the statement
  // itself is synchronous): it never lands inside another transaction.
  async all<T = Record<string, unknown>>(sql: string, ...p: unknown[]): Promise<T[]> {
    while (this.gate) await this.gate;
    return this.inner.all<T>(sql, ...p);
  }
  async get<T = Record<string, unknown>>(sql: string, ...p: unknown[]): Promise<T | undefined> {
    while (this.gate) await this.gate;
    return this.inner.get<T>(sql, ...p);
  }
  async run(sql: string, ...p: unknown[]): Promise<{ changes: number }> {
    while (this.gate) await this.gate;
    return this.inner.run(sql, ...p);
  }
  async exec(sql: string): Promise<void> {
    while (this.gate) await this.gate;
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    // Checked and taken with no await in between: two waiters never both get the gate.
    while (this.gate) await this.gate;
    let release!: () => void;
    this.gate = new Promise((r) => (release = r));
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(this.inner);
        this.db.exec('COMMIT');
        return out;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    } finally {
      this.gate = null;
      release();
    }
  }

  private closed = false;
  async close(): Promise<void> {
    while (this.gate) await this.gate;
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** One SQLite file per store in the data directory (`<name>.sqlite`), or all in memory. */
export function sqliteStores(dataDir: string): Stores {
  const open: SqliteStore[] = [];
  return {
    dialect: 'sqlite',
    where: dataDir === ':memory:' ? 'in memory' : dataDir,
    async open(name) {
      if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });
      const s = new SqliteStore(new DatabaseSync(dataDir === ':memory:' ? ':memory:' : join(dataDir, `${name}.sqlite`)));
      open.push(s);
      return s;
    },
    async list() {
      if (dataDir === ':memory:' || !existsSync(dataDir)) return [];
      return readdirSync(dataDir).filter((f) => f.endsWith('.sqlite')).map((f) => f.slice(0, -'.sqlite'.length)).sort();
    },
    async close() {
      for (const s of open.splice(0)) await s.close();
    },
  };
}

// ─── Postgres (the `pg` package, imported when first used) ───────────────────────

/** The part of `pg` used here (typed locally: SQLite users never install it). */
interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}
interface PgClient {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  release(err?: unknown): void;
}
interface PgPool {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: 'error', fn: (e: Error) => void): void;
}
interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPool;
  types: { getTypeParser(oid: number, format?: string): (v: string) => unknown };
}

let pgModule: Promise<PgModule> | null = null;
function loadPg(): Promise<PgModule> {
  // @ts-ignore: 'pg' ships no types; the part used is typed above (PgModule).
  pgModule ??= import('pg').then(
    (m) => ((m as { default?: PgModule }).default ?? m) as PgModule,
    (e) => {
      pgModule = null;
      throw new Error(`Postgres needs the 'pg' package (npm install pg): ${(e as Error).message}`);
    },
  );
  return pgModule;
}

/** `?` → `$1, $2, …`, outside quoted strings and identifiers. */
export function pgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

/** A Postgres error as the services test for it (they match SQLite's "UNIQUE constraint failed"). */
function pgError(e: unknown): unknown {
  const pe = e as { code?: string; constraint?: string; message?: string };
  if (pe?.code === '23505') return Object.assign(new Error(`UNIQUE constraint failed: ${pe.constraint ?? ''} (${pe.message ?? ''})`), { cause: e });
  return e;
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A store's schema name: `<prefix><name>` folded to [a-z0-9_], at most 63 bytes. */
export function pgSchemaName(prefix: string, name: string): string {
  const s = `${prefix}${name}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return s.length <= 63 ? s : `${s.slice(0, 50)}_${createHash('sha1').update(s).digest('hex').slice(0, 12)}`;
}

class PgStore implements Store {
  readonly dialect = 'postgres' as const;
  readonly types = { text: 'TEXT COLLATE "C"', int: 'BIGINT', blob: 'BYTEA', json: 'JSON' };

  private readonly direct: Sql;
  constructor(private readonly pool: PgPool, readonly schema: string) {
    this.direct = PgStore.on(pool);
  }

  private static on(q: { query(text: string, values?: unknown[]): Promise<PgQueryResult> }): Sql {
    const query = async (sql: string, p: unknown[]) => {
      try {
        return await q.query(pgPlaceholders(sql), p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)));
      } catch (e) {
        throw pgError(e);
      }
    };
    return {
      dialect: 'postgres',
      all: async <T>(sql: string, ...p: unknown[]) => (await query(sql, p)).rows as T[],
      get: async <T>(sql: string, ...p: unknown[]) => (await query(sql, p)).rows[0] as T | undefined,
      run: async (sql: string, ...p: unknown[]) => ({ changes: (await query(sql, p)).rowCount ?? 0 }),
    };
  }

  all<T = Record<string, unknown>>(sql: string, ...p: unknown[]): Promise<T[]> {
    return this.direct.all<T>(sql, ...p);
  }
  get<T = Record<string, unknown>>(sql: string, ...p: unknown[]): Promise<T | undefined> {
    return this.direct.get<T>(sql, ...p);
  }
  run(sql: string, ...p: unknown[]): Promise<{ changes: number }> {
    return this.direct.run(sql, ...p);
  }
  async exec(sql: string): Promise<void> {
    try {
      await this.pool.query(sql);
    } catch (e) {
      throw pgError(e);
    }
  }

  async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // One writer per store at a time, as SQLite's BEGIN IMMEDIATE (across processes too).
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.schema]);
      const out = await fn(PgStore.on(c));
      await c.query('COMMIT');
      c.release();
      return out;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
        c.release();
      } catch (e2) {
        c.release(e2);
      }
      throw e;
    }
  }

  private closed = false;
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

export interface PostgresStoresOptions {
  /** postgres://user:password@host:port/database */
  url: string;
  /** Schema names are `<prefix><store>` (default 'icebase_'): several servers can share one database. */
  prefix?: string;
  /** Drop the schemas on close (a ':memory:' server on Postgres: tests). */
  ephemeral?: boolean;
  /** Connections per store (default 4). */
  poolSize?: number;
}

/** One schema per store in one Postgres database. */
export function postgresStores(opts: PostgresStoresOptions): Stores {
  const prefix = opts.ephemeral ? `${opts.prefix ?? 'icebase_'}tmp_${randomBytes(5).toString('hex')}_` : (opts.prefix ?? 'icebase_');
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) throw new Error(`postgres: the schema prefix '${prefix}' must be [a-z_][a-z0-9_]*`);
  const open: PgStore[] = [];
  let where = 'postgres';
  try {
    const u = new URL(opts.url);
    where = `postgres://${u.host}${u.pathname} (schemas ${prefix}*)`;
  } catch {
    // a connection string that is not a URL (key=value): pg parses it
  }
  return {
    dialect: 'postgres',
    where,
    async open(name) {
      const pg = await loadPg();
      const schema = pgSchemaName(prefix, name);
      const int8 = (v: string) => Number(v);
      const pool = new pg.Pool({
        connectionString: opts.url,
        max: opts.poolSize ?? 4,
        options: `-c search_path=${schema}`,
        // BIGINT (row counts, millisecond times) as numbers, as node:sqlite returns them.
        types: { getTypeParser: (oid: number, format?: string) => (oid === 20 ? int8 : pg.types.getTypeParser(oid, format)) },
      });
      pool.on('error', (e) => console.error('[icebase postgres]', e.message));
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`).catch(async (e: { code?: string }) => {
        // Two servers creating it at once: the loser sees a unique violation; the schema exists.
        if (e.code !== '23505' && e.code !== '42P06') throw e;
      });
      // The store's own name (schema names are folded): list() reads it back.
      await pool.query(`COMMENT ON SCHEMA ${quoteIdent(schema)} IS ${quoteLiteral(`icebase store ${name}`)}`);
      const s = new PgStore(pool, schema);
      open.push(s);
      return s;
    },
    async list() {
      const pg = await loadPg();
      const admin = new pg.Pool({ connectionString: opts.url, max: 1 });
      try {
        const rows = (await admin.query(`SELECT nspname, obj_description(oid, 'pg_namespace') AS d FROM pg_namespace WHERE nspname LIKE $1`, [`${prefix.replace(/_/g, '\\_')}%`])).rows;
        const names = rows.map((r) => ({ schema: String(r.nspname), name: /^icebase store (.+)$/.exec(String(r.d ?? ''))?.[1] }));
        // Only this prefix's own (not a longer prefix's that starts the same).
        return names.filter((r): r is { schema: string; name: string } => !!r.name && pgSchemaName(prefix, r.name) === r.schema).map((r) => r.name).sort();
      } finally {
        await admin.end();
      }
    },
    async close() {
      const stores = open.splice(0);
      if (opts.ephemeral && stores.length) {
        const pg = await loadPg();
        const admin = new pg.Pool({ connectionString: opts.url, max: 1 });
        try {
          for (const s of stores) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(s.schema)} CASCADE`);
        } finally {
          await admin.end();
        }
      }
      for (const s of stores) await s.close();
    },
  };
}

/** Drop every schema named `<prefix>…` (tests, and a migration into Postgres with replace). */
export async function dropPostgresSchemas(url: string, prefix: string): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) throw new Error(`postgres: the schema prefix '${prefix}' must be [a-z_][a-z0-9_]*`);
  const pg = await loadPg();
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const like = `${prefix.replace(/_/g, '\\_')}%`;
    const names = (await admin.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [like])).rows.map((r) => r.nspname as string);
    for (const n of names) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(n)} CASCADE`);
    return names;
  } finally {
    await admin.end();
  }
}

/**
 * The stores a server uses: Postgres when a connection string is given (the server option, else
 * ICEBASE_DATABASE_URL), else SQLite files in the data directory. A ':memory:' data directory on
 * Postgres gets schemas of its own, dropped when the server closes.
 */
export function openStores(o: { dataDir: string; databaseUrl?: string | undefined; databasePrefix?: string | undefined }): Stores {
  if (!o.databaseUrl) return sqliteStores(o.dataDir);
  return postgresStores({ url: o.databaseUrl, ...(o.databasePrefix ? { prefix: o.databasePrefix } : {}), ephemeral: o.dataDir === ':memory:' });
}
