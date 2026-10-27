import { createHash } from 'node:crypto';
// The emulator's document engine: Firestore semantics on SQLite (node:sqlite).
//
// One table holds every document (path, collection id, parent, data as tagged JSON). Every
// field that a query filters or sorts on becomes an expression over that JSON, and IceBase
// creates a SQLite index for each declared composite (IDX-5) — and for single fields the first
// time a query uses them. Queries the planner refuses (missing composite) never reach here.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { IceBaseError } from '@panth977/icebase/errors';
import { dnf, fullOrder, isName, planQuery, type FilterNode, type OrderSpec, type QuerySpec, type WhereOp } from '@panth977/icebase/internal';

export { fullOrder } from '@panth977/icebase/internal';
import { tsKey, type Tagged } from '@panth977/icebase/internal';
import { fieldAt, matchCollectionPath, showPath, type AnyCollection, type Schema } from '@panth977/icebase/schema';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface StoredDoc {
  path: string;
  id: string;
  data: Record<string, Json>;
  createTime: { s: number; n: number };
  updateTime: { s: number; n: number };
  version: number;
}

export type Write =
  | { op: 'set'; path: string; data: Record<string, Json>; merge?: boolean }
  | { op: 'create'; path: string; data: Record<string, Json> }
  | { op: 'update'; path: string; fields: { path: string[]; value: Json }[] }
  | { op: 'delete'; path: string };

/** For transactions: the version each read saw (0 = did not exist). */
export type Precondition = { path: string; version: number };

export interface Change {
  path: string;
  collectionId: string;
  parent: string;
  before: StoredDoc | null;
  after: StoredDoc | null;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
const idOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const collIdOf = (path: string) => {
  const p = parentOf(path);
  return p.slice(p.lastIndexOf('/') + 1);
};

// ─── Firestore value order (null < bool < number < timestamp < string < bytes < ref < geo < array < map) ───

const rank = (v: Json | undefined): number => {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (typeof v === 'string') return 4;
  if (Array.isArray(v)) return 8;
  const t = (v as unknown as Tagged).__ib;
  return t === 'ts' ? 3 : t === 'bytes' ? 5 : t === 'ref' ? 6 : t === 'geo' ? 7 : 9;
};
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function compare(a: Json | undefined, b: Json | undefined): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0:
      return 0;
    case 1:
    case 2:
      return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
    case 3:
      return cmpStr((a as unknown as { k: string }).k, (b as unknown as { k: string }).k);
    case 4:
      return cmpStr(a as string, b as string);
    case 5:
      return cmpStr((a as unknown as { b: string }).b, (b as unknown as { b: string }).b);
    case 6:
      return cmpStr((a as unknown as { p: string }).p, (b as unknown as { p: string }).p);
    case 7: {
      const x = a as unknown as { lat: number; lng: number };
      const y = b as unknown as { lat: number; lng: number };
      return x.lat - y.lat || x.lng - y.lng;
    }
    case 8: {
      const x = a as Json[];
      const y = b as Json[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compare(x[i], y[i]);
        if (c) return c;
      }
      return x.length - y.length;
    }
    default: {
      const x = Object.keys(a as object).sort();
      const y = Object.keys(b as object).sort();
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = cmpStr(x[i]!, y[i]!) || compare((a as Record<string, Json>)[x[i]!], (b as Record<string, Json>)[y[i]!]);
        if (c) return c;
      }
      return x.length - y.length;
    }
  }
}
const equal = (a: Json | undefined, b: Json | undefined) => a !== undefined && b !== undefined && compare(a, b) === 0 && rank(a) === rank(b);

/** The value at a key path (never split on dots). */
export function getField(data: Record<string, Json>, path: readonly string[]): Json | undefined {
  let cur: Json | undefined = data;
  for (const k of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || (cur as unknown as Tagged).__ib) return undefined;
    cur = (cur as Record<string, Json>)[k];
  }
  return cur;
}

/** Does one document match one field filter (Firestore semantics, used for JS evaluation and listeners). */
export function matches(doc: StoredDoc, f: { field: string[]; op: WhereOp; value: unknown }): boolean {
  const v = valueAt(doc, f.field);
  const q = f.value as Json;
  switch (f.op) {
    case '==':
      return v !== undefined && (q === null ? v === null : equal(v, q));
    case '!=':
      return v !== undefined && v !== null && !equal(v, q);
    case '<':
      return v !== undefined && rank(v) === rank(q) && compare(v, q) < 0;
    case '<=':
      return v !== undefined && rank(v) === rank(q) && compare(v, q) <= 0;
    case '>':
      return v !== undefined && rank(v) === rank(q) && compare(v, q) > 0;
    case '>=':
      return v !== undefined && rank(v) === rank(q) && compare(v, q) >= 0;
    case 'in':
      return v !== undefined && (q as Json[]).some((x) => equal(v, x));
    case 'not-in':
      return v !== undefined && v !== null && !(q as Json[]).some((x) => equal(v, x));
    case 'array-contains':
      return Array.isArray(v) && v.some((x) => equal(x, q));
    case 'array-contains-any':
      return Array.isArray(v) && v.some((x) => (q as Json[]).some((y) => equal(x, y)));
  }
}

export function matchesFilters(doc: StoredDoc, filters: FilterNode[]): boolean {
  return dnf(filters).some((conj) => conj.every((f) => matches(doc, f)));
}

function valueAt(doc: StoredDoc, field: string[]): Json | undefined {
  return isName(field) ? ({ __ib: 'ref', p: doc.path } as unknown as Json) : getField(doc.data, field);
}

export function sortDocs(docs: StoredDoc[], order: OrderSpec[]): StoredDoc[] {
  return docs.sort((a, b) => {
    for (const o of order) {
      const c = compare(valueAt(a, o.field), valueAt(b, o.field));
      if (c) return o.dir === 'asc' ? c : -c;
    }
    return 0;
  });
}

/** A cursor position compared to a document, in query order: <0 before, 0 at, >0 after. */
function cursorCmp(doc: StoredDoc, order: OrderSpec[], values: Json[]): number {
  for (let i = 0; i < values.length && i < order.length; i++) {
    const o = order[i]!;
    let c = compare(valueAt(doc, o.field), isName(o.field) && typeof values[i] === 'string' ? ({ __ib: 'ref', p: values[i] } as unknown as Json) : values[i]);
    if (o.dir === 'desc') c = -c;
    if (c) return c;
  }
  return 0;
}

// ─── the engine ────────────────────────────────────────────────────────────────

export interface EngineOptions {
  /** SQLite file, or ':memory:'. */
  file: string;
  schema: Schema<Record<string, AnyCollection>, any, any>;
  /** Learning mode: report a missing index instead of refusing the query (never in production). */
  learn?: (missing: { collection: string; suggestion: string }) => void;
}

export class FirestoreEngine {
  readonly db: DatabaseSync;
  private readonly colls: AnyCollection[] = [];
  private readonly listeners = new Set<(changes: Change[]) => void>();
  private readonly stmts: Record<string, StatementSync>;
  /** The SQLite indexes built from the declared ones (IDX-5), for the console. */
  readonly sqlIndexes: string[] = [];
  private version: number;
  private lastTime = 0;

  private readonly learn: EngineOptions['learn'];
  constructor(opts: EngineOptions) {
    this.learn = opts.learn;
    this.db = new DatabaseSync(opts.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 10000;
      CREATE TABLE IF NOT EXISTS docs (
        path TEXT PRIMARY KEY,
        coll TEXT NOT NULL,
        parent TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        ct_s INTEGER NOT NULL, ct_n INTEGER NOT NULL,
        ut_s INTEGER NOT NULL, ut_n INTEGER NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS docs_parent ON docs (parent, path);
      CREATE INDEX IF NOT EXISTS docs_coll ON docs (coll, path);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    this.version = Number((this.db.prepare(`SELECT MAX(version) v FROM docs`).get() as { v: number | null }).v ?? 0);
    this.stmts = {
      get: this.db.prepare(`SELECT * FROM docs WHERE path = ?`),
      put: this.db.prepare(`INSERT INTO docs (path, coll, parent, id, data, ct_s, ct_n, ut_s, ut_n, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET data = excluded.data, ut_s = excluded.ut_s, ut_n = excluded.ut_n, version = excluded.version`),
      del: this.db.prepare(`DELETE FROM docs WHERE path = ?`),
      count: this.db.prepare(`SELECT COUNT(*) n FROM docs`),
    };
    this.setSchema(opts.schema);
  }

  /** The schema the engine plans queries with: its declared indexes are built, earlier ones dropped. */
  setSchema(schema: Schema<Record<string, AnyCollection>, any, any>): void {
    this.colls.length = 0;
    this.colls.push(...Object.values(schema.collections));
    this.sqlIndexes.length = 0;
    const wanted = new Set<string>();
    for (const c of this.colls) this.ensureIndexes(c, wanted);
    // Indexes from an earlier schema (an index removed or changed) go.
    for (const r of this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix\\_%' ESCAPE '\\'`).all() as { name: string }[]) {
      if (!wanted.has(r.name)) this.db.exec(`DROP INDEX IF EXISTS "${r.name}"`);
    }
  }

  /** The declared collection a query reads: by its path, else (a collection-group query) by id. */
  private collectionFor(spec: QuerySpec): AnyCollection | undefined {
    if (spec.path !== null) return matchCollectionPath({ collections: Object.fromEntries(this.colls.map((c, i) => [i, c])), paths: {}, files: {} }, spec.path)?.collection;
    return this.colls.find((c) => c.id === spec.collectionId && c.group) ?? this.colls.find((c) => c.id === spec.collectionId);
  }

  close(): void {
    this.db.close();
  }

  onChanges(cb: (changes: Change[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  count(): number {
    return Number((this.stmts.count!.get() as { n: number }).n);
  }

  // ── SQL expressions ─────────────────────────────────────────────────────────

  /** The JSON path of a key path: '$."a"."b"' (schema field names never contain quotes). */
  private jpath(path: readonly string[]): string {
    return `'$${path.map((k) => `."${k}"`).join('')}'`;
  }

  /** The SQL expression for a field's sortable key, when its type allows one. */
  private expr(coll: AnyCollection | undefined, path: readonly string[]): string | null {
    if (isName(path)) return 'path';
    if (!coll) return null;
    const def = fieldAt(coll.fields, path, coll.rest);
    if (!def) return null;
    const p = this.jpath(path);
    switch (def.def.kind) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'enum':
      case 'literal':
        return `json_extract(data, ${p})`;
      case 'timestamp':
        return `json_extract(data, ${p.slice(0, -1)}.k')`;
      case 'ref':
        return `json_extract(data, ${p.slice(0, -1)}.p')`;
      default:
        return null;
    }
  }

  private param(v: unknown): unknown {
    if (v === true) return 1;
    if (v === false) return 0;
    if (v && typeof v === 'object') {
      const t = v as Tagged;
      if (t.__ib === 'ts') return t.k;
      if (t.__ib === 'ref') return t.p;
    }
    return v;
  }

  /** IDX-5: one SQLite index per declared index — single-field and composite — and no others. */
  private ensureIndexes(c: AnyCollection, wanted: Set<string>): void {
    // A {rest=**} collection spans many collection ids: answered by scanning.
    if (c.glob) return;
    c.indexes.forEach((ix) => {
      const cols = ix.fields.filter((f) => f.mode !== 'contains').map((f) => {
        const e = this.expr(c, f.path);
        return e ? `${e} ${f.mode === 'desc' ? 'DESC' : 'ASC'}` : null;
      });
      // An index on an array (array-contains) or a map has no SQL column; it is answered by scanning the collection.
      if (cols.some((x) => x === null) || cols.length === 0) return;
      const coll = c.id.replace(/'/g, "''");
      const make = (cols2: string) => {
        // Named after its definition, so a changed index is a new one (and the old one is dropped).
        const name = `ix_${createHash('sha1').update(`${coll}|${cols2}`).digest('hex').slice(0, 16)}`;
        wanted.add(name);
        this.db.exec(`CREATE INDEX IF NOT EXISTS "${name}" ON docs (${cols2}, path) WHERE coll = '${coll}'`);
      };
      make(`parent, ${cols.join(', ')}`);
      if (c.group) make(cols.join(', '));
      this.sqlIndexes.push(`${c.path}: ${ix.fields.map((f) => `${showPath(f.path)} ${f.mode}`).join(', ')}`);
    });
  }

  private rowToDoc(r: Record<string, unknown>): StoredDoc {
    return {
      path: r.path as string,
      id: r.id as string,
      data: JSON.parse(r.data as string) as Record<string, Json>,
      createTime: { s: Number(r.ct_s), n: Number(r.ct_n) },
      updateTime: { s: Number(r.ut_s), n: Number(r.ut_n) },
      version: Number(r.version),
    };
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  get(path: string): StoredDoc | null {
    const r = this.stmts.get!.get(path) as Record<string, unknown> | undefined;
    return r ? this.rowToDoc(r) : null;
  }

  getAll(paths: string[]): (StoredDoc | null)[] {
    return paths.map((p) => this.get(p));
  }

  /** Run a query. `cursorStart`/`cursorEnd` values are aligned with fullOrder(spec). */
  query(spec: QuerySpec, aggregated: string[][] = []): StoredDoc[] {
    const coll = this.collectionFor(spec);
    // The SDK checks before sending; the server checks again so no client can skip it.
    for (const c of spec.path === null ? this.colls.filter((x) => x.id === spec.collectionId && x.group) : coll ? [coll] : []) {
      const plan = planQuery(c, spec, aggregated);
      if (!plan.ok && this.learn) {
        this.learn({ collection: c.path, suggestion: plan.missing.suggestion });
        continue;
      }
      if (!plan.ok) throw new IceBaseError('failed-precondition', `The query requires an index on ${plan.missing.fields.map(showPath).join(' + ')}: add ${plan.missing.suggestion} to collection('${c.path}')`, { reason: 'missing-index', index: plan.missing.suggestion });
    }
    const order = fullOrder(spec);
    const where: string[] = [];
    const params: unknown[] = [];
    if (spec.path !== null) {
      where.push('parent = ?');
      params.push(spec.path);
    }
    where.push('coll = ?');
    params.push(spec.collectionId);
    let exact = true;
    const conjs = dnf(spec.filters);
    const sqlConj: string[] = [];
    for (const conj of conjs) {
      const parts: string[] = [];
      for (const f of conj) {
        const s = this.filterSql(coll, f, params);
        if (s === null) exact = false;
        else parts.push(s);
      }
      sqlConj.push(parts.length ? `(${parts.join(' AND ')})` : '1');
    }
    // A conjunction missing a filter SQL can't express is a superset; JS narrows it below.
    if (conjs.length && !sqlConj.includes('1')) where.push(`(${sqlConj.join(' OR ')})`);
    // Documents without an ordered field are not in the result (Firestore semantics).
    for (const o of order) {
      if (isName(o.field)) continue;
      where.push(`json_type(data, ${this.jpath(o.field)}) IS NOT NULL`);
    }
    const orderSql: string[] = [];
    for (const o of order) {
      const e = this.expr(coll, o.field);
      if (!e) {
        exact = false;
        break;
      }
      orderSql.push(`${e} ${o.dir === 'asc' ? 'ASC' : 'DESC'}`);
    }
    if (spec.start?.values.length || spec.end?.values.length) exact = false;
    const reverse = spec.limit?.last === true;
    let sql = `SELECT * FROM docs WHERE ${where.join(' AND ')}`;
    if (exact && orderSql.length === order.length) {
      sql += ` ORDER BY ${orderSql.map((s) => (reverse ? s.replace(/ ASC$/, ' __D').replace(/ DESC$/, ' ASC').replace(/ __D$/, ' DESC') : s)).join(', ')}`;
      if (spec.limit) sql += ` LIMIT ${spec.limit.n}`;
      const rows = (this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map((r) => this.rowToDoc(r));
      return reverse ? rows.reverse() : rows;
    }
    // Something SQL can't say exactly (maps, nested fields, cursors): finish in JS.
    let docs = (this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map((r) => this.rowToDoc(r));
    docs = docs.filter((d) => matchesFilters(d, spec.filters) && order.every((o) => isName(o.field) || valueAt(d, o.field) !== undefined));
    sortDocs(docs, order);
    if (spec.start?.values.length) docs = docs.filter((d) => (spec.start!.inclusive ? cursorCmp(d, order, spec.start!.values as Json[]) >= 0 : cursorCmp(d, order, spec.start!.values as Json[]) > 0));
    if (spec.end?.values.length) docs = docs.filter((d) => (spec.end!.inclusive ? cursorCmp(d, order, spec.end!.values as Json[]) <= 0 : cursorCmp(d, order, spec.end!.values as Json[]) < 0));
    if (spec.limit) docs = spec.limit.last ? docs.slice(-spec.limit.n) : docs.slice(0, spec.limit.n);
    return docs;
  }

  private filterSql(coll: AnyCollection | undefined, f: { field: string[]; op: WhereOp; value: unknown }, params: unknown[]): string | null {
    const def = coll && !isName(f.field) ? fieldAt(coll.fields, f.field, coll.rest) : undefined;
    const jp = this.jpath(f.field);
    if (f.op === 'array-contains' || f.op === 'array-contains-any') {
      if (!def || def.def.kind !== 'array') return null;
      const el = def.def.of.def.kind;
      const valueExpr = el === 'timestamp' ? `json_extract(value, '$.k')` : el === 'ref' ? `json_extract(value, '$.p')` : ['string', 'number', 'boolean', 'enum'].includes(el) ? 'value' : null;
      if (!valueExpr) return null;
      const vals = f.op === 'array-contains' ? [f.value] : (f.value as unknown[]);
      params.push(...vals.map((v) => this.param(v)));
      return `EXISTS (SELECT 1 FROM json_each(data, ${jp}) WHERE ${valueExpr} IN (${vals.map(() => '?').join(', ')}))`;
    }
    const e = this.expr(coll, f.field);
    if (!e) return null;
    const present = isName(f.field) ? '1' : `json_type(data, ${jp}) IS NOT NULL`;
    const notNull = isName(f.field) ? '1' : `json_type(data, ${jp}) NOT IN ('null')`;
    if (f.value === null) {
      if (f.op === '==') return `json_type(data, ${jp}) = 'null'`;
      if (f.op === '!=') return `(${present} AND ${notNull})`;
      return '0';
    }
    switch (f.op) {
      case '==':
      case '<':
      case '<=':
      case '>':
      case '>=':
        params.push(this.param(f.value));
        return `(${present} AND ${e} ${f.op === '==' ? '=' : f.op} ?)`;
      case '!=':
        params.push(this.param(f.value));
        return `(${present} AND ${notNull} AND ${e} <> ?)`;
      case 'in':
      case 'not-in': {
        const vals = f.value as unknown[];
        if (vals.some((v) => v === null)) return null;
        params.push(...vals.map((v) => this.param(v)));
        return `(${present} AND ${f.op === 'not-in' ? `${notNull} AND ` : ''}${e} ${f.op === 'in' ? 'IN' : 'NOT IN'} (${vals.map(() => '?').join(', ')}))`;
      }
    }
    return null;
  }

  aggregate(spec: QuerySpec, aggs: Record<string, { op: 'count' } | { op: 'sum' | 'avg'; field: string | string[] }>): Record<string, number | null> {
    // sum() / average() fields are part of the index the query needs (as in Firestore).
    const docs = this.query(spec, Object.values(aggs).flatMap((a) => (a.op === 'count' ? [] : [typeof a.field === 'string' ? [a.field] : a.field])));
    const out: Record<string, number | null> = {};
    for (const [k, a] of Object.entries(aggs)) {
      if (a.op === 'count') out[k] = docs.length;
      else {
        const nums = docs.map((d) => getField(d.data, typeof a.field === 'string' ? [a.field] : a.field)).filter((v): v is number => typeof v === 'number');
        const total = nums.reduce((s, n) => s + n, 0);
        out[k] = a.op === 'sum' ? total : nums.length ? total / nums.length : null;
      }
    }
    return out;
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  private now(): { s: number; n: number } {
    // Strictly increasing commit times, so update times order writes.
    let us = Date.now() * 1000;
    if (us <= this.lastTime) us = this.lastTime + 1;
    this.lastTime = us;
    return { s: Math.floor(us / 1e6), n: (us % 1e6) * 1000 };
  }

  /** Apply writes atomically. Throws aborted when a precondition no longer holds. */
  commit(writes: Write[], preconditions: Precondition[] = []): { time: { s: number; n: number }; changes: Change[] } {
    const time = this.now();
    const changes: Change[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may share the file: continue from the version it left (under the write lock).
      const stored = this.db.prepare(`SELECT v FROM meta WHERE k = 'version'`).get() as { v: string } | undefined;
      if (stored) this.version = Math.max(this.version, Number(stored.v));
      for (const p of preconditions) {
        const cur = this.get(p.path);
        if ((cur?.version ?? 0) !== p.version) throw new IceBaseError('aborted', `Transaction lost a race on ${p.path}; retrying`, {});
      }
      const pending = new Map<string, StoredDoc | null>();
      const current = (path: string) => (pending.has(path) ? pending.get(path)! : this.get(path));
      for (const w of writes) {
        const before = current(w.path);
        let after: StoredDoc | null;
        if (w.op === 'delete') after = null;
        else {
          if (w.op === 'create' && before) throw new IceBaseError('already-exists', `Document already exists: ${w.path}`);
          if (w.op === 'update' && !before) throw new IceBaseError('not-found', `No document to update: ${w.path}`);
          const base: Record<string, Json> = w.op === 'update' || (w.op === 'set' && w.merge) ? structuredClone(before?.data ?? {}) : {};
          const data = w.op === 'update' ? applyUpdate(base, w.fields, time) : applyWrite(base, w.data, w.op === 'set' && w.merge ? 'merge' : 'set', time);
          after = { path: w.path, id: idOf(w.path), data, createTime: before?.createTime ?? time, updateTime: time, version: ++this.version };
        }
        pending.set(w.path, after);
        changes.push({ path: w.path, collectionId: collIdOf(w.path), parent: parentOf(w.path), before, after });
      }
      for (const [path, d] of pending) {
        if (!d) this.stmts.del!.run(path);
        else this.stmts.put!.run(path, collIdOf(path), parentOf(path), d.id, JSON.stringify(d.data), d.createTime.s, d.createTime.n, d.updateTime.s, d.updateTime.n, d.version);
      }
      this.db.prepare(`INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(String(this.version));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (changes.length) for (const l of this.listeners) l(changes);
    return { time, changes };
  }

  listCollections(docPath: string | null): string[] {
    const rows = this.db.prepare(docPath ? `SELECT DISTINCT coll, parent FROM docs WHERE parent LIKE ? ESCAPE '\\'` : `SELECT DISTINCT coll, parent FROM docs WHERE instr(parent, '/') = 0`).all(...((docPath ? [`${docPath.replace(/[\\%_]/g, '\\$&')}/%`] : []) as never[])) as { coll: string; parent: string }[];
    const want = docPath ? docPath.split('/').length + 1 : 1;
    return [...new Set(rows.filter((r) => r.parent.split('/').length === want).map((r) => r.coll))].sort();
  }

  recursiveDelete(path: string): number {
    const like = `${path.replace(/[\\%_]/g, '\\$&')}/%`;
    const victims = (this.db.prepare(`SELECT path FROM docs WHERE path = ? OR path LIKE ? ESCAPE '\\'`).all(path, like) as { path: string }[]).map((r) => r.path);
    if (victims.length) this.commit(victims.map((p) => ({ op: 'delete', path: p })));
    return victims.length;
  }

  /** Every document (for export / the console). */
  *scan(): Generator<StoredDoc> {
    for (const r of this.db.prepare(`SELECT * FROM docs ORDER BY path`).iterate() as Iterable<Record<string, unknown>>) yield this.rowToDoc(r);
  }
}

// ─── applying a write's data (transforms and field paths) ─────────────────────

const isFv = (v: unknown): v is { __ib: 'fv'; op: string; v?: Json } => !!v && typeof v === 'object' && (v as Tagged).__ib === 'fv';
const isMap = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v as Tagged).__ib;

function transform(cur: Json | undefined, fv: { op: string; v?: Json }, time: { s: number; n: number }): Json | undefined {
  switch (fv.op) {
    case 'serverTimestamp':
      return { __ib: 'ts', s: time.s, n: time.n, k: tsKey(time.s, time.n) } as unknown as Json;
    case 'serverTime':
      return time.s * 1000 + Math.floor(time.n / 1e6);
    case 'increment': {
      const by = fv.v as number;
      return typeof cur === 'number' ? cur + by : by;
    }
    case 'arrayUnion': {
      const arr = Array.isArray(cur) ? [...cur] : [];
      for (const e of fv.v as Json[]) if (!arr.some((x) => equal(x, e))) arr.push(e);
      return arr;
    }
    case 'arrayRemove': {
      const arr = Array.isArray(cur) ? cur : [];
      return arr.filter((x) => !(fv.v as Json[]).some((e) => equal(x, e)));
    }
    case 'delete':
      return undefined;
  }
  throw new IceBaseError('invalid-argument', `unknown field transform ${fv.op}`);
}

function resolve(v: Json, cur: Json | undefined, time: { s: number; n: number }): Json | undefined {
  if (isFv(v)) return transform(cur, v, time);
  if (Array.isArray(v)) return v.map((x) => resolve(x, undefined, time) as Json);
  if (isMap(v)) {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) {
      const r = resolve(x, undefined, time);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return v;
}

function mergeInto(target: Record<string, Json>, src: Record<string, Json>, time: { s: number; n: number }): void {
  for (const [k, v] of Object.entries(src)) {
    if (isMap(v) && !isFv(v) && isMap(target[k])) mergeInto(target[k] as Record<string, Json>, v, time);
    else {
      const r = resolve(v, target[k], time);
      if (r === undefined) delete target[k];
      else target[k] = r;
    }
  }
}

function setPath(target: Record<string, Json>, keys: readonly string[], v: Json, time: { s: number; n: number }): void {
  let node = target;
  for (const k of keys.slice(0, -1)) {
    if (!isMap(node[k])) node[k] = {};
    node = node[k] as Record<string, Json>;
  }
  const last = keys[keys.length - 1]!;
  const r = resolve(v, node[last], time);
  if (r === undefined) delete node[last];
  else node[last] = r;
}

/** set (replace) or merge (deep, as setDoc(…, { merge: true })). */
export function applyWrite(base: Record<string, Json>, data: Record<string, Json>, kind: 'set' | 'merge', time: { s: number; n: number }): Record<string, Json> {
  if (kind === 'set') return (resolve(data, undefined, time) ?? {}) as Record<string, Json>;
  mergeInto(base, data, time);
  return base;
}

/** update: each entry sets the field at its key path. */
export function applyUpdate(base: Record<string, Json>, fields: readonly { path: readonly string[]; value: Json }[], time: { s: number; n: number }): Record<string, Json> {
  for (const f of fields) setPath(base, f.path, f.value, time);
  return base;
}
