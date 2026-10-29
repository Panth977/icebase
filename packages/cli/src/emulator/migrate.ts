// `icebase migrate`: copy an IceBase server's data between SQLite (a data directory) and
// Postgres (vm mode), either way. Every store the source has (firestore, firestore-<db>, auth,
// storage, tasks, database, database-<instance>) is created in the target and its rows copied in
// one transaction per store — documents keep their versions and times, users their uids and
// password hashes. Run it with the server stopped. Stored files (blobs) are not in the stores:
// they stay in the data directory (or vm.blobs.dir).

import { postgresStores, sqliteStores, type Store, type Stores } from './store.ts';
import { storeKind } from './tables.ts';

export interface MigrateOptions {
  /** Empty the target's tables first (else a target that has rows is refused). */
  replace?: boolean;
  log?: (line: string) => void;
}

export interface MigrateResult {
  stores: { name: string; rows: Record<string, number> }[];
}

const PAGE = 1000;

async function hasTable(s: Store, table: string): Promise<boolean> {
  const r = s.dialect === 'postgres'
    ? await s.get(`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename = ?`, table)
    : await s.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table);
  return !!r;
}

/** A value read from one dialect, as the other takes it (Postgres hands JSON columns back parsed). */
function portable(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export async function migrate(from: Stores, to: Stores, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const names = await from.list();
  if (!names.length) throw new Error(`migrate: no IceBase data at ${from.where}`);
  const plan: { name: string; src: Store; dst: Store; tables: [string, string[]][] }[] = [];
  for (const name of names) {
    const kind = storeKind(name);
    if (!kind) {
      log(`skip ${name}: not an IceBase store`);
      continue;
    }
    const src = await from.open(name);
    const dst = await to.open(name);
    await kind.create(dst);
    const tables: [string, string[]][] = [];
    for (const [t, key] of Object.entries(kind.tables)) {
      if (!(await hasTable(src, t))) continue;
      const n = Number((await dst.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`))!.n);
      if (n && !opts.replace) throw new Error(`migrate: ${to.where} already has data (${name}.${t}: ${n} rows); pass replace to overwrite it`);
      tables.push([t, key]);
    }
    plan.push({ name, src, dst, tables });
  }
  const out: MigrateResult = { stores: [] };
  for (const { name, src, dst, tables } of plan) {
    const rows: Record<string, number> = {};
    await dst.transaction(async (tx) => {
      for (const [t, key] of tables) {
        if (opts.replace) await tx.run(`DELETE FROM ${t}`);
        let n = 0;
        for (let offset = 0; ; offset += PAGE) {
          const page = await src.all(`SELECT * FROM ${t} ORDER BY ${key.join(', ')} LIMIT ${PAGE} OFFSET ${offset}`);
          for (const r of page) {
            const cols = Object.keys(r);
            await tx.run(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => portable(r[c])));
          }
          n += page.length;
          if (page.length < PAGE) break;
        }
        rows[t] = n;
      }
    });
    log(`${name}: ${Object.entries(rows).map(([t, n]) => `${n} ${t}`).join(', ') || 'nothing'}`);
    out.stores.push({ name, rows });
  }
  return out;
}

/**
 * Where data is, as `icebase migrate` takes it: `sqlite:<dir>` (or a bare directory), or a
 * Postgres connection string (`postgres://…`); `env:NAME` reads either from an env var.
 */
export function storesAt(spec: string, o: { prefix?: string; env?: Record<string, string | undefined> } = {}): Stores {
  let s = spec;
  if (s.startsWith('env:')) {
    const v = (o.env ?? {})[s.slice(4)];
    if (!v) throw new Error(`migrate: env var ${s.slice(4)} is not set`);
    s = v;
  }
  if (/^postgres(ql)?:\/\//.test(s)) return postgresStores({ url: s, ...(o.prefix ? { prefix: o.prefix } : {}) });
  return sqliteStores(s.replace(/^sqlite:/, ''));
}
