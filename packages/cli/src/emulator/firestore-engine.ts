import { createHash } from 'node:crypto';
// The server's document engine: Firestore semantics on SQL — SQLite (node:sqlite) or Postgres.
//
// One table holds every document (path, collection id, parent, data as tagged JSON). Every
// field that a query filters or sorts on becomes an expression over that JSON, and IceBase
// creates a SQL index for each declared composite (IDX-5) — and for single fields the first
// time a query uses them. Queries the planner refuses (missing composite) never reach here.

import { IceBaseError } from '@panth977/icebase/errors';
import { dnf, fullOrder, isName, planQuery, type FilterNode, type OrderSpec, type QuerySpec, type WhereOp } from '@panth977/icebase/internal';

export { fullOrder } from '@panth977/icebase/internal';
import { tsKey, type Tagged } from '@panth977/icebase/internal';
import { fieldAt, matchCollectionPath, showPath, type AnyCollection, type Schema } from '@panth977/icebase/schema';
import type { Sql, Store } from './store.ts';
import { firestoreTables } from './tables.ts';

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
  /** The store the documents live in (a SQLite file, or a Postgres schema). */
  store: Store;
  schema: Schema<Record<string, AnyCollection>, any, any>;
  /** Learning mode: report a missing index instead of refusing the query (never in production). */
  learn?: (missing: { collection: string; suggestion: string }) => void;
}

/** A field's sortable SQL expression; 'json' ones compare as JSON (Postgres: numbers, booleans). */
type Expr = { sql: string; json: boolean };

export class FirestoreEngine {
  readonly store: Store;
  private readonly pg: boolean;
  private readonly colls: AnyCollection[] = [];
  private readonly listeners = new Set<(changes: Change[]) => void>();
  /** The SQL indexes built from the declared ones (IDX-5), for the console. */
  readonly sqlIndexes: string[] = [];
  private version = 0;
  private lastTime = 0;

  private readonly learn: EngineOptions['learn'];
  private constructor(opts: EngineOptions) {
    this.learn = opts.learn;
    this.store = opts.store;
    this.pg = opts.store.dialect === 'postgres';
  }

  static async open(opts: EngineOptions): Promise<FirestoreEngine> {
    const e = new FirestoreEngine(opts);
    await firestoreTables(e.store);
    e.version = Number((await e.store.get<{ v: number | null }>(`SELECT MAX(version) v FROM docs`))?.v ?? 0);
    await e.setSchema(opts.schema);
    return e;
  }

  /** The schema the engine plans queries with: its declared indexes are built, earlier ones dropped. */
  async setSchema(schema: Schema<Record<string, AnyCollection>, any, any>): Promise<void> {
    this.colls.length = 0;
    this.colls.push(...Object.values(schema.collections));
    this.sqlIndexes.length = 0;
    const wanted = new Set<string>();
    for (const c of this.colls) await this.ensureIndexes(c, wanted);
    // Indexes from an earlier schema (an index removed or changed) go.
    const existing = this.pg
      ? await this.store.all<{ name: string }>(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'ix\\_%'`)
      : await this.store.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix\\_%' ESCAPE '\\'`);
    for (const r of existing) {
      if (!wanted.has(r.name)) await this.store.exec(`DROP INDEX IF EXISTS "${r.name}"`);
    }
  }

  /** The declared collection a query reads: by its path, else (a collection-group query) by id. */
  private collectionFor(spec: QuerySpec): AnyCollection | undefined {
    if (spec.path !== null) return matchCollectionPath({ collections: Object.fromEntries(this.colls.map((c, i) => [i, c])), paths: {}, files: {} }, spec.path)?.collection;
    return this.colls.find((c) => c.id === spec.collectionId && c.group) ?? this.colls.find((c) => c.id === spec.collectionId);
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  onChanges(cb: (changes: Change[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async count(): Promise<number> {
    return Number((await this.store.get<{ n: number }>(`SELECT COUNT(*) n FROM docs`))!.n);
  }

  // ── SQL expressions ─────────────────────────────────────────────────────────

  /** The JSON path of a key path: SQLite '$."a"."b"', Postgres '{"a","b"}' (schema field names never contain quotes). */
  private jpath(path: readonly string[]): string {
    if (this.pg) return `'{${path.map((k) => `"${k.replace(/[\\"]/g, '\\$&').replace(/'/g, "''")}"`).join(',')}}'`;
    return `'$${path.map((k) => `."${k}"`).join('')}'`;
  }

  /** SQL: the field is present (null included). */
  private present(path: readonly string[]): string {
    return this.pg ? `(data #> ${this.jpath(path)}) IS NOT NULL` : `json_type(data, ${this.jpath(path)}) IS NOT NULL`;
  }

  /** SQL: the JSON type of the field ('null', …). */
  private jsonType(path: readonly string[]): string {
    return this.pg ? `json_typeof(data #> ${this.jpath(path)})` : `json_type(data, ${this.jpath(path)})`;
  }

  /** The SQL expression for a field's sortable key, when its type allows one. */
  private expr(coll: AnyCollection | undefined, path: readonly string[]): Expr | null {
    if (isName(path)) return { sql: 'path', json: false };
    if (!coll) return null;
    const def = fieldAt(coll.fields, path, coll.rest);
    if (!def) return null;
    const kind = def.def.kind;
    if (this.pg) {
      // Strings compare bytewise (COLLATE "C"), as Firestore orders them; numbers and booleans as JSON.
      const text = (p: readonly string[]): Expr => ({ sql: `((data #>> ${this.jpath(p)}) COLLATE "C")`, json: false });
      switch (kind) {
        case 'string':
        case 'enum':
          return text(path);
        case 'number':
        case 'boolean':
        case 'literal':
          return { sql: `((data #> ${this.jpath(path)})::jsonb)`, json: true };
        case 'timestamp':
          return text([...path, 'k']);
        case 'ref':
          return text([...path, 'p']);
        default:
          return null;
      }
    }
    const p = this.jpath(path);
    switch (kind) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'enum':
      case 'literal':
        return { sql: `json_extract(data, ${p})`, json: false };
      case 'timestamp':
        return { sql: `json_extract(data, ${p.slice(0, -1)}.k')`, json: false };
      case 'ref':
        return { sql: `json_extract(data, ${p.slice(0, -1)}.p')`, json: false };
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

  /** A placeholder for a value compared with `e`, its parameter pushed. */
  private ph(e: Expr, v: unknown, params: unknown[]): string {
    if (e.json) {
      params.push(JSON.stringify(v));
      return '?::jsonb';
    }
    params.push(this.param(v));
    return '?';
  }

  /** IDX-5: one SQL index per declared index — single-field and composite — and no others. */
  private async ensureIndexes(c: AnyCollection, wanted: Set<string>): Promise<void> {
    // A {rest=**} collection spans many collection ids: answered by scanning.
    if (c.glob) return;
    for (const ix of c.indexes) {
      const cols = ix.fields.filter((f) => f.mode !== 'contains').map((f) => {
        const e = this.expr(c, f.path);
        return e ? `${this.pg ? `(${e.sql})` : e.sql} ${f.mode === 'desc' ? 'DESC' : 'ASC'}` : null;
      });
      // An index on an array (array-contains) or a map has no SQL column; it is answered by scanning the collection.
      if (cols.some((x) => x === null) || cols.length === 0) continue;
      const coll = c.id.replace(/'/g, "''");
      const make = async (cols2: string) => {
        // Named after its definition, so a changed index is a new one (and the old one is dropped).
        const name = `ix_${createHash('sha1').update(`${coll}|${cols2}`).digest('hex').slice(0, 16)}`;
        wanted.add(name);
        await this.store.exec(`CREATE INDEX IF NOT EXISTS "${name}" ON docs (${cols2}, path) WHERE coll = '${coll}'`);
      };
      await make(`parent, ${cols.join(', ')}`);
      if (c.group) await make(cols.join(', '));
      this.sqlIndexes.push(`${c.path}: ${ix.fields.map((f) => `${showPath(f.path)} ${f.mode}`).join(', ')}`);
    }
  }

  private rowToDoc(r: Record<string, unknown>): StoredDoc {
    return {
      path: r.path as string,
      id: r.id as string,
      // Postgres hands JSON columns back parsed.
      data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Record<string, Json>,
      createTime: { s: Number(r.ct_s), n: Number(r.ct_n) },
      updateTime: { s: Number(r.ut_s), n: Number(r.ut_n) },
      version: Number(r.version),
    };
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  private async getOn(sql: Sql, path: string): Promise<StoredDoc | null> {
    const r = await sql.get(`SELECT * FROM docs WHERE path = ?`, path);
    return r ? this.rowToDoc(r) : null;
  }

  get(path: string): Promise<StoredDoc | null> {
    return this.getOn(this.store, path);
  }

  async getAll(paths: string[]): Promise<(StoredDoc | null)[]> {
    const out: (StoredDoc | null)[] = [];
    for (const p of paths) out.push(await this.get(p));
    return out;
  }

  /** Run a query. `cursorStart`/`cursorEnd` values are aligned with fullOrder(spec). */
  async query(spec: QuerySpec, aggregated: string[][] = []): Promise<StoredDoc[]> {
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
    const TRUE = this.pg ? 'TRUE' : '1';
    for (const conj of conjs) {
      const parts: string[] = [];
      for (const f of conj) {
        const s = this.filterSql(coll, f, params);
        if (s === null) exact = false;
        else parts.push(s);
      }
      sqlConj.push(parts.length ? `(${parts.join(' AND ')})` : TRUE);
    }
    // A conjunction missing a filter SQL can't express is a superset; JS narrows it below.
    if (conjs.length && !sqlConj.includes(TRUE)) where.push(`(${sqlConj.join(' OR ')})`);
    // Documents without an ordered field are not in the result (Firestore semantics).
    for (const o of order) {
      if (isName(o.field)) continue;
      where.push(this.present(o.field));
    }
    const orderSql: string[] = [];
    for (const o of order) {
      const e = this.expr(coll, o.field);
      if (!e) {
        exact = false;
        break;
      }
      orderSql.push(`${e.sql} ${o.dir === 'asc' ? 'ASC' : 'DESC'}`);
    }
    if (spec.start?.values.length || spec.end?.values.length) exact = false;
    const reverse = spec.limit?.last === true;
    let sql = `SELECT * FROM docs WHERE ${where.join(' AND ')}`;
    if (exact && orderSql.length === order.length) {
      sql += ` ORDER BY ${orderSql.map((s) => (reverse ? s.replace(/ ASC$/, ' __D').replace(/ DESC$/, ' ASC').replace(/ __D$/, ' DESC') : s)).join(', ')}`;
      if (spec.limit) sql += ` LIMIT ${Number(spec.limit.n)}`;
      const rows = (await this.store.all(sql, ...params)).map((r) => this.rowToDoc(r));
      return reverse ? rows.reverse() : rows;
    }
    // Something SQL can't say exactly (maps, nested fields, cursors): finish in JS.
    let docs = (await this.store.all(sql, ...params)).map((r) => this.rowToDoc(r));
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
      const vals = f.op === 'array-contains' ? [f.value] : (f.value as unknown[]);
      if (this.pg) {
        const ve: Expr | null = el === 'timestamp' ? { sql: `(value #>> '{k}')`, json: false } : el === 'ref' ? { sql: `(value #>> '{p}')`, json: false } : ['string', 'enum'].includes(el) ? { sql: `(value #>> '{}')`, json: false } : ['number', 'boolean'].includes(el) ? { sql: 'value::jsonb', json: true } : null;
        if (!ve) return null;
        const arr = `data #> ${jp}`;
        return `EXISTS (SELECT 1 FROM json_array_elements(CASE WHEN json_typeof(${arr}) = 'array' THEN ${arr} ELSE '[]'::json END) AS el(value) WHERE ${ve.sql} IN (${vals.map((v) => this.ph(ve, v, params)).join(', ')}))`;
      }
      const valueExpr = el === 'timestamp' ? `json_extract(value, '$.k')` : el === 'ref' ? `json_extract(value, '$.p')` : ['string', 'number', 'boolean', 'enum'].includes(el) ? 'value' : null;
      if (!valueExpr) return null;
      params.push(...vals.map((v) => this.param(v)));
      return `EXISTS (SELECT 1 FROM json_each(data, ${jp}) WHERE ${valueExpr} IN (${vals.map(() => '?').join(', ')}))`;
    }
    const e = this.expr(coll, f.field);
    if (!e) return null;
    const [T, F] = this.pg ? ['TRUE', 'FALSE'] : ['1', '0'];
    const present = isName(f.field) ? T : this.present(f.field);
    const notNull = isName(f.field) ? T : this.pg ? `${this.jsonType(f.field)} <> 'null'` : `${this.jsonType(f.field)} NOT IN ('null')`;
    if (f.value === null) {
      if (f.op === '==') return `${this.jsonType(f.field)} = 'null'`;
      if (f.op === '!=') return `(${present} AND ${notNull})`;
      return F;
    }
    switch (f.op) {
      case '==':
      case '<':
      case '<=':
      case '>':
      case '>=':
        return `(${present} AND ${e.sql} ${f.op === '==' ? '=' : f.op} ${this.ph(e, f.value, params)})`;
      case '!=':
        return `(${present} AND ${notNull} AND ${e.sql} <> ${this.ph(e, f.value, params)})`;
      case 'in':
      case 'not-in': {
        const vals = f.value as unknown[];
        if (vals.some((v) => v === null)) return null;
        return `(${present} AND ${f.op === 'not-in' ? `${notNull} AND ` : ''}${e.sql} ${f.op === 'in' ? 'IN' : 'NOT IN'} (${vals.map((v) => this.ph(e, v, params)).join(', ')}))`;
      }
    }
    return null;
  }

  async aggregate(spec: QuerySpec, aggs: Record<string, { op: 'count' } | { op: 'sum' | 'avg'; field: string | string[] }>): Promise<Record<string, number | null>> {
    // sum() / average() fields are part of the index the query needs (as in Firestore).
    const docs = await this.query(spec, Object.values(aggs).flatMap((a) => (a.op === 'count' ? [] : [typeof a.field === 'string' ? [a.field] : a.field])));
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
  async commit(writes: Write[], preconditions: Precondition[] = []): Promise<{ time: { s: number; n: number }; changes: Change[] }> {
    const out = await this.store.transaction(async (tx) => {
      // Under the store's write lock: commit times and versions follow commit order.
      const time = this.now();
      const changes: Change[] = [];
      // Another process may share the store: continue from the version it left.
      const stored = await tx.get<{ v: string }>(`SELECT v FROM meta WHERE k = 'version'`);
      if (stored) this.version = Math.max(this.version, Number(stored.v));
      for (const p of preconditions) {
        const cur = await this.getOn(tx, p.path);
        if ((cur?.version ?? 0) !== p.version) throw new IceBaseError('aborted', `Transaction lost a race on ${p.path}; retrying`, {});
      }
      const pending = new Map<string, StoredDoc | null>();
      const current = async (path: string) => (pending.has(path) ? pending.get(path)! : await this.getOn(tx, path));
      for (const w of writes) {
        const before = await current(w.path);
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
        if (!d) await tx.run(`DELETE FROM docs WHERE path = ?`, path);
        else
          await tx.run(
            `INSERT INTO docs (path, coll, parent, id, data, ct_s, ct_n, ut_s, ut_n, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET data = excluded.data, ut_s = excluded.ut_s, ut_n = excluded.ut_n, version = excluded.version`,
            path, collIdOf(path), parentOf(path), d.id, JSON.stringify(d.data), d.createTime.s, d.createTime.n, d.updateTime.s, d.updateTime.n, d.version,
          );
      }
      await tx.run(`INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, String(this.version));
      return { time, changes };
    });
    if (out.changes.length) for (const l of this.listeners) l(out.changes);
    return out;
  }

  async listCollections(docPath: string | null): Promise<string[]> {
    const top = this.pg ? `strpos(parent, '/') = 0` : `instr(parent, '/') = 0`;
    const rows = docPath
      ? await this.store.all<{ coll: string; parent: string }>(`SELECT DISTINCT coll, parent FROM docs WHERE parent LIKE ? ESCAPE '\\'`, `${docPath.replace(/[\\%_]/g, '\\$&')}/%`)
      : await this.store.all<{ coll: string; parent: string }>(`SELECT DISTINCT coll, parent FROM docs WHERE ${top}`);
    const want = docPath ? docPath.split('/').length + 1 : 1;
    return [...new Set(rows.filter((r) => r.parent.split('/').length === want).map((r) => r.coll))].sort();
  }

  async recursiveDelete(path: string): Promise<number> {
    const like = `${path.replace(/[\\%_]/g, '\\$&')}/%`;
    const victims = (await this.store.all<{ path: string }>(`SELECT path FROM docs WHERE path = ? OR path LIKE ? ESCAPE '\\'`, path, like)).map((r) => r.path);
    if (victims.length) await this.commit(victims.map((p) => ({ op: 'delete', path: p })));
    return victims.length;
  }

  /** Every document in path order (export, migrate, the console), a page at a time. */
  async *scan(): AsyncGenerator<StoredDoc> {
    let after = '';
    for (;;) {
      const rows = await this.store.all(`SELECT * FROM docs WHERE path > ? ORDER BY path LIMIT 500`, after);
      for (const r of rows) yield this.rowToDoc(r);
      if (rows.length < 500) return;
      after = rows[rows.length - 1]!.path as string;
    }
  }

  /** Copy documents in as they are (versions and times kept): migrate. */
  async load(docs: StoredDoc[]): Promise<void> {
    await this.store.transaction(async (tx) => {
      for (const d of docs) {
        await tx.run(
          `INSERT INTO docs (path, coll, parent, id, data, ct_s, ct_n, ut_s, ut_n, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET data = excluded.data, ct_s = excluded.ct_s, ct_n = excluded.ct_n, ut_s = excluded.ut_s, ut_n = excluded.ut_n, version = excluded.version`,
          d.path, collIdOf(d.path), parentOf(d.path), d.id, JSON.stringify(d.data), d.createTime.s, d.createTime.n, d.updateTime.s, d.updateTime.n, d.version,
        );
        this.version = Math.max(this.version, d.version);
      }
      await tx.run(`INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, String(this.version));
    });
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
