// icebase/compat/firestore — the Firebase web SDK's modular Firestore API (firebase/firestore:
// doc(db, 'a', 'b'), query(collection(db, 'x'), where('n', '>', 1)), onSnapshot …) over the IceBase
// server, for a web app written against Firebase that runs on IceBase unchanged (alias
// 'firebase/firestore' to this module in the bundler).
//
// Paths are strings, as in Firebase. The server holds the schema, the indexes and the rules and
// checks every read and write; this side only moves data. Like Firebase, a string field path is
// split on dots (new FieldPath('a.b') keeps a dot in a key).

import type { IceBaseApp } from '../app.ts';
import { createEmulatorDriver } from '../drivers/firestore-emulator.ts';
import { IceBaseError } from '../errors.ts';
import type { FirestoreDriver, RawDoc, RawQueryResult, TxDriver } from '../internal/firestore-driver.ts';
import { autoId } from '../internal/firestore-driver.ts';
import { fullOrder, isName, type FilterNode, type QuerySpec } from '../internal/plan.ts';
import { FieldValue, GeoPoint, Timestamp, isPlainObject } from '../values.ts';
import { configureIceBase, iceApp, refreshIceBaseAuth, type CompatSettings } from './shared.ts';

export { configureIceBase, refreshIceBaseAuth, type CompatSettings, Timestamp, GeoPoint, FieldValue };

// ─── errors ──────────────────────────────────────────────────────────────────────

/** Firebase's FirestoreError: a string code ('permission-denied' …), name 'FirebaseError'. */
export class FirestoreError extends Error {
  override readonly name = 'FirebaseError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const wrap = (e: unknown): unknown => (e instanceof IceBaseError ? new FirestoreError(e.code, e.message) : e);
async function guard<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (e) {
    throw wrap(e);
  }
}
const fail = (code: IceBaseError['code'], message: string) => new FirestoreError(code, message);

// ─── values ──────────────────────────────────────────────────────────────────────

export const serverTimestamp = (): FieldValue => new FieldValue('serverTimestamp');
export const deleteField = (): FieldValue => new FieldValue('delete');
export const increment = (n: number): FieldValue => new FieldValue('increment', n);
export const arrayUnion = (...elements: unknown[]): FieldValue => new FieldValue('arrayUnion', elements);
export const arrayRemove = (...elements: unknown[]): FieldValue => new FieldValue('arrayRemove', elements);

export class FieldPath {
  readonly _keys: string[];
  constructor(...fieldNames: string[]) {
    if (!fieldNames.length || fieldNames.some((s) => typeof s !== 'string' || !s)) throw fail('invalid-argument', 'new FieldPath(…) needs one or more non-empty field names');
    this._keys = fieldNames;
  }
  isEqual(other: FieldPath): boolean {
    return other instanceof FieldPath && other._keys.join('\u0000') === this._keys.join('\u0000');
  }
}
export const documentId = (): FieldPath => new FieldPath('__name__');
const keysOf = (f: string | FieldPath): string[] => {
  if (f instanceof FieldPath) return f._keys;
  if (typeof f !== 'string' || !f) throw fail('invalid-argument', `Function where() / orderBy() needs a field path, got ${String(f)}`);
  return f === '__name__' ? ['__name__'] : f.split('.');
};

export type DocumentData = Record<string, any>;
export type WhereFilterOp = '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'array-contains-any' | 'not-in';
export type OrderByDirection = 'asc' | 'desc';
export interface SetOptions {
  readonly merge?: boolean;
  readonly mergeFields?: Array<string | FieldPath>;
}
export interface SnapshotMetadata {
  readonly hasPendingWrites: boolean;
  readonly fromCache: boolean;
  isEqual(other: SnapshotMetadata): boolean;
}
export interface FirestoreDataConverter<T> {
  toFirestore(modelObject: T, options?: SetOptions): DocumentData;
  fromFirestore(snapshot: QueryDocumentSnapshot<DocumentData>, options?: unknown): T;
}
export type Unsubscribe = () => void;

// ─── the database ────────────────────────────────────────────────────────────────

export class Firestore {
  readonly type = 'firestore';
  /** @internal */ _driver: FirestoreDriver | null = null;
  /** @internal */ _terminated = false;
  constructor(
    /** The app it was made from (a Firebase app works: only its name is read). */
    readonly app: { name?: string; options?: Record<string, unknown> } | null,
    /** @internal */ readonly _settings: { ignoreUndefinedProperties?: boolean } = {},
  ) {}
  /** @internal */
  get _ice(): IceBaseApp {
    return iceApp(this.app);
  }
  /** @internal */
  get _d(): FirestoreDriver {
    if (this._terminated) throw fail('failed-precondition', 'The client has already been terminated.');
    return (this._driver ??= createEmulatorDriver({ app: this._ice, databaseId: '(default)' } as never, { toRef: (p) => ({ type: 'document', path: p }) as never }));
  }
  toJSON(): object {
    return { app: this.app?.name ?? '[DEFAULT]' };
  }
}

const instances = new Map<string, Firestore>();
const nameOf = (app?: { name?: string } | null) => app?.name ?? '[DEFAULT]';

export function getFirestore(app?: { name?: string } | null): Firestore {
  const n = nameOf(app);
  let db = instances.get(n);
  if (!db || db._terminated) instances.set(n, (db = new Firestore(app ?? null)));
  return db;
}
export function initializeFirestore(app: { name?: string } | null, settings: { ignoreUndefinedProperties?: boolean; localCache?: unknown } = {}): Firestore {
  const n = nameOf(app);
  const cur = instances.get(n);
  if (cur && !cur._terminated) throw fail('failed-precondition', 'initializeFirestore() has already been called with different options. To avoid this error, call initializeFirestore() with the same options as when it was originally called, or call getFirestore() to return the already initialized instance.');
  const db = new Firestore(app, { ...(settings.ignoreUndefinedProperties ? { ignoreUndefinedProperties: true } : {}) });
  instances.set(n, db);
  return db;
}
/** The IceBase server is the backend already; kept for code that calls it. */
export function connectFirestoreEmulator(_db: Firestore, _host: string, _port: number): void {}
/** No offline cache: every read goes to the server (cache reads answer 'unavailable'). */
export const persistentLocalCache = (_s?: unknown): object => ({ kind: 'persistent' });
export const persistentMultipleTabManager = (): object => ({ kind: 'multiTab' });
export const persistentSingleTabManager = (_s?: unknown): object => ({ kind: 'singleTab' });
export const memoryLocalCache = (_s?: unknown): object => ({ kind: 'memory' });
export async function terminate(db: Firestore): Promise<void> {
  db._terminated = true;
  await db._driver?.terminate();
}
export async function clearIndexedDbPersistence(_db: Firestore): Promise<void> {}
export async function enableNetwork(_db: Firestore): Promise<void> {}
export async function disableNetwork(_db: Firestore): Promise<void> {}
export async function waitForPendingWrites(_db: Firestore): Promise<void> {}

// ─── references ──────────────────────────────────────────────────────────────────

const clean = (p: string) => p.replace(/^\/+|\/+$/g, '');
const joinPath = (base: string | null, segs: string[]) => {
  for (const s of segs) if (typeof s !== 'string' || !s) throw fail('invalid-argument', `Function doc() / collection() cannot be called with an empty path.`);
  return clean([base, ...segs].filter((x) => x !== null && x !== '').join('/'));
};

export class DocumentReference<T = DocumentData> {
  readonly type = 'document';
  constructor(
    readonly firestore: Firestore,
    /** @internal */ readonly _conv: FirestoreDataConverter<T> | null,
    readonly path: string,
  ) {}
  get id(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }
  get parent(): CollectionReference<T> {
    return new CollectionReference<T>(this.firestore, this._conv, this.path.slice(0, this.path.lastIndexOf('/')));
  }
  withConverter<U>(converter: FirestoreDataConverter<U> | null): DocumentReference<U> {
    return new DocumentReference<U>(this.firestore, converter, this.path);
  }
  toJSON(): object {
    return { type: 'document', path: this.path };
  }
}

/** A query's constraint (where, orderBy, limit, a cursor). */
export abstract class QueryConstraint {
  abstract readonly type: string;
  /** @internal */ abstract _apply<T>(q: Query<T>): Query<T>;
}
export type QueryFilterConstraint = QueryFieldFilterConstraint | QueryCompositeFilterConstraint;
export type QueryNonFilterConstraint = QueryConstraint;

type Cursor = { values: unknown[]; inclusive: boolean; snapshot?: unknown };

export class Query<T = DocumentData> {
  readonly type: 'query' | 'collection' = 'query';
  constructor(
    readonly firestore: Firestore,
    readonly converter: FirestoreDataConverter<T> | null,
    /** @internal */ readonly _spec: QuerySpec,
  ) {}
  withConverter<U>(converter: FirestoreDataConverter<U> | null): Query<U> {
    return new Query<U>(this.firestore, converter, this._spec);
  }
  /** @internal */
  _with(spec: Partial<QuerySpec>): Query<T> {
    return new Query<T>(this.firestore, this.converter, { ...this._spec, ...spec });
  }
}

export class CollectionReference<T = DocumentData> extends Query<T> {
  override readonly type = 'collection';
  constructor(firestore: Firestore, converter: FirestoreDataConverter<T> | null, readonly path: string) {
    super(firestore, converter, { path, collectionId: path.slice(path.lastIndexOf('/') + 1), filters: [], orders: [] });
  }
  get id(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }
  get parent(): DocumentReference<DocumentData> | null {
    const i = this.path.lastIndexOf('/');
    return i < 0 ? null : new DocumentReference(this.firestore, null, this.path.slice(0, i));
  }
  override withConverter<U>(converter: FirestoreDataConverter<U> | null): CollectionReference<U> {
    return new CollectionReference<U>(this.firestore, converter, this.path);
  }
}

type Base = Firestore | DocumentReference<any> | CollectionReference<any>;
const baseOf = (b: Base): [Firestore, string | null] => (b instanceof Firestore ? [b, null] : [b.firestore, b.path]);

export function doc<T = DocumentData>(base: Base, path?: string, ...more: string[]): DocumentReference<T> {
  const [db, at] = baseOf(base);
  // doc(collectionRef) makes an auto id.
  const p = path === undefined && base instanceof CollectionReference ? `${base.path}/${autoId()}` : joinPath(at, [path ?? '', ...more]);
  if (p.split('/').length % 2) throw fail('invalid-argument', `Invalid document reference. Document references must have an even number of segments, but ${p} has ${p.split('/').length}.`);
  const conv = base instanceof CollectionReference ? base.converter : base instanceof DocumentReference ? base._conv : null;
  return new DocumentReference<T>(db, (conv ?? null) as FirestoreDataConverter<T> | null, p);
}
export function collection<T = DocumentData>(base: Base, path: string, ...more: string[]): CollectionReference<T> {
  const [db, at] = baseOf(base);
  const p = joinPath(at, [path, ...more]);
  if (p.split('/').length % 2 === 0) throw fail('invalid-argument', `Invalid collection reference. Collection references must have an odd number of segments, but ${p} has ${p.split('/').length}.`);
  return new CollectionReference<T>(db, null, p);
}
export function collectionGroup<T = DocumentData>(db: Firestore, collectionId: string): Query<T> {
  if (collectionId.includes('/')) throw fail('invalid-argument', `Invalid collection ID '${collectionId}' passed to function collectionGroup(). Collection IDs must not contain '/'.`);
  return new Query<T>(db, null, { path: null, collectionId, filters: [], orders: [] });
}
export function refEqual(a: DocumentReference<unknown> | CollectionReference<unknown>, b: DocumentReference<unknown> | CollectionReference<unknown>): boolean {
  return a.type === b.type && a.path === b.path;
}
export function queryEqual(a: Query<unknown>, b: Query<unknown>): boolean {
  return JSON.stringify(a._spec) === JSON.stringify(b._spec);
}

// ─── query constraints ───────────────────────────────────────────────────────────

/** A value as the server compares it: a reference (or a document id under documentId()) → { type: 'document', path }. */
function filterValue(q: Query<unknown>, field: string[], op: WhereFilterOp, value: unknown): unknown {
  const ref = (x: unknown) => (x instanceof DocumentReference ? { type: 'document', path: x.path } : x);
  if (field.length === 1 && field[0] === '__name__') {
    const toRef = (x: unknown) => (typeof x === 'string' ? { type: 'document', path: x.includes('/') || q._spec.path === null ? x : `${q._spec.path}/${x}` } : ref(x));
    return Array.isArray(value) ? value.map(toRef) : toRef(value);
  }
  if (op === 'in' || op === 'not-in' || op === 'array-contains-any') return Array.isArray(value) ? value.map(ref) : value;
  return ref(value);
}

export class QueryFieldFilterConstraint extends QueryConstraint {
  readonly type = 'where';
  constructor(
    /** @internal */ readonly _field: string[],
    /** @internal */ readonly _op: WhereFilterOp,
    /** @internal */ readonly _value: unknown,
  ) {
    super();
  }
  /** @internal */
  _node(q: Query<unknown>): FilterNode {
    return { kind: 'field', field: this._field, op: this._op, value: filterValue(q, this._field, this._op, this._value) } as FilterNode;
  }
  _apply<T>(q: Query<T>): Query<T> {
    return q._with({ filters: [...q._spec.filters, this._node(q as Query<unknown>)] });
  }
}
export class QueryCompositeFilterConstraint extends QueryConstraint {
  constructor(
    readonly type: 'or' | 'and',
    /** @internal */ readonly _parts: QueryFilterConstraint[],
  ) {
    super();
  }
  /** @internal */
  _node(q: Query<unknown>): FilterNode {
    return { kind: this.type, filters: this._parts.map((p) => p._node(q)) } as unknown as FilterNode;
  }
  _apply<T>(q: Query<T>): Query<T> {
    return q._with({ filters: [...q._spec.filters, this._node(q as Query<unknown>)] });
  }
}
class OrderConstraint extends QueryConstraint {
  readonly type = 'orderBy';
  constructor(
    readonly _field: string[],
    readonly _dir: OrderByDirection,
  ) {
    super();
  }
  _apply<T>(q: Query<T>): Query<T> {
    return q._with({ orders: [...q._spec.orders, { field: this._field, dir: this._dir }] });
  }
}
class LimitConstraint extends QueryConstraint {
  constructor(
    readonly type: 'limit' | 'limitToLast',
    readonly _n: number,
  ) {
    super();
  }
  _apply<T>(q: Query<T>): Query<T> {
    return q._with({ limit: { n: this._n, last: this.type === 'limitToLast' } });
  }
}
class CursorConstraint extends QueryConstraint {
  constructor(
    readonly type: 'startAt' | 'startAfter' | 'endAt' | 'endBefore',
    readonly _args: unknown[],
  ) {
    super();
  }
  _apply<T>(q: Query<T>): Query<T> {
    const inclusive = this.type === 'startAt' || this.type === 'endAt';
    const snap = this._args.length === 1 && this._args[0] instanceof DocumentSnapshot ? (this._args[0] as DocumentSnapshot<unknown>) : null;
    let pos: Cursor;
    if (snap) {
      if (!snap.exists()) throw fail('invalid-argument', `Can't use a DocumentSnapshot that doesn't exist for ${this.type}().`);
      pos = snap._raw.native ? { values: [], inclusive, snapshot: snap._raw.native } : { values: valuesOf(q, snap), inclusive };
    } else {
      const order = fullOrder(q._spec);
      pos = {
        values: this._args.map((a, i) => {
          if (a instanceof DocumentReference) return { type: 'document', path: a.path };
          const o = order[i];
          if (o && isName(o.field) && typeof a === 'string') return { type: 'document', path: a.includes('/') || q._spec.path === null ? a : `${q._spec.path}/${a}` };
          return a;
        }),
        inclusive,
      };
    }
    return q._with(this.type === 'startAt' || this.type === 'startAfter' ? { start: pos } : { end: pos });
  }
}
function valuesOf(q: Query<unknown>, snap: DocumentSnapshot<unknown>): unknown[] {
  return fullOrder(q._spec).map((o) => (isName(o.field) ? { type: 'document', path: snap.ref.path } : snap.get(new FieldPath(...o.field))));
}

export const where = (fieldPath: string | FieldPath, opStr: WhereFilterOp, value: unknown): QueryFieldFilterConstraint => new QueryFieldFilterConstraint(keysOf(fieldPath), opStr, value);
export const or = (...queryConstraints: QueryFilterConstraint[]): QueryCompositeFilterConstraint => new QueryCompositeFilterConstraint('or', queryConstraints);
export const and = (...queryConstraints: QueryFilterConstraint[]): QueryCompositeFilterConstraint => new QueryCompositeFilterConstraint('and', queryConstraints);
export const orderBy = (fieldPath: string | FieldPath, directionStr: OrderByDirection = 'asc'): QueryConstraint => new OrderConstraint(keysOf(fieldPath), directionStr);
export const limit = (n: number): QueryConstraint => new LimitConstraint('limit', n);
export const limitToLast = (n: number): QueryConstraint => new LimitConstraint('limitToLast', n);
export const startAt = (...v: unknown[]): QueryConstraint => new CursorConstraint('startAt', v);
export const startAfter = (...v: unknown[]): QueryConstraint => new CursorConstraint('startAfter', v);
export const endAt = (...v: unknown[]): QueryConstraint => new CursorConstraint('endAt', v);
export const endBefore = (...v: unknown[]): QueryConstraint => new CursorConstraint('endBefore', v);

export function query<T>(q: Query<T>, ...constraints: (QueryConstraint | QueryCompositeFilterConstraint)[]): Query<T> {
  let out = q;
  for (const c of constraints) out = c._apply(out);
  return out;
}

// ─── snapshots ───────────────────────────────────────────────────────────────────

const meta = (fromCache: boolean, hasPendingWrites: boolean): SnapshotMetadata => ({
  fromCache,
  hasPendingWrites,
  isEqual: (o) => o.fromCache === fromCache && o.hasPendingWrites === hasPendingWrites,
});

/** Driver data → web values (references as DocumentReference). */
function fromDriver(db: Firestore, v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Timestamp || v instanceof GeoPoint || v instanceof Uint8Array) return v;
  if ((v as { type?: unknown }).type === 'document' && typeof (v as { path?: unknown }).path === 'string' && Object.keys(v).length <= 2) return new DocumentReference(db, null, (v as { path: string }).path);
  if (Array.isArray(v)) return v.map((x) => fromDriver(db, x));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromDriver(db, x)]));
}

export class DocumentSnapshot<T = DocumentData> {
  readonly metadata: SnapshotMetadata;
  constructor(
    readonly ref: DocumentReference<T>,
    /** @internal */ readonly _raw: RawDoc,
  ) {
    this.metadata = meta(!!_raw.fromCache, !!_raw.hasPendingWrites);
  }
  get id(): string {
    return this.ref.id;
  }
  exists(): this is QueryDocumentSnapshot<T> {
    return this._raw.data !== null;
  }
  /** @internal */
  _plain(): DocumentData | undefined {
    return this._raw.data === null ? undefined : (fromDriver(this.ref.firestore, this._raw.data) as DocumentData);
  }
  data(_options?: { serverTimestamps?: 'estimate' | 'previous' | 'none' }): T | undefined {
    const d = this._plain();
    if (d === undefined) return undefined;
    if (this.ref._conv) return this.ref._conv.fromFirestore(new QueryDocumentSnapshot<DocumentData>(this.ref.withConverter(null), this._raw));
    return d as T;
  }
  get(fieldPath: string | FieldPath): any {
    let cur: unknown = this._plain();
    for (const k of keysOf(fieldPath)) cur = isPlainObject(cur) ? cur[k] : undefined;
    return cur;
  }
}
export class QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  override data(options?: { serverTimestamps?: 'estimate' | 'previous' | 'none' }): T {
    return super.data(options)!;
  }
}

export interface DocumentChange<T = DocumentData> {
  readonly type: 'added' | 'removed' | 'modified';
  readonly doc: QueryDocumentSnapshot<T>;
  readonly oldIndex: number;
  readonly newIndex: number;
}

export class QuerySnapshot<T = DocumentData> {
  readonly metadata: SnapshotMetadata;
  constructor(
    readonly query: Query<T>,
    readonly docs: QueryDocumentSnapshot<T>[],
    /** @internal */ readonly _changes: DocumentChange<T>[],
    fromCache = false,
  ) {
    this.metadata = meta(fromCache, false);
  }
  get size(): number {
    return this.docs.length;
  }
  get empty(): boolean {
    return this.docs.length === 0;
  }
  forEach(callback: (result: QueryDocumentSnapshot<T>) => void, thisArg?: unknown): void {
    this.docs.forEach((d) => callback.call(thisArg, d));
  }
  docChanges(_options?: { includeMetadataChanges?: boolean }): DocumentChange<T>[] {
    return this._changes;
  }
}

const docSnap = <T>(q: Query<T>, r: RawDoc) => new QueryDocumentSnapshot<T>(new DocumentReference<T>(q.firestore, q.converter, r.path), r);
function querySnap<T>(q: Query<T>, r: RawQueryResult, first: boolean): QuerySnapshot<T> {
  const docs = r.docs.map((d) => docSnap(q, d));
  const changes: DocumentChange<T>[] = first
    ? docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i }))
    : (r.changes ?? []).map((c) => ({ type: c.type, doc: c.type === 'removed' ? new QueryDocumentSnapshot<T>(new DocumentReference<T>(q.firestore, q.converter, c.doc.path), c.doc) : docSnap(q, c.doc), oldIndex: c.oldIndex, newIndex: c.newIndex }));
  return new QuerySnapshot<T>(q, docs, changes, !!r.fromCache);
}

// ─── reads ───────────────────────────────────────────────────────────────────────

export async function getDoc<T>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  return new DocumentSnapshot<T>(reference, await guard(() => reference.firestore._d.get(reference.path)));
}
export const getDocFromServer = getDoc;
/** No offline cache: always 'unavailable', as Firebase answers for a document it does not hold. */
export async function getDocFromCache<T>(_reference: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  throw fail('unavailable', 'Failed to get document from cache. (This IceBase client keeps no offline cache.)');
}
export async function getDocs<T>(q: Query<T>): Promise<QuerySnapshot<T>> {
  return querySnap(q, await guard(() => q.firestore._d.query(q._spec)), true);
}
export const getDocsFromServer = getDocs;
export async function getDocsFromCache<T>(_q: Query<T>): Promise<QuerySnapshot<T>> {
  throw fail('unavailable', 'Failed to get documents from cache. (This IceBase client keeps no offline cache.)');
}

export interface AggregateQuerySnapshot<D> {
  data(): D;
}
export async function getCountFromServer(q: Query<unknown>): Promise<AggregateQuerySnapshot<{ count: number }>> {
  const r = await guard(() => q.firestore._d.aggregate(q._spec, { count: { op: 'count' } }));
  const count = Number(r.count ?? 0);
  return { data: () => ({ count }) };
}
export const count = (): { aggregateType: 'count' } => ({ aggregateType: 'count' });
export const sum = (field: string | FieldPath): { aggregateType: 'sum'; field: string } => ({ aggregateType: 'sum', field: keysOf(field).join('.') });
export const average = (field: string | FieldPath): { aggregateType: 'avg'; field: string } => ({ aggregateType: 'avg', field: keysOf(field).join('.') });
export async function getAggregateFromServer<S extends Record<string, { aggregateType: 'count' | 'sum' | 'avg'; field?: string }>>(q: Query<unknown>, spec: S): Promise<AggregateQuerySnapshot<{ [K in keyof S]: number | null }>> {
  const aggs = Object.fromEntries(Object.entries(spec).map(([k, a]) => [k, a.aggregateType === 'count' ? { op: 'count' } : { op: a.aggregateType, field: a.field! }])) as never;
  const r = await guard(() => q.firestore._d.aggregate(q._spec, aggs));
  return { data: () => r as { [K in keyof S]: number | null } };
}

export interface Observer<T> {
  next?: (value: T) => void;
  error?: (error: FirestoreError) => void;
  complete?: () => void;
}

/** onSnapshot(ref | query, [options], next | observer, [error], [complete]). */
export interface SnapshotListenOptions {
  readonly includeMetadataChanges?: boolean;
  readonly source?: 'default' | 'cache';
}
export function onSnapshot<T>(reference: DocumentReference<T>, observer: Observer<DocumentSnapshot<T>>): Unsubscribe;
export function onSnapshot<T>(reference: DocumentReference<T>, options: SnapshotListenOptions, observer: Observer<DocumentSnapshot<T>>): Unsubscribe;
export function onSnapshot<T>(reference: DocumentReference<T>, onNext: (snapshot: DocumentSnapshot<T>) => void, onError?: (error: FirestoreError) => void, onCompletion?: () => void): Unsubscribe;
export function onSnapshot<T>(reference: DocumentReference<T>, options: SnapshotListenOptions, onNext: (snapshot: DocumentSnapshot<T>) => void, onError?: (error: FirestoreError) => void, onCompletion?: () => void): Unsubscribe;
export function onSnapshot<T>(query: Query<T>, observer: Observer<QuerySnapshot<T>>): Unsubscribe;
export function onSnapshot<T>(query: Query<T>, options: SnapshotListenOptions, observer: Observer<QuerySnapshot<T>>): Unsubscribe;
export function onSnapshot<T>(query: Query<T>, onNext: (snapshot: QuerySnapshot<T>) => void, onError?: (error: FirestoreError) => void, onCompletion?: () => void): Unsubscribe;
export function onSnapshot<T>(query: Query<T>, options: SnapshotListenOptions, onNext: (snapshot: QuerySnapshot<T>) => void, onError?: (error: FirestoreError) => void, onCompletion?: () => void): Unsubscribe;
export function onSnapshot<T>(target: DocumentReference<T> | Query<T>, ...args: unknown[]): Unsubscribe {
  if (args.length && isPlainObject(args[0]) && !('next' in (args[0] as object)) && !('error' in (args[0] as object))) args = args.slice(1); // { includeMetadataChanges }
  let obs: Observer<unknown>;
  if (typeof args[0] === 'function') obs = { next: args[0] as Observer<unknown>['next'], ...(typeof args[1] === 'function' ? { error: args[1] as Observer<unknown>['error'] } : {}) };
  else obs = (args[0] ?? {}) as Observer<unknown>;
  const onError = (e: Error) => obs.error?.(wrap(e) as FirestoreError);
  let stopped = false;
  let off: Unsubscribe = () => {};
  try {
    if (target instanceof DocumentReference) {
      off = target.firestore._d.listenDoc(target.path, (r) => !stopped && obs.next?.(new DocumentSnapshot<T>(target, r)), onError);
    } else {
      let first = true;
      off = target.firestore._d.listenQuery(
        target._spec,
        (r) => {
          if (stopped) return;
          const s = querySnap(target, r, first);
          first = false;
          obs.next?.(s);
        },
        onError,
      );
    }
  } catch (e) {
    queueMicrotask(() => onError(e as Error));
  }
  return () => {
    stopped = true;
    off();
  };
}
export function onSnapshotsInSync(_db: Firestore, onSync: (() => void) | { next?: () => void }): Unsubscribe {
  queueMicrotask(() => (typeof onSync === 'function' ? onSync() : onSync.next?.()));
  return () => {};
}

// ─── writes ──────────────────────────────────────────────────────────────────────

/** Firebase refuses undefined unless ignoreUndefinedProperties; references become { type, path }. */
function toDriver(db: Firestore, v: unknown, at: string): unknown {
  if (v === undefined) {
    if (db._settings.ignoreUndefinedProperties) return undefined;
    throw fail('invalid-argument', `Function setDoc() called with invalid data. Unsupported field value: undefined (found in field ${at})`);
  }
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof DocumentReference) return { type: 'document', path: v.path };
  if (v instanceof Timestamp || v instanceof GeoPoint || v instanceof Uint8Array) return v;
  if (v instanceof Date) return Timestamp.fromDate(v);
  if (v instanceof FieldValue) return v.op === 'arrayUnion' || v.op === 'arrayRemove' ? new FieldValue(v.op, (v.operand as unknown[]).map((x, i) => toDriver(db, x, `${at}[${i}]`))) : v;
  if (Array.isArray(v)) return v.map((x, i) => toDriver(db, x, `${at}[${i}]`));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const c = toDriver(db, x, at ? `${at}.${k}` : k);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

function setData<T>(ref: DocumentReference<T>, data: unknown, options?: SetOptions): [Record<string, unknown>, boolean] {
  const d = toDriver(ref.firestore, ref._conv ? ref._conv.toFirestore(data as T, options) : data, '');
  if (!isPlainObject(d)) throw fail('invalid-argument', `Function setDoc() called with invalid data. Data must be an object, but it was: ${String(data)}`);
  if (options?.mergeFields) {
    const picked: Record<string, unknown> = {};
    for (const f of options.mergeFields) {
      const keys = keysOf(f);
      let src: unknown = d;
      for (const k of keys) src = isPlainObject(src) ? src[k] : undefined;
      if (src === undefined) continue;
      let dst = picked;
      keys.slice(0, -1).forEach((k) => (dst = (dst[k] ??= {}) as Record<string, unknown>));
      dst[keys[keys.length - 1]!] = src;
    }
    return [picked, true];
  }
  return [d, !!options?.merge];
}
function updateData(ref: DocumentReference<unknown>, args: unknown[]): [string[], unknown][] {
  const entries: [string[], unknown][] = [];
  if (typeof args[0] === 'string' || args[0] instanceof FieldPath) {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const keys = keysOf(args[i] as string | FieldPath);
      entries.push([keys, toDriver(ref.firestore, args[i + 1], keys.join('.'))]);
    }
  } else {
    const data = args[0];
    if (!isPlainObject(data)) throw fail('invalid-argument', 'Function updateDoc() called with invalid data. Data must be an object.');
    for (const [k, v] of Object.entries(data)) {
      const c = toDriver(ref.firestore, v, k);
      if (c !== undefined) entries.push([keysOf(k), c]);
    }
  }
  return entries;
}

export async function setDoc<T>(reference: DocumentReference<T>, data: T | Partial<T>, options?: SetOptions): Promise<void> {
  const [d, merge] = setData(reference, data, options);
  await guard(() => reference.firestore._d.set(reference.path, d, merge));
}
export async function updateDoc<T>(reference: DocumentReference<T>, ...args: unknown[]): Promise<void> {
  const fields = updateData(reference as DocumentReference<unknown>, args);
  await guard(() => reference.firestore._d.update(reference.path, fields));
}
export async function deleteDoc<T>(reference: DocumentReference<T>): Promise<void> {
  await guard(() => reference.firestore._d.delete(reference.path));
}
export async function addDoc<T>(reference: CollectionReference<T>, data: T): Promise<DocumentReference<T>> {
  const ref = doc<T>(reference);
  const [d] = setData(ref, data);
  await guard(() => reference.firestore._d.create(ref.path, d));
  return ref;
}

export class WriteBatch {
  /** @internal */ readonly _b;
  /** @internal */ _done = false;
  constructor(/** @internal */ readonly _db: Firestore) {
    this._b = _db._d.batch();
  }
  set<T>(reference: DocumentReference<T>, data: T | Partial<T>, options?: SetOptions): WriteBatch {
    const [d, merge] = setData(reference, data, options);
    this._b.set(reference.path, d, merge);
    return this;
  }
  update<T>(reference: DocumentReference<T>, ...args: unknown[]): WriteBatch {
    this._b.update(reference.path, updateData(reference as DocumentReference<unknown>, args));
    return this;
  }
  delete<T>(reference: DocumentReference<T>): WriteBatch {
    this._b.delete(reference.path);
    return this;
  }
  async commit(): Promise<void> {
    if (this._done) throw fail('failed-precondition', 'A write batch can no longer be used after commit() has been called.');
    this._done = true;
    await guard(() => this._b.commit());
  }
}
export const writeBatch = (firestore: Firestore): WriteBatch => new WriteBatch(firestore);

export class Transaction {
  constructor(
    /** @internal */ readonly _db: Firestore,
    /** @internal */ readonly _tx: TxDriver,
  ) {}
  async get<T>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
    return new DocumentSnapshot<T>(reference, await guard(() => this._tx.get(reference.path)));
  }
  set<T>(reference: DocumentReference<T>, data: T | Partial<T>, options?: SetOptions): Transaction {
    const [d, merge] = setData(reference, data, options);
    this._tx.set(reference.path, d, merge);
    return this;
  }
  update<T>(reference: DocumentReference<T>, ...args: unknown[]): Transaction {
    this._tx.update(reference.path, updateData(reference as DocumentReference<unknown>, args));
    return this;
  }
  delete<T>(reference: DocumentReference<T>): Transaction {
    this._tx.delete(reference.path);
    return this;
  }
}
export function runTransaction<R>(firestore: Firestore, updateFunction: (transaction: Transaction) => Promise<R>, options?: { maxAttempts?: number }): Promise<R> {
  return guard(() => firestore._d.transaction((tx) => updateFunction(new Transaction(firestore, tx)), options?.maxAttempts ? { maxAttempts: options.maxAttempts } : {}));
}
