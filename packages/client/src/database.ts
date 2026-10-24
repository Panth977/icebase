// icebase/database — the Realtime Database with Firebase's names (firebase/database), typed
// from the dbPath() declarations in the schema. Writes are validated; orderByChild() needs the
// child in the path's indexOn (IDX-6), in every mode.

import * as rd from 'firebase/database';
import { service, type IceBaseApp } from './app.ts';
import { emulatorDatabaseDriver } from './drivers/database-emulator.ts';
import { webDatabaseDriver } from './drivers/database-web.ts';
import { IceBaseError } from './errors.ts';
import type { DatabaseDriver, DbEvent, DbQuery, RawDbSnapshot } from './internal/database-driver.ts';
import { nativeWebApp } from './internal/firebase-web-app.ts';
import { validateValue, type AnyDbPath, type DbValueOf, type Field } from './schema.ts';
import { FieldValue } from './values.ts';

// ─── the database ──────────────────────────────────────────────────────────────

export class Database {
  readonly type = 'database';
  constructor(
    readonly app: IceBaseApp,
    /** @internal */ readonly _driver: DatabaseDriver,
    /** @internal the SDK instance (client, firebase mode) for connectDatabaseEmulator */ readonly _native?: rd.Database,
  ) {}
}

export function getDatabase(app: IceBaseApp, url?: string): Database {
  if (app.kind === 'admin') throw new IceBaseError('invalid-argument', 'This is an admin app: use getAdminDatabase(app) from icebase/admin', { reason: 'config' });
  return service(app, `database:${url ?? ''}`, () => {
    const mode = app.modes.database;
    if (mode === 'emulator') return new Database(app, emulatorDatabaseDriver(app));
    if (mode !== 'firebase') throw new IceBaseError('unimplemented', `the Realtime Database in ${mode} mode is not available yet`, { reason: 'mode', service: 'database' });
    const native = url ? rd.getDatabase(nativeWebApp(app), url) : rd.getDatabase(nativeWebApp(app));
    return new Database(app, webDatabaseDriver(native), native);
  });
}

/** Point a client Database at the official Firebase database emulator (firebase mode). */
export function connectDatabaseEmulator(db: Database, host: string, port: number): void {
  if (!db._native) throw new IceBaseError('invalid-argument', 'connectDatabaseEmulator: not a firebase-mode client Database');
  rd.connectDatabaseEmulator(db._native, host, port);
}
export function goOffline(db: Database): void {
  db._driver.goOffline?.();
}
export function goOnline(db: Database): void {
  db._driver.goOnline?.();
}

// ─── references ────────────────────────────────────────────────────────────────

type Params<P extends string> = P extends `${string}{${string}}${infer R}` ? [string, ...Params<R>] : [];
type DropLast<T extends unknown[]> = T extends [...infer H, unknown] ? H : never;
type EndsWithParam<P extends string> = P extends `${string}}` ? true : false;

/** What a reference points at in the schema: the declared value, a list of them, or a child of one. */
type Shape = { kind: 'item'; field: Field<unknown> } | { kind: 'list'; field: Field<unknown> } | { kind: 'none' };

export class DatabaseReference<T = unknown> {
  /** @internal */ readonly __t?: T;
  constructor(
    readonly database: Database,
    /** The path without leading slash; '' is the root. */
    readonly path: string,
    /** @internal */ readonly _shape: Shape,
    /** @internal */ readonly _decl: AnyDbPath | null,
    /** @internal */ readonly _query: DbQuery | null = null,
  ) {}
  get key(): string | null {
    return this.path === '' ? null : this.path.slice(this.path.lastIndexOf('/') + 1);
  }
  get root(): DatabaseReference<unknown> {
    return new DatabaseReference(this.database, '', { kind: 'none' }, null);
  }
  get parent(): DatabaseReference<unknown> | null {
    if (this.path === '') return null;
    const i = this.path.lastIndexOf('/');
    return new DatabaseReference(this.database, i < 0 ? '' : this.path.slice(0, i), { kind: 'none' }, null);
  }
  /** Same as Firebase: the absolute URL-ish path. */
  toString(): string {
    return `/${this.path}`;
  }
  toJSON(): string {
    return this.toString();
  }
}

/** A query (orderBy… / limit…) on a list reference. */
export type Query<T = unknown> = DatabaseReference<T>;

const KEY = /^[^.#$[\]/]+$/;
const checkKey = (k: string, where: string) => {
  if (typeof k !== 'string' || !KEY.test(k)) throw new IceBaseError('invalid-argument', `${where}: '${k}' is not a valid key (no '.', '#', '$', '[', ']' or '/')`, { service: 'database' });
  return k;
};

/** ref(db, messages, roomId, msgId) → one message · ref(db, messages, roomId) → the list of them. */
export function ref<D extends AnyDbPath>(db: Database, p: D, ...params: Params<D['path']>): DatabaseReference<DbValueOf<D>>;
export function ref<D extends AnyDbPath>(db: Database, p: D, ...params: EndsWithParam<D['path']> extends true ? DropLast<Params<D['path']>> : [never]): DatabaseReference<Record<string, DbValueOf<D>>>;
export function ref(db: Database, p: AnyDbPath, ...params: string[]): DatabaseReference<unknown> {
  if (!(db instanceof Database)) throw new IceBaseError('invalid-argument', 'ref(db, dbPath, …params): the first argument must be a Database');
  if (!p || p.kind !== 'dbPath') throw new IceBaseError('invalid-argument', 'ref(db, dbPath, …params): pass a dbPath(…) from your schema, not a string', { reason: 'unknown-collection', service: 'database' });
  if (!Object.values(db.app.config.schema.paths ?? {}).includes(p)) throw new IceBaseError('invalid-argument', `dbPath('${p.path}') is not in this app's schema (defineSchema(…, { paths }))`, { reason: 'unknown-collection', service: 'database' });
  const n = p.params.length;
  const list = params.length === n - 1 && p.path.endsWith('}');
  if (params.length !== n && !list) throw new IceBaseError('invalid-argument', `ref(db, '${p.path}'): needs ${n} path parameter(s)${p.path.endsWith('}') ? ` (or ${n - 1} for the list)` : ''}, got ${params.length}`, { reason: 'schema', service: 'database' });
  let i = 0;
  const segs = p.path.split('/');
  const filled = (list ? segs.slice(0, -1) : segs).map((s) => (/^\{.+\}$/.test(s) ? checkKey(params[i++]!, `ref('${p.path}')`) : s));
  return new DatabaseReference(db, filled.join('/'), list ? { kind: 'list', field: p.value } : { kind: 'item', field: p.value }, p);
}

/** child(listRef, key) → one item · child(itemRef, 'field') → that field. */
export function child<T, K extends keyof T & string>(parent: DatabaseReference<T>, key: K): DatabaseReference<T[K]> {
  const segs = String(key).split('/');
  segs.forEach((s) => checkKey(s, `child(${parent.toString()})`));
  let shape: Shape = parent._shape;
  for (const s of segs) {
    if (shape.kind === 'list') shape = { kind: 'item', field: shape.field };
    else if (shape.kind === 'item' && shape.field.def.kind === 'map' && shape.field.def.fields[s]) shape = { kind: 'item', field: shape.field.def.fields[s]! };
    else shape = { kind: 'none' };
  }
  return new DatabaseReference(parent.database, parent.path ? `${parent.path}/${key}` : String(key), shape, parent._decl);
}

// ─── queries ───────────────────────────────────────────────────────────────────

export interface QueryConstraint {
  /** @internal */ readonly _apply: (q: DbQuery, r: DatabaseReference<unknown>) => DbQuery;
}
type ItemOf<T> = T extends Record<string, infer V> ? V : never;

const qc = (f: QueryConstraint['_apply']): QueryConstraint => ({ _apply: f });
const orderOnce = (q: DbQuery, name: string) => {
  if (q.orderBy) throw new IceBaseError('invalid-argument', `${name}: a query has one orderBy…() only`, { service: 'database' });
};
/** orderByChild('at') · orderByChild(['meta', 'at']) — the child must be in the path's indexOn (IDX-6, checked when the query is built). */
export function orderByChild(child: string | readonly string[]): QueryConstraint {
  const path = typeof child === 'string' ? child : child.join('/');
  return qc((q, r) => {
    orderOnce(q, `orderByChild('${path}')`);
    if (r._decl && !r._decl.indexOn.includes(path)) {
      throw new IceBaseError('failed-precondition', `orderByChild('${path}') on '${r._decl.path}' needs '${path}' in its indexOn.\nAdd indexOn: [${[...r._decl.indexOn, path].map((x) => `'${x}'`).join(', ')}] to dbPath('${r._decl.path}', …) in your schema.`, { reason: 'missing-index', service: 'database', path: r._decl.path, index: path });
    }
    return { ...q, orderBy: { kind: 'child', child: path } };
  });
}
export const orderByKey = (): QueryConstraint => qc((q) => (orderOnce(q, 'orderByKey()'), { ...q, orderBy: { kind: 'key' } }));
export const orderByValue = (): QueryConstraint => qc((q) => (orderOnce(q, 'orderByValue()'), { ...q, orderBy: { kind: 'value' } }));
type Primitive = string | number | boolean | null;
export const startAt = (value: Primitive = null, key?: string): QueryConstraint => qc((q) => ({ ...q, startAt: { value, ...(key ? { key } : {}) } }));
export const endAt = (value: Primitive = null, key?: string): QueryConstraint => qc((q) => ({ ...q, endAt: { value, ...(key ? { key } : {}) } }));
export const equalTo = (value: Primitive, key?: string): QueryConstraint => qc((q) => ({ ...q, equalTo: { value, ...(key ? { key } : {}) } }));
export const limitToFirst = (n: number): QueryConstraint => qc((q) => ({ ...q, limitToFirst: n }));
export const limitToLast = (n: number): QueryConstraint => qc((q) => ({ ...q, limitToLast: n }));

export function query<T>(r: DatabaseReference<T>, ...constraints: QueryConstraint[]): Query<T> {
  let q: DbQuery = { ...(r._query ?? {}) };
  for (const c of constraints) q = c._apply(q, r as DatabaseReference<unknown>);
  return new DatabaseReference(r.database, r.path, r._shape, r._decl, q);
}

// ─── snapshots ─────────────────────────────────────────────────────────────────

export class DataSnapshot<T = unknown> {
  constructor(
    readonly ref: DatabaseReference<T>,
    /** @internal */ readonly _raw: RawDbSnapshot,
  ) {}
  get key(): string | null {
    return this.ref.key;
  }
  val(): T | null {
    return this._raw.value as T | null;
  }
  exportVal(): T | null {
    return this.val();
  }
  exists(): boolean {
    return this._raw.value !== null && this._raw.value !== undefined;
  }
  get size(): number {
    return this._raw.children?.length ?? 0;
  }
  hasChildren(): boolean {
    return this.size > 0;
  }
  hasChild(path: string): boolean {
    return this.child(path as keyof T & string).exists();
  }
  child<K extends keyof T & string>(path: K): DataSnapshot<T[K]> {
    const value = String(path)
      .split('/')
      .reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : null), this._raw.value);
    return new DataSnapshot(child(this.ref, path), { key: String(path).split('/').pop()!, value: value ?? null, children: childrenOf(value) });
  }
  /** Children in query order, like Firebase. Return true to stop. */
  forEach(cb: (child: DataSnapshot<ItemOf<T>>) => boolean | void): boolean {
    for (const c of this._raw.children ?? []) {
      const r = child(this.ref as DatabaseReference<Record<string, ItemOf<T>>>, c.key);
      if (cb(new DataSnapshot(r, { key: c.key, value: c.value, children: childrenOf(c.value) })) === true) return true;
    }
    return false;
  }
  toJSON(): T | null {
    return this.val();
  }
}

const childrenOf = (v: unknown) => (v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value })) : null);

// ─── writes ────────────────────────────────────────────────────────────────────

/** The Realtime Database's serverTimestamp(): milliseconds since the epoch, filled in by the server. */
export const serverTimestamp = (): FieldValue & number => new FieldValue('serverTime') as FieldValue & number;
export const increment = (delta: number): FieldValue & number => new FieldValue('increment', delta) as FieldValue & number;

function validated(r: DatabaseReference<unknown>, value: unknown, op: string): unknown {
  if (value === null) {
    // null removes: fine for a list item, a whole list and optional fields; not for a required field.
    const listItem = !!r._decl && r._decl.path.endsWith('}') && r.path.split('/').length === r._decl.path.split('/').length;
    if (r._shape.kind === 'item' && !r._shape.field.optional && !listItem) {
      throw new IceBaseError('invalid-argument', `${op}(${r.toString()}, null) would remove a required value`, { reason: 'schema', service: 'database' });
    }
    return null;
  }
  switch (r._shape.kind) {
    case 'item':
      return validateValue(r._shape.field, value, r.toString());
    case 'list': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IceBaseError('invalid-argument', `${op}(${r.toString()}): a list location takes an object of items keyed by id`, { reason: 'schema', service: 'database' });
      const field = r._shape.field;
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [checkKey(k, op), validateValue(field, v, `${r.toString()}/${k}`)]));
    }
    case 'none':
      throw new IceBaseError('invalid-argument', `${op}(${r.toString()}): this location is not in the schema; IceBase only writes declared paths`, { reason: 'unknown-collection', service: 'database' });
  }
}

export async function set<T>(r: DatabaseReference<T>, value: T | null): Promise<void> {
  await r.database._driver.set(r.path, validated(r as DatabaseReference<unknown>, value, 'set'));
}

/** update(ref, { a: 1, 'b/c': 2 }) — each key replaces that child. */
export async function update<T>(r: DatabaseReference<T>, values: Partial<T> | Record<string, unknown>): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = validated(child(r as DatabaseReference<Record<string, unknown>>, k) as DatabaseReference<unknown>, v, 'update');
  await r.database._driver.update(r.path, out);
}

export async function remove<T>(r: DatabaseReference<T>): Promise<void> {
  await r.database._driver.remove(r.path);
}

export interface ThenableReference<T> extends DatabaseReference<T>, Pick<Promise<DatabaseReference<T>>, 'then' | 'catch'> {}

/** push(listRef, value) — a new chronological key, like Firebase. Without a value, only the reference. */
export function push<V>(r: DatabaseReference<Record<string, V>>, value?: V): ThenableReference<V> {
  if (r._shape.kind !== 'list') throw new IceBaseError('invalid-argument', `push(${r.toString()}): push onto a list reference (ref(db, path) without its last parameter)`, { reason: 'schema', service: 'database' });
  const key = r.database._driver.newKey(r.path);
  const plain = () => child(r, key) as DatabaseReference<V>;
  // Resolves to a plain (non-thenable) reference, or awaiting it would loop forever.
  const p: Promise<DatabaseReference<V>> = value === undefined ? Promise.resolve(plain()) : set(plain(), value).then(plain);
  return Object.assign(plain(), { then: p.then.bind(p), catch: p.catch.bind(p) }) as ThenableReference<V>;
}

// ─── reads and listeners ───────────────────────────────────────────────────────

export async function get<T>(q: DatabaseReference<T>): Promise<DataSnapshot<T>> {
  return new DataSnapshot(q, await q.database._driver.get(q.path, q._query));
}

export type Unsubscribe = () => void;
const subs = new WeakMap<DatabaseReference<unknown>, Unsubscribe[]>();
const listen = <T, S>(event: DbEvent, mk: (q: DatabaseReference<T>, raw: RawDbSnapshot) => S) =>
  (q: DatabaseReference<T>, cb: (s: S, previousChildName?: string | null) => void, cancel?: (e: Error) => void): Unsubscribe => {
    const un = q.database._driver.listen(q.path, q._query, event, (raw, prev) => cb(mk(q, raw), prev), cancel ?? ((e) => console.error('[icebase] database listener cancelled', e)));
    const list = subs.get(q as DatabaseReference<unknown>) ?? [];
    list.push(un);
    subs.set(q as DatabaseReference<unknown>, list);
    return () => {
      un();
      const l = subs.get(q as DatabaseReference<unknown>);
      if (l) l.splice(l.indexOf(un) >>> 0, 1);
    };
  };

const whole = <T>(q: DatabaseReference<T>, raw: RawDbSnapshot) => new DataSnapshot(q, raw);
const item = <T>(q: DatabaseReference<T>, raw: RawDbSnapshot) => new DataSnapshot(child(q as DatabaseReference<Record<string, ItemOf<T>>>, raw.key!), raw);

export function onValue<T>(q: DatabaseReference<T>, cb: (s: DataSnapshot<T>) => void, cancel?: (e: Error) => void): Unsubscribe {
  return listen<T, DataSnapshot<T>>('value', whole)(q, cb, cancel);
}
export function onChildAdded<T>(q: DatabaseReference<T>, cb: (s: DataSnapshot<ItemOf<T>>, previousChildName?: string | null) => void, cancel?: (e: Error) => void): Unsubscribe {
  return listen<T, DataSnapshot<ItemOf<T>>>('child_added', item)(q, cb, cancel);
}
export function onChildChanged<T>(q: DatabaseReference<T>, cb: (s: DataSnapshot<ItemOf<T>>, previousChildName?: string | null) => void, cancel?: (e: Error) => void): Unsubscribe {
  return listen<T, DataSnapshot<ItemOf<T>>>('child_changed', item)(q, cb, cancel);
}
export function onChildRemoved<T>(q: DatabaseReference<T>, cb: (s: DataSnapshot<ItemOf<T>>) => void, cancel?: (e: Error) => void): Unsubscribe {
  return listen<T, DataSnapshot<ItemOf<T>>>('child_removed', item)(q, cb, cancel);
}

/** Firebase's off(): stops every listener started on this reference with the functions above (prefer the returned unsubscribe). */
export function off(q: DatabaseReference<unknown>): void {
  for (const u of subs.get(q) ?? []) u();
  subs.delete(q);
}

// ─── transactions and presence ─────────────────────────────────────────────────

export interface TransactionResult<T> {
  committed: boolean;
  snapshot: DataSnapshot<T>;
}

/** runTransaction(ref, cur => next) — return undefined to abort. `next` is validated like set(). */
export async function runTransaction<T>(r: DatabaseReference<T>, update: (current: T | null) => T | null | undefined, options: { applyLocally?: boolean } = {}): Promise<TransactionResult<T>> {
  const res = await r.database._driver.transaction(
    r.path,
    (cur) => {
      const next = update(cur as T | null);
      return next === undefined ? undefined : validated(r as DatabaseReference<unknown>, next, 'runTransaction');
    },
    options.applyLocally ?? true,
  );
  return { committed: res.committed, snapshot: new DataSnapshot(r, res.snapshot) };
}

export class OnDisconnect<T> {
  constructor(/** @internal */ readonly _r: DatabaseReference<T>) {}
  set(value: T | null): Promise<void> {
    return this._r.database._driver.onDisconnect(this._r.path).set(validated(this._r as DatabaseReference<unknown>, value, 'onDisconnect().set'));
  }
  update(values: Partial<T>): Promise<void> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) out[k] = validated(child(this._r as DatabaseReference<Record<string, unknown>>, k) as DatabaseReference<unknown>, v, 'onDisconnect().update');
    return this._r.database._driver.onDisconnect(this._r.path).update(out);
  }
  remove(): Promise<void> {
    return this._r.database._driver.onDisconnect(this._r.path).remove();
  }
  cancel(): Promise<void> {
    return this._r.database._driver.onDisconnect(this._r.path).cancel();
  }
}
export function onDisconnect<T>(r: DatabaseReference<T>): OnDisconnect<T> {
  return new OnDisconnect(r);
}

// ─── rules (IDX-6) ─────────────────────────────────────────────────────────────

/** database.rules.json with each declared path's .indexOn merged in ('{param}' becomes '$param'). */
export function databaseRulesJson(paths: Record<string, AnyDbPath>, base: { rules: Record<string, unknown> } = { rules: {} }): { rules: Record<string, unknown> } {
  const out = structuredClone(base);
  for (const p of Object.values(paths)) {
    if (!p.indexOn.length) continue;
    const segs = p.path.split('/').map((s) => s.replace(/^\{(.+)\}$/, '$$$1'));
    // The index lives on the list: the parent of the last ($key) segment.
    const listSegs = /^\$/.test(segs[segs.length - 1]!) ? segs.slice(0, -1) : segs;
    let node = out.rules;
    for (const s of listSegs) node = (node[s] ??= {}) as Record<string, unknown>;
    const existing = (node['.indexOn'] as string[] | string | undefined) ?? [];
    node['.indexOn'] = [...new Set([...(Array.isArray(existing) ? existing : [existing]), ...p.indexOn])];
  }
  return out;
}

export { DatabaseReference as Reference };
