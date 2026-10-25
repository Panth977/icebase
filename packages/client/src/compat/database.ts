// icebase/compat/database — the Firebase web SDK's modular Realtime Database API
// (firebase/database: ref(db, 'a/b'), onValue, set, push, onDisconnect …) over the IceBase server,
// for a web app written against Firebase that runs on IceBase unchanged. Paths are strings; the
// server applies database.rules.json.

import type { IceBaseApp } from '../app.ts';
import { emulatorDatabaseDriver } from '../drivers/database-emulator.ts';
import { IceBaseError } from '../errors.ts';
import type { DatabaseDriver, DbEvent, DbQuery, RawDbSnapshot } from '../internal/database-driver.ts';
import { FieldValue, isPlainObject } from '../values.ts';
import { configureIceBase, iceApp, refreshIceBaseAuth, type CompatSettings } from './shared.ts';

export { configureIceBase, refreshIceBaseAuth, type CompatSettings };

/** Firebase's database errors: a string code ('permission-denied' …). */
export class DatabaseError extends Error {
  override readonly name = 'FirebaseError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const wrapErr = (e: unknown): Error => (e instanceof IceBaseError ? new DatabaseError(e.code, e.message) : (e as Error));
async function guard<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (e) {
    throw wrapErr(e);
  }
}

export class Database {
  readonly type = 'database';
  /** @internal */ _driver: DatabaseDriver | null = null;
  constructor(readonly app: { name?: string } | null) {}
  /** @internal */
  get _ice(): IceBaseApp {
    return iceApp(this.app);
  }
  /** @internal */
  get _d(): DatabaseDriver {
    return (this._driver ??= emulatorDatabaseDriver(this._ice));
  }
}
const instances = new Map<string, Database>();
export function getDatabase(app?: { name?: string } | null, _url?: string): Database {
  const n = app?.name ?? '[DEFAULT]';
  let db = instances.get(n);
  if (!db) instances.set(n, (db = new Database(app ?? null)));
  return db;
}
/** The IceBase server is the backend already; kept for code that calls it. */
export function connectDatabaseEmulator(_db: Database, _host: string, _port: number): void {}
export function goOffline(db: Database): void {
  db._d.goOffline?.();
}
export function goOnline(db: Database): void {
  db._d.goOnline?.();
}

// ─── references and queries ─────────────────────────────────────────────────────

const clean = (p: string) =>
  p
    .split('/')
    .filter((s) => s !== '')
    .join('/');

export class DatabaseReference {
  constructor(
    /** @internal */ readonly _db: Database,
    /** @internal */ readonly _path: string,
    /** @internal */ readonly _q: DbQuery | null = null,
  ) {}
  get key(): string | null {
    return this._path ? this._path.slice(this._path.lastIndexOf('/') + 1) : null;
  }
  get parent(): DatabaseReference | null {
    if (!this._path) return null;
    const i = this._path.lastIndexOf('/');
    return new DatabaseReference(this._db, i < 0 ? '' : this._path.slice(0, i));
  }
  get root(): DatabaseReference {
    return new DatabaseReference(this._db, '');
  }
  get ref(): DatabaseReference {
    return this._q ? new DatabaseReference(this._db, this._path) : this;
  }
  isEqual(other: DatabaseReference | null): boolean {
    return !!other && other._path === this._path && JSON.stringify(other._q) === JSON.stringify(this._q);
  }
  toString(): string {
    return `/${this._path}`;
  }
  toJSON(): string {
    return this.toString();
  }
}
export type Query = DatabaseReference;
export { DatabaseReference as Reference };

export function ref(db: Database, path = ''): DatabaseReference {
  return new DatabaseReference(db, clean(path));
}
export function child(parent: DatabaseReference, path: string): DatabaseReference {
  return new DatabaseReference(parent._db, clean(`${parent._path}/${path}`));
}

export interface QueryConstraint {
  readonly type: string;
  /** @internal */ _apply(q: DbQuery): DbQuery;
}
const qc = (type: string, f: (q: DbQuery) => DbQuery): QueryConstraint => ({ type, _apply: f });
type Primitive = string | number | boolean | null;
export const orderByChild = (path: string): QueryConstraint => qc('orderByChild', (q) => ({ ...q, orderBy: { kind: 'child', child: clean(path) } }));
export const orderByKey = (): QueryConstraint => qc('orderByKey', (q) => ({ ...q, orderBy: { kind: 'key' } }));
export const orderByValue = (): QueryConstraint => qc('orderByValue', (q) => ({ ...q, orderBy: { kind: 'value' } }));
export const startAt = (value: Primitive = null, key?: string): QueryConstraint => qc('startAt', (q) => ({ ...q, startAt: { value, ...(key ? { key } : {}) } }));
export const endAt = (value: Primitive = null, key?: string): QueryConstraint => qc('endAt', (q) => ({ ...q, endAt: { value, ...(key ? { key } : {}) } }));
export const equalTo = (value: Primitive, key?: string): QueryConstraint => qc('equalTo', (q) => ({ ...q, equalTo: { value, ...(key ? { key } : {}) } }));
export const limitToFirst = (n: number): QueryConstraint => qc('limitToFirst', (q) => ({ ...q, limitToFirst: n }));
export const limitToLast = (n: number): QueryConstraint => qc('limitToLast', (q) => ({ ...q, limitToLast: n }));
export function query(r: DatabaseReference, ...constraints: QueryConstraint[]): DatabaseReference {
  let q: DbQuery = r._q ?? {};
  for (const c of constraints) q = c._apply(q);
  return new DatabaseReference(r._db, r._path, q);
}

// ─── snapshots ──────────────────────────────────────────────────────────────────

const childrenOf = (v: unknown) => (v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value })) : null);

export class DataSnapshot {
  constructor(
    readonly ref: DatabaseReference,
    /** @internal */ readonly _raw: RawDbSnapshot,
  ) {}
  get key(): string | null {
    return this.ref.key;
  }
  get priority(): null {
    return null;
  }
  val(): any {
    return this._raw.value ?? null;
  }
  exportVal(): any {
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
    return this.child(path).exists();
  }
  child(path: string): DataSnapshot {
    const value = clean(path)
      .split('/')
      .reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : null), this._raw.value);
    return new DataSnapshot(child(this.ref.ref, path), { key: clean(path).split('/').pop()!, value: value ?? null, children: childrenOf(value) });
  }
  forEach(action: (child: DataSnapshot & { key: string }) => boolean | void): boolean {
    for (const c of this._raw.children ?? []) {
      const s = new DataSnapshot(child(this.ref.ref, c.key), { key: c.key, value: c.value, children: childrenOf(c.value) }) as DataSnapshot & { key: string };
      if (action(s) === true) return true;
    }
    return false;
  }
  toJSON(): any {
    return this.val();
  }
}

// ─── reads and listeners ────────────────────────────────────────────────────────

/** '.info/…' is the client's own state, never sent: connected, and no clock offset. */
const info = (r: DatabaseReference): RawDbSnapshot | null => {
  if (r._path === '.info/serverTimeOffset') return { key: 'serverTimeOffset', value: 0, children: null };
  if (r._path === '.info/connected') return { key: 'connected', value: true, children: null };
  return null;
};

export async function get(q: DatabaseReference): Promise<DataSnapshot> {
  const i = info(q);
  if (i) return new DataSnapshot(q, i);
  return new DataSnapshot(q, await guard(() => q._db._d.get(q._path, q._q)));
}
export const getValue = get;

export type Unsubscribe = () => void;
type Cb = (s: DataSnapshot, previousChildName?: string | null) => unknown;
type Cancel = (e: Error) => unknown;
const live = new Map<DatabaseReference, Set<Unsubscribe>>();

function listen(q: DatabaseReference, event: DbEvent, cb: Cb, cancelOrOptions?: Cancel | object, options?: { onlyOnce?: boolean }): Unsubscribe {
  const cancel = typeof cancelOrOptions === 'function' ? (cancelOrOptions as Cancel) : undefined;
  const once = (typeof cancelOrOptions === 'object' ? (cancelOrOptions as { onlyOnce?: boolean }).onlyOnce : options?.onlyOnce) ?? false;
  const i = info(q);
  if (i) {
    queueMicrotask(() => event === 'value' && cb(new DataSnapshot(q, i)));
    return () => {};
  }
  let stopped = false;
  let off: Unsubscribe = () => {};
  const stop = () => {
    stopped = true;
    off();
    live.get(q)?.delete(stop);
  };
  off = q._db._d.listen(
    q._path,
    q._q,
    event,
    (s, prev) => {
      if (stopped) return;
      const at = event === 'value' ? q : child(q.ref, s.key ?? '');
      cb(new DataSnapshot(at, s), prev);
      if (once) stop();
    },
    (e) => cancel?.(wrapErr(e)),
  );
  if (!live.has(q)) live.set(q, new Set());
  live.get(q)!.add(stop);
  return stop;
}
export const onValue = (q: DatabaseReference, cb: (s: DataSnapshot) => unknown, cancelOrOptions?: Cancel | object, options?: { onlyOnce?: boolean }): Unsubscribe => listen(q, 'value', cb, cancelOrOptions, options);
export const onChildAdded = (q: DatabaseReference, cb: Cb, cancelOrOptions?: Cancel | object, options?: { onlyOnce?: boolean }): Unsubscribe => listen(q, 'child_added', cb, cancelOrOptions, options);
export const onChildChanged = (q: DatabaseReference, cb: Cb, cancelOrOptions?: Cancel | object, options?: { onlyOnce?: boolean }): Unsubscribe => listen(q, 'child_changed', cb, cancelOrOptions, options);
export const onChildRemoved = (q: DatabaseReference, cb: Cb, cancelOrOptions?: Cancel | object, options?: { onlyOnce?: boolean }): Unsubscribe => listen(q, 'child_removed', cb, cancelOrOptions, options);
/** off(query): every listener on it (the callback argument is not tracked). */
export function off(q?: DatabaseReference, _eventType?: string, _callback?: unknown): void {
  const targets = q ? [...live.entries()].filter(([r]) => r.isEqual(q)) : [...live.entries()];
  for (const [, set] of targets) for (const stop of [...set]) stop();
}

// ─── writes ─────────────────────────────────────────────────────────────────────

export const serverTimestamp = (): object => new FieldValue('serverTime');
export const increment = (delta: number): object => new FieldValue('increment', delta);

/** Firebase's own sentinels ({ '.sv': 'timestamp' }) are understood too; undefined is refused like Firebase. */
function values(v: unknown, at: string): unknown {
  if (v === undefined) throw new DatabaseError('invalid-argument', `set failed: value argument contains undefined in property '${at}'`);
  if (v === null || typeof v !== 'object' || v instanceof FieldValue) return v;
  if (isPlainObject(v) && '.sv' in v) {
    const sv = v['.sv'];
    if (sv === 'timestamp') return new FieldValue('serverTime');
    if (isPlainObject(sv) && typeof sv.increment === 'number') return new FieldValue('increment', sv.increment);
  }
  if (Array.isArray(v)) return v.map((x, i) => values(x, `${at}.${i}`));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, values(x, at ? `${at}.${k}` : k)]));
}

export const set = (r: DatabaseReference, value: unknown): Promise<void> => guard(() => r._db._d.set(r._path, values(value, '')));
export function update(r: DatabaseReference, vals: object): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vals)) out[k] = values(v, k);
  return guard(() => r._db._d.update(r._path, out));
}
export const remove = (r: DatabaseReference): Promise<void> => guard(() => r._db._d.remove(r._path));
export const setWithPriority = (r: DatabaseReference, value: unknown, _priority: unknown): Promise<void> => set(r, value);

export interface ThenableReference extends DatabaseReference, Pick<Promise<DatabaseReference>, 'then' | 'catch'> {}
export function push(parent: DatabaseReference, value?: unknown): ThenableReference {
  const key = parent._db._d.newKey(parent._path);
  const r = child(parent, key) as ThenableReference;
  // Resolves to a plain (not thenable) reference, as Firebase's does.
  const plain = child(parent, key);
  const p = value === undefined ? Promise.resolve(plain) : set(plain, value).then(() => plain);
  r.then = p.then.bind(p) as ThenableReference['then'];
  r.catch = p.catch.bind(p) as ThenableReference['catch'];
  return r;
}

export interface TransactionResult {
  committed: boolean;
  snapshot: DataSnapshot;
}
export async function runTransaction(r: DatabaseReference, transactionUpdate: (current: any) => unknown, options: { applyLocally?: boolean } = {}): Promise<TransactionResult> {
  const out = await guard(() => r._db._d.transaction(r._path, (cur) => { const n = transactionUpdate(cur); return n === undefined ? undefined : values(n, ''); }, options.applyLocally ?? true));
  return { committed: out.committed, snapshot: new DataSnapshot(r, out.snapshot) };
}

export class OnDisconnect {
  constructor(/** @internal */ readonly _r: DatabaseReference) {}
  set(value: unknown): Promise<void> {
    return guard(() => this._r._db._d.onDisconnect(this._r._path).set(values(value, '')));
  }
  update(vals: object): Promise<void> {
    return guard(() => this._r._db._d.onDisconnect(this._r._path).update(values(vals, '') as Record<string, unknown>));
  }
  remove(): Promise<void> {
    return guard(() => this._r._db._d.onDisconnect(this._r._path).remove());
  }
  cancel(): Promise<void> {
    return guard(() => this._r._db._d.onDisconnect(this._r._path).cancel());
  }
  setWithPriority(value: unknown, _priority: unknown): Promise<void> {
    return this.set(value);
  }
}
export const onDisconnect = (r: DatabaseReference): OnDisconnect => new OnDisconnect(r);
