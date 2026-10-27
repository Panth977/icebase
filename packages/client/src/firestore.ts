// icebase/firestore — same function names and shapes as firebase/firestore (modular), typed
// from icebase/schema. Index rule (same as Firebase): any single field can be filtered or
// sorted. A query that needs a COMPOSITE index compiles only if that index is declared in the
// schema, and is refused at runtime (every mode) before it leaves.
//
// The same functions work on a client Firestore (getFirestore) and on an admin one
// (icebase/admin's getAdminFirestore); the difference is the driver underneath.

import { emulatorOrigin, service, type IceBaseApp } from './app.ts';
import { IceBaseError } from './errors.ts';
import type { Aggregate, FirestoreDriver, RawChange, RawDoc, RawQueryResult } from './internal/firestore-driver.ts';
import { autoId } from './internal/firestore-driver.ts';
import { assertIndexed, isName, type FilterNode, type QuerySpec, type WhereOp } from './internal/plan.ts';
import {
  fieldAt,
  fillPath,
  matchCollectionPath,
  readIssues,
  showPath,
  validateQueryValue,
  validateUpdate,
  validateWrite,
  type AnyCollection,
  type DocOf,
  type IndexDecl,
  type IndexesOf,
  type Issue,
  type JoinPath,
  type PathOf,
  type UpdateEntry,
  type ValueAt,
} from './schema.ts';
import { FieldValue as FieldValueImpl, GeoPoint, Timestamp } from './values.ts';

export { Timestamp, GeoPoint } from './values.ts';
export type { FieldValue } from './values.ts';

// ─── the database ──────────────────────────────────────────────────────────────

/** What a driver gets from icebase/firestore: how to turn a path into a typed reference. */
export interface DriverHelpers {
  toRef(path: string): DocumentReference<unknown>;
}
type DriverFactory = (db: Firestore, h: DriverHelpers) => FirestoreDriver;
const factories = new Map<string, DriverFactory>();

/** @internal drivers register themselves: 'client:firebase', 'admin:firebase', 'client:emulator' … */
export function registerFirestoreDriver(id: string, f: DriverFactory): void {
  factories.set(id, f);
}

export class Firestore {
  readonly type = 'firestore';
  /** @internal */
  readonly _driver: FirestoreDriver;
  /** @internal */
  _emulator: { host: string; port: number } | null = null;
  /** @internal */
  _terminated = false;
  /** @internal */ readonly _databaseId: string;
  constructor(
    readonly app: IceBaseApp,
    databaseId: string,
    driverId: string,
    /** @internal */ readonly _settings: FirestoreSettings = {},
  ) {
    this._databaseId = databaseId;
    const make = factories.get(driverId);
    if (!make) {
      throw new IceBaseError('unimplemented', `Firestore in ${driverId.replace(':', ' app, ')} mode is not available${driverId.startsWith('admin') ? ' (import icebase/admin)' : ''}`, { reason: 'mode', service: 'firestore' });
    }
    this._driver = make(this, { toRef: (p) => docFromPath(this, p) });
  }
  get databaseId(): string {
    return this._databaseId;
  }
  toJSON(): object {
    return { app: this.app.name, databaseId: this._databaseId };
  }
}

export interface FirestoreSettings {
  ignoreUndefinedProperties?: boolean;
  experimentalForceLongPolling?: boolean;
}

/** @internal the driver id for an app's Firestore. */
export function firestoreDriverId(app: IceBaseApp): string {
  return `${app.kind}:${app.modes.firestore}`;
}

export function getFirestore(app: IceBaseApp, databaseId = '(default)'): Firestore {
  if (app.kind === 'admin') throw new IceBaseError('invalid-argument', 'This is an admin app: use getAdminFirestore(app) from icebase/admin', { reason: 'config' });
  return service(app, `firestore:${databaseId}`, () => new Firestore(app, databaseId, firestoreDriverId(app)));
}

export function initializeFirestore(app: IceBaseApp, settings: FirestoreSettings, databaseId = '(default)'): Firestore {
  if (app._services.has(`firestore:${databaseId}`)) throw new IceBaseError('failed-precondition', 'initializeFirestore() has already been called, or getFirestore() was called first', { reason: 'config' });
  return service(app, `firestore:${databaseId}`, () => new Firestore(app, databaseId, firestoreDriverId(app), settings));
}

/** Point a client Firestore at the official Firebase emulator (firebase mode only). Call before any read or write. */
export function connectFirestoreEmulator(db: Firestore, host: string, port: number): void {
  db._emulator = { host, port };
  (db._driver as { connectEmulator?: (h: string, p: number) => void }).connectEmulator?.(host, port);
}

export async function terminate(db: Firestore): Promise<void> {
  if (db._terminated) return;
  db._terminated = true;
  await db._driver.terminate();
}

/** @internal where the IceBase emulator server is. */
export const emulatorOf = (db: Firestore): string => emulatorOrigin(db.app);

// ─── references ────────────────────────────────────────────────────────────────

/** 'users/{uid}/orders' → [uid: string] */
type Params<P extends string> = P extends `${string}{${string}}${infer R}` ? [string, ...Params<R>] : [];

export class DocumentReference<T = unknown> {
  readonly type = 'document';
  /** @internal */ readonly __t?: T;
  constructor(
    readonly firestore: Firestore,
    readonly path: string,
    /** @internal the schema collection, or null for a path outside the schema */
    readonly _coll: AnyCollection | null,
  ) {}
  get id(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }
  get parent(): CollectionReference<T, any> {
    return new CollectionReference<T, any>(this.firestore, this.path.slice(0, this.path.lastIndexOf('/')), this._coll);
  }
  toJSON(): { type: 'document'; path: string } {
    return { type: 'document', path: this.path };
  }
}

export class Query<T = unknown, IX = unknown> {
  readonly type: 'query' | 'collection' = 'query';
  /** @internal */ readonly __t?: T;
  /** @internal */ readonly __ix?: IX;
  constructor(
    readonly firestore: Firestore,
    /** @internal */ readonly _coll: AnyCollection | null,
    /** @internal */ readonly _spec: QuerySpec,
  ) {}
}

export class CollectionReference<T = unknown, IX = unknown> extends Query<T, IX> {
  override readonly type = 'collection';
  constructor(firestore: Firestore, readonly path: string, coll: AnyCollection | null) {
    super(firestore, coll, { path, collectionId: path.slice(path.lastIndexOf('/') + 1), filters: [], orders: [] });
  }
  get id(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }
  get parent(): DocumentReference<unknown> | null {
    const i = this.path.lastIndexOf('/');
    if (i < 0) return null;
    const parentPath = this.path.slice(0, i);
    return docFromPath(this.firestore, parentPath);
  }
}

/** @internal a reference for any document path, typed by the schema when the path is in it. */
export function docFromPath(db: Firestore, path: string): DocumentReference<unknown> {
  const parent = path.slice(0, path.lastIndexOf('/'));
  const m = matchCollectionPath(db.app.config.schema, parent);
  return new DocumentReference(db, path, m?.collection ?? null);
}

/** collection(db, products) · collection(db, orders, uid) — path params are required arguments (SCH-3). */
export function collection<C extends AnyCollection>(db: Firestore, c: C, ...params: Params<C['path']>): CollectionReference<DocOf<C>, IndexesOf<C>> {
  if (!(db instanceof Firestore)) throw new IceBaseError('invalid-argument', 'collection(db, schemaCollection, …params): the first argument must be a Firestore from getFirestore() or getAdminFirestore()');
  if (!c || (c as { kind?: string }).kind !== 'collection') {
    throw new IceBaseError('invalid-argument', 'collection(db, schemaCollection, …params): pass the collection from your schema (e.g. collection(db, products)), not a path string', { reason: 'unknown-collection' });
  }
  if (!Object.values(db.app.config.schema.collections).includes(c)) {
    throw new IceBaseError('invalid-argument', `collection('${c.path}') is not in this app's schema (defineSchema in icebase.config)`, { reason: 'unknown-collection' });
  }
  return new CollectionReference(db, fillPath(c, params as unknown as string[]), c);
}

/** collectionGroup(db, orders) — every 'orders' collection; needs `group: true` on it in the schema. */
export function collectionGroup<C extends AnyCollection>(db: Firestore, c: C): Query<DocOf<C>, IndexesOf<C>> {
  if (!c || (c as { kind?: string }).kind !== 'collection') throw new IceBaseError('invalid-argument', 'collectionGroup(db, schemaCollection): pass the collection from your schema', { reason: 'unknown-collection' });
  return new Query(db, c, { path: null, collectionId: c.id, filters: [], orders: [] });
}

/** doc(collectionRef) → new auto id · doc(collectionRef, id) */
export function doc<T, IX>(ref: CollectionReference<T, IX>, id?: string): DocumentReference<T> {
  if (!(ref instanceof CollectionReference)) throw new IceBaseError('invalid-argument', 'doc(collectionRef, id?): the first argument must be a CollectionReference from collection(db, …)');
  const docId = id ?? autoId();
  if (typeof docId !== 'string' || docId === '' || docId.includes('/') || docId === '.' || docId === '..' || /^__.*__$/.test(docId)) {
    throw new IceBaseError('invalid-argument', `doc(${ref.path}, ${JSON.stringify(id)}): a document id is a non-empty string without '/'`);
  }
  return new DocumentReference<T>(ref.firestore, `${ref.path}/${docId}`, ref._coll);
}

/** Firebase's FieldPath: the keys to a field, never split on dots. A key array works anywhere a FieldPath does. */
export class FieldPath {
  constructor(...segments: string[]) {
    if (!segments.length || segments.some((s) => typeof s !== 'string' || s === '')) throw new IceBaseError('invalid-argument', 'new FieldPath(…keys): non-empty keys');
    this.segments = segments;
  }
  readonly segments: string[];
  isEqual(other: FieldPath): boolean {
    return other instanceof FieldPath && JSON.stringify(other.segments) === JSON.stringify(this.segments);
  }
}

/** where(documentId(), '==', id) */
export function documentId(): FieldPath {
  return new FieldPath('__name__');
}

export function refEqual(a: DocumentReference<unknown> | CollectionReference<unknown, unknown>, b: DocumentReference<unknown> | CollectionReference<unknown, unknown>): boolean {
  return a.type === b.type && a.path === b.path && a.firestore === b.firestore;
}

// ─── query constraints ─────────────────────────────────────────────────────────
//
// A field is a top-level key ('stock') or a key path into maps (['address', 'city']).
// Strings are never split on dots: 'a.b' is the field named "a.b".

export type WhereFilterOp = WhereOp;
type ValueFor<V, Op extends WhereFilterOp> = Op extends 'in' | 'not-in'
  ? V[]
  : Op extends 'array-contains'
    ? V extends (infer E)[]
      ? E
      : never
    : Op extends 'array-contains-any'
      ? V extends (infer E)[]
        ? E[]
        : never
      : V | (Op extends '==' | '!=' ? null : never);

/** How a constraint uses its field, for the index check. */
export type Use = 'eq' | 'range' | 'order' | 'contains' | 'none';
type UseOf<Op extends WhereFilterOp> = Op extends '==' | 'in' ? 'eq' : Op extends 'array-contains' | 'array-contains-any' ? 'contains' : 'range';

declare const constraint: unique symbol;
export interface QueryConstraint<T, F extends string, U extends Use> {
  readonly [constraint]?: [T, F, U];
  /** @internal */ readonly _c: Constraint;
}
/** Same name as Firebase's (and(), or() return it). */
export type QueryCompositeFilterConstraint<T> = QueryConstraint<T, never, 'none'>;
export type QueryFieldFilterConstraint<T, F extends string = string> = QueryConstraint<T, F, Use>;

type Constraint =
  | { kind: 'where'; field: string[]; op: WhereOp; value: unknown }
  | { kind: 'and' | 'or'; filters: Constraint[] }
  | { kind: 'orderBy'; field: string[]; dir: 'asc' | 'desc' }
  | { kind: 'limit' | 'limitToLast'; n: number }
  | { kind: 'startAt' | 'startAfter' | 'endAt' | 'endBefore'; values: unknown[] };

const mk = <T, F extends string, U extends Use>(c: Constraint): QueryConstraint<T, F, U> => ({ _c: c }) as QueryConstraint<T, F, U>;
/** A field argument as a key path. */
const keysOf = (f: string | readonly string[] | FieldPath): string[] => {
  if (f instanceof FieldPath) return [...f.segments];
  if (typeof f === 'string') return [f];
  if (Array.isArray(f) && f.length > 0 && f.every((s) => typeof s === 'string' && s !== '')) return [...f];
  throw new IceBaseError('invalid-argument', `a field is a key or a non-empty array of keys, got ${JSON.stringify(f)}`);
};

/** where('role', '==', 'admin') · where(['address', 'city'], '==', 'Pune') — the value must match the field's type. */
export function where<T, F extends keyof T & string, Op extends WhereFilterOp>(field: F, op: Op, value: ValueFor<T[F], Op>): QueryConstraint<T, F, UseOf<Op>>;
export function where<T, const P extends PathOf<T>, Op extends WhereFilterOp>(field: P, op: Op, value: ValueFor<ValueAt<T, P>, Op>): QueryConstraint<T, JoinPath<P>, UseOf<Op>>;
/** where(documentId(), '==', id) */
export function where<T>(field: FieldPath, op: WhereFilterOp, value: unknown): QueryConstraint<T, never, 'none'>;
export function where(field: string | readonly string[] | FieldPath, op: WhereFilterOp, value: unknown): QueryConstraint<unknown, string, Use> {
  return mk({ kind: 'where', field: keysOf(field), op, value });
}

export function orderBy<T, F extends keyof T & string>(field: F, dir?: 'asc' | 'desc'): QueryConstraint<T, F, 'order'>;
export function orderBy<T, const P extends PathOf<T>>(field: P, dir?: 'asc' | 'desc'): QueryConstraint<T, JoinPath<P>, 'order'>;
export function orderBy<T>(field: FieldPath, dir?: 'asc' | 'desc'): QueryConstraint<T, never, 'none'>;
export function orderBy(field: string | readonly string[] | FieldPath, dir: 'asc' | 'desc' = 'asc'): QueryConstraint<unknown, string, Use> {
  if (dir !== 'asc' && dir !== 'desc') throw new IceBaseError('invalid-argument', `orderBy(${showPath(keysOf(field))}, '${String(dir)}'): direction is 'asc' or 'desc'`);
  return mk({ kind: 'orderBy', field: keysOf(field), dir });
}

/** and(where(…), or(…)) — nested filters are index-checked at runtime. */
export function and<T>(...filters: QueryConstraint<T, any, any>[]): QueryCompositeFilterConstraint<T> {
  return mk({ kind: 'and', filters: filters.map((f) => f._c) });
}
export function or<T>(...filters: QueryConstraint<T, any, any>[]): QueryCompositeFilterConstraint<T> {
  return mk({ kind: 'or', filters: filters.map((f) => f._c) });
}

export function limit<T>(n: number): QueryConstraint<T, never, 'none'> {
  if (!Number.isInteger(n) || n <= 0) throw new IceBaseError('invalid-argument', `limit(${n}): a positive integer`);
  return mk({ kind: 'limit', n });
}
export function limitToLast<T>(n: number): QueryConstraint<T, never, 'none'> {
  if (!Number.isInteger(n) || n <= 0) throw new IceBaseError('invalid-argument', `limitToLast(${n}): a positive integer`);
  return mk({ kind: 'limitToLast', n });
}
type Cursor = 'startAt' | 'startAfter' | 'endAt' | 'endBefore';
const cursor = (kind: Cursor) => <T>(...values: unknown[]): QueryConstraint<T, never, 'none'> => mk({ kind, values });
/** startAt(snapshot) or startAt(...fieldValues), like Firebase. */
export const startAt: <T>(...values: unknown[]) => QueryConstraint<T, never, 'none'> = cursor('startAt');
export const startAfter: <T>(...values: unknown[]) => QueryConstraint<T, never, 'none'> = cursor('startAfter');
export const endAt: <T>(...values: unknown[]) => QueryConstraint<T, never, 'none'> = cursor('endAt');
export const endBefore: <T>(...values: unknown[]) => QueryConstraint<T, never, 'none'> = cursor('endBefore');

// ── the index check at the type level (PRD §9, with single-field indexes declared too) ──
type FieldsUsed<Cs, U extends Use> = Cs extends readonly (infer C)[] ? (C extends QueryConstraint<any, infer F, infer UU> ? (UU extends U ? F : never) : never) : never;
type U2I<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type IsUnion<T> = [T] extends [never] ? false : [T] extends [U2I<T>] ? false : true;
type Used<Cs> = FieldsUsed<Cs, 'eq' | 'contains' | 'range' | 'order'>;
/** A composite is needed when a range/orderBy is combined with any other field. */
type NeedsComposite<Cs> = [FieldsUsed<Cs, 'range' | 'order'>] extends [never] ? false : IsUnion<Used<Cs>>;
type SameSet<A, B> = [Exclude<A, B>] extends [never] ? ([Exclude<B, A>] extends [never] ? true : false) : false;
type HasIndex<Req, IX> = true extends (IX extends IndexDecl<infer S> ? SameSet<S, Req> : false) ? true : false;
/** The fields that have a single-field index of their own. */
type Singles<IX> = IX extends IndexDecl<infer F> ? (IsUnion<F> extends true ? never : F) : never;
type IndexCheck<Cs, IX> = [Used<Cs>] extends [never]
  ? unknown
  : NeedsComposite<Cs> extends true
    ? HasIndex<Used<Cs>, IX> extends true
      ? unknown
      : { missingIndex: Used<Cs> }
    : // one field, or equality/contains on several (Firestore merges single-field indexes)
      HasIndex<Used<Cs>, IX> extends true
      ? unknown
      : [Used<Cs>] extends [Singles<IX>]
        ? unknown
        : { missingIndex: Exclude<Used<Cs>, Singles<IX>> };

/** What query() returns when the index it needs is not declared:
 * getDocs()/onSnapshot() on it is a compile error that names the fields. */
export interface MissingIndex<F extends string> {
  readonly error: 'missing index — declare it in the schema';
  readonly fields: F;
}
/** @deprecated the old name (composites only); MissingIndex covers single-field indexes too. */
export type MissingCompositeIndex<F extends string> = MissingIndex<F>;

/** Same call shape as Firebase: query(ref, ...constraints) — up to 8 constraints are type-checked. */
export function query<
  T,
  IX,
  F1 extends string = never, U1 extends Use = 'none',
  F2 extends string = never, U2 extends Use = 'none',
  F3 extends string = never, U3 extends Use = 'none',
  F4 extends string = never, U4 extends Use = 'none',
  F5 extends string = never, U5 extends Use = 'none',
  F6 extends string = never, U6 extends Use = 'none',
  F7 extends string = never, U7 extends Use = 'none',
  F8 extends string = never, U8 extends Use = 'none',
>(
  q: Query<T, IX> | CollectionReference<T, IX>,
  c1?: QueryConstraint<T, F1, U1>, c2?: QueryConstraint<T, F2, U2>, c3?: QueryConstraint<T, F3, U3>, c4?: QueryConstraint<T, F4, U4>,
  c5?: QueryConstraint<T, F5, U5>, c6?: QueryConstraint<T, F6, U6>, c7?: QueryConstraint<T, F7, U7>, c8?: QueryConstraint<T, F8, U8>,
): IndexCheck<
  [QueryConstraint<T, F1, U1>, QueryConstraint<T, F2, U2>, QueryConstraint<T, F3, U3>, QueryConstraint<T, F4, U4>, QueryConstraint<T, F5, U5>, QueryConstraint<T, F6, U6>, QueryConstraint<T, F7, U7>, QueryConstraint<T, F8, U8>],
  IX
> extends { missingIndex: infer F extends string }
  ? MissingIndex<F>
  : Query<T, IX>;
export function query(q: Query<unknown, unknown>, ...constraints: (QueryConstraint<unknown, string, Use> | undefined)[]): Query<unknown, unknown> {
  if (!(q instanceof Query)) throw new IceBaseError('invalid-argument', 'query(ref, …constraints): the first argument must be a collection or a query');
  const spec: QuerySpec = { ...q._spec, filters: [...q._spec.filters], orders: [...q._spec.orders] };
  const coll = q._coll;
  const toNode = (c: Constraint): FilterNode => {
    if (c.kind === 'where') {
      if (coll) validateQueryValue(coll, c.field, c.op, c.value);
      return { kind: 'field', field: c.field, op: c.op, value: isName(c.field) ? nameValue(q, c.value) : normalizeQueryValue(c.value) };
    }
    if (c.kind === 'and' || c.kind === 'or') return { kind: c.kind, filters: c.filters.map(toNode) };
    throw new IceBaseError('invalid-argument', `and()/or() take where(…) filters, not ${c.kind}()`);
  };
  for (const qc of constraints) {
    if (!qc) continue;
    const c = qc._c;
    switch (c.kind) {
      case 'where':
      case 'and':
      case 'or':
        spec.filters.push(toNode(c));
        break;
      case 'orderBy':
        if (coll && !isName(c.field) && !fieldAt(coll.fields, c.field)) throw new IceBaseError('invalid-argument', `orderBy(${showPath(c.field)}) on '${coll.path}': ${showPath(c.field)} is not a field (fields: ${Object.keys(coll.fields).join(', ')})`, { reason: 'schema' });
        spec.orders.push({ field: c.field, dir: c.dir });
        break;
      case 'limit':
      case 'limitToLast':
        spec.limit = { n: c.n, last: c.kind === 'limitToLast' };
        break;
      case 'startAt':
      case 'startAfter':
      case 'endAt':
      case 'endBefore': {
        const snap = c.values.length === 1 && c.values[0] instanceof DocumentSnapshot ? (c.values[0] as DocumentSnapshot<unknown>) : null;
        const pos = {
          values: snap ? [] : c.values.map(normalizeQueryValue),
          inclusive: c.kind === 'startAt' || c.kind === 'endAt',
          ...(snap ? { snapshot: snap._raw.native ?? snap } : {}),
        };
        if (c.kind === 'startAt' || c.kind === 'startAfter') spec.start = pos;
        else spec.end = pos;
        break;
      }
    }
  }
  return new Query(q.firestore, coll, spec);
}

function nameValue(q: Query<unknown, unknown>, v: unknown): unknown {
  if (v instanceof DocumentReference) return v;
  if (typeof v === 'string' && q._spec.path !== null) return docFromPath(q.firestore, `${q._spec.path}/${v}`);
  if (Array.isArray(v)) return v.map((x) => nameValue(q, x));
  return v;
}

function normalizeQueryValue(v: unknown): unknown {
  if (v instanceof Date) return Timestamp.fromDate(v);
  if (Array.isArray(v)) return v.map(normalizeQueryValue);
  return v;
}

export function queryEqual(a: Query<unknown, unknown>, b: Query<unknown, unknown>): boolean {
  return a.firestore === b.firestore && JSON.stringify(a._spec) === JSON.stringify(b._spec);
}

function checkQuery(q: Query<unknown, unknown>): void {
  if (q.firestore._terminated) throw new IceBaseError('failed-precondition', 'The Firestore instance has been terminated');
  if (q._coll) assertIndexed(q._coll, q._spec);
}

// ─── snapshots ─────────────────────────────────────────────────────────────────

export interface SnapshotMetadata {
  readonly hasPendingWrites: boolean;
  readonly fromCache: boolean;
}

const drift = new Map<string, { count: number; sample: Issue[]; lastPath: string }>();
const warned = new Set<string>();

/** Documents read that did not match the schema (SCH-2), per collection path template. */
export function getSchemaDrift(): Record<string, { count: number; sample: Issue[]; lastPath: string }> {
  return Object.fromEntries(drift);
}

const isProd = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === 'production';

function noteDrift(coll: AnyCollection, path: string, data: Record<string, unknown>): void {
  const issues = readIssues(coll, data);
  if (!issues.length) return;
  const d = drift.get(coll.path) ?? { count: 0, sample: [], lastPath: path };
  d.count++;
  d.lastPath = path;
  if (!d.sample.length) d.sample = issues.slice(0, 5);
  drift.set(coll.path, d);
  if (!isProd() && !warned.has(coll.path)) {
    warned.add(coll.path);
    console.warn(`[icebase] ${path} does not match the schema of '${coll.path}' (${issues.map((i) => `${i.path}: expected ${i.expected}, got ${i.got}`).join('; ')}). Returned as is; see getSchemaDrift().`);
  }
}

export class DocumentSnapshot<T = unknown> {
  /** @internal */ _checked = false;
  constructor(
    readonly ref: DocumentReference<T>,
    /** @internal */ readonly _raw: RawDoc,
  ) {}
  get id(): string {
    return this.ref.id;
  }
  get metadata(): SnapshotMetadata {
    return { hasPendingWrites: this._raw.hasPendingWrites ?? false, fromCache: this._raw.fromCache ?? false };
  }
  exists(): this is QueryDocumentSnapshot<T> {
    return this._raw.data !== null;
  }
  data(): T | undefined {
    const d = this._raw.data;
    if (d === null) return undefined;
    if (!this._checked && this.ref._coll) {
      this._checked = true;
      noteDrift(this.ref._coll, this.ref.path, d);
    }
    return d as T;
  }
  get<K extends keyof T & string>(field: K): T[K] | undefined {
    return (this.data() as Record<string, unknown> | undefined)?.[field] as T[K] | undefined;
  }
}

export class QueryDocumentSnapshot<T = unknown> extends DocumentSnapshot<T> {
  override data(): T {
    return super.data() as T;
  }
}

export interface DocumentChange<T> {
  readonly type: 'added' | 'modified' | 'removed';
  readonly doc: QueryDocumentSnapshot<T>;
  readonly oldIndex: number;
  readonly newIndex: number;
}

export class QuerySnapshot<T = unknown> {
  readonly docs: QueryDocumentSnapshot<T>[];
  /** @internal */ readonly _changes: DocumentChange<T>[];
  constructor(
    readonly query: Query<T, any>,
    raw: RawQueryResult,
  ) {
    const db = query.firestore;
    const snap = (d: RawDoc) => new QueryDocumentSnapshot<T>(docFromPath(db, d.path) as DocumentReference<T>, d);
    this.docs = raw.docs.map(snap);
    this._changes = (raw.changes ?? raw.docs.map((d, i): RawChange => ({ type: 'added', doc: d, oldIndex: -1, newIndex: i }))).map((c) => ({ type: c.type, doc: snap(c.doc), oldIndex: c.oldIndex, newIndex: c.newIndex }));
    this.metadata = { hasPendingWrites: raw.hasPendingWrites ?? false, fromCache: raw.fromCache ?? false };
  }
  readonly metadata: SnapshotMetadata;
  get size(): number {
    return this.docs.length;
  }
  get empty(): boolean {
    return this.docs.length === 0;
  }
  forEach(cb: (d: QueryDocumentSnapshot<T>) => void): void {
    this.docs.forEach(cb);
  }
  docChanges(): DocumentChange<T>[] {
    return this._changes;
  }
}

export function snapshotEqual<T>(a: DocumentSnapshot<T> | QuerySnapshot<T>, b: DocumentSnapshot<T> | QuerySnapshot<T>): boolean {
  if (a instanceof DocumentSnapshot && b instanceof DocumentSnapshot) return a.ref.path === b.ref.path && JSON.stringify(a._raw.data) === JSON.stringify(b._raw.data);
  if (a instanceof QuerySnapshot && b instanceof QuerySnapshot) return a.docs.length === b.docs.length && a.docs.every((d, i) => snapshotEqual(d, b.docs[i]!));
  return false;
}

// ─── reads ─────────────────────────────────────────────────────────────────────

const live = (db: Firestore) => {
  if (db._terminated) throw new IceBaseError('failed-precondition', 'The Firestore instance has been terminated');
  return db._driver;
};

export async function getDoc<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  return new DocumentSnapshot(ref, await live(ref.firestore).get(ref.path));
}

export async function getDocs<T, IX>(q: Query<T, IX> | CollectionReference<T, IX>): Promise<QuerySnapshot<T>> {
  checkQuery(q);
  return new QuerySnapshot(q, await live(q.firestore).query(q._spec));
}

// ─── aggregations ──────────────────────────────────────────────────────────────

export class AggregateField<R> {
  /** @internal */ readonly __r?: R;
  constructor(/** @internal */ readonly _a: Aggregate) {}
  get aggregateType(): 'count' | 'sum' | 'avg' {
    return this._a.op;
  }
}
type NumericKeys<T> = { [K in keyof T & string]: T[K] extends number | undefined ? K : never }[keyof T & string];
export const count = (): AggregateField<number> => new AggregateField({ op: 'count' });
export const sum = <T = any>(field: NumericKeys<T> | (string & {})): AggregateField<number> => new AggregateField({ op: 'sum', field });
export const average = <T = any>(field: NumericKeys<T> | (string & {})): AggregateField<number | null> => new AggregateField({ op: 'avg', field });
export const aggregateFieldEqual = (a: AggregateField<unknown>, b: AggregateField<unknown>): boolean => JSON.stringify(a._a) === JSON.stringify(b._a);

export interface AggregateQuerySnapshot<S extends Record<string, AggregateField<unknown>>> {
  data(): { [K in keyof S]: S[K] extends AggregateField<infer R> ? R : never };
}

export async function getAggregateFromServer<T, IX, S extends Record<string, AggregateField<unknown>>>(q: Query<T, IX>, spec: S): Promise<AggregateQuerySnapshot<S>> {
  if (q.firestore._terminated) throw new IceBaseError('failed-precondition', 'The Firestore instance has been terminated');
  // sum() / average() fields are part of the index the query needs.
  if (q._coll) assertIndexed(q._coll, q._spec, Object.values(spec).flatMap((a) => (a._a.op === 'count' ? [] : [[a._a.field]])));
  for (const [alias, a] of Object.entries(spec)) {
    if (a._a.op !== 'count' && q._coll) {
      const def = q._coll.fields[a._a.field];
      if (!def || def.def.kind !== 'number') throw new IceBaseError('invalid-argument', `${a._a.op}('${a._a.field}') as '${alias}' on '${q._coll.path}': needs a number field`, { reason: 'schema' });
    }
  }
  const raw = await live(q.firestore).aggregate(q._spec, Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v._a])));
  return { data: () => raw as ReturnType<AggregateQuerySnapshot<S>['data']> };
}

export async function getCountFromServer<T, IX>(q: Query<T, IX>): Promise<AggregateQuerySnapshot<{ count: AggregateField<number> }>> {
  return getAggregateFromServer(q, { count: count() });
}

// ─── writes ────────────────────────────────────────────────────────────────────

/** Write-time sentinels, same as Firebase. Typed as the field type they stand in for. */
export const serverTimestamp = (): FieldValueImpl & Timestamp => new FieldValueImpl('serverTimestamp') as FieldValueImpl & Timestamp;
export const increment = (n: number): FieldValueImpl & number => {
  if (typeof n !== 'number' || Number.isNaN(n)) throw new IceBaseError('invalid-argument', `increment(${String(n)}): a number`);
  return new FieldValueImpl('increment', n) as FieldValueImpl & number;
};
export const arrayUnion = <E>(...e: E[]): FieldValueImpl & E[] => new FieldValueImpl('arrayUnion', e) as FieldValueImpl & E[];
export const arrayRemove = <E>(...e: E[]): FieldValueImpl & E[] => new FieldValueImpl('arrayRemove', e) as FieldValueImpl & E[];
export const deleteField = (): FieldValueImpl & undefined => new FieldValueImpl('delete') as unknown as FieldValueImpl & undefined;

/** The data of setDoc/addDoc: every required field. */
export type WithFieldValue<T> = T;
/** The data of updateDoc / setDoc merge: any subset. */
export type PartialWithFieldValue<T> = Partial<T>;
export type UpdateData<T> = Partial<T>;
export interface SetOptions {
  merge: true;
}

function untyped(ref: DocumentReference<unknown>, op: string): never {
  throw new IceBaseError('invalid-argument', `${op}(${ref.path}): the path is not in the schema; IceBase only writes declared collections`, { reason: 'unknown-collection' });
}
const checked = (ref: DocumentReference<unknown>, data: unknown, kind: 'create' | 'set' | 'merge', op: string) => (ref._coll ? validateWrite(ref._coll, data, kind) : untyped(ref, op));

/** updateDoc's two shapes, as key-path entries: an object (top-level keys, never split on dots)
 * or field/value pairs (a key, a key array, or a FieldPath, then its value; repeat). */
function updateEntries(ref: DocumentReference<unknown>, args: unknown[], op: string): [string[], unknown][] {
  let entries: UpdateEntry[];
  const [first, ...rest] = args;
  if (first && typeof first === 'object' && !Array.isArray(first) && !(first instanceof FieldPath)) {
    if (rest.length) throw new IceBaseError('invalid-argument', `${op}(ref, data): extra arguments after the data object`);
    entries = Object.entries(first).map(([k, v]) => [[k], v] as const);
  } else {
    if (args.length % 2) throw new IceBaseError('invalid-argument', `${op}(ref, field, value, …): fields and values come in pairs`);
    entries = [];
    for (let i = 0; i < args.length; i += 2) entries.push([keysOf(args[i] as string | readonly string[] | FieldPath), args[i + 1]] as const);
  }
  if (!entries.length) throw new IceBaseError('invalid-argument', `${op}(${ref.path}): nothing to update`);
  return ref._coll ? validateUpdate(ref._coll, entries) : untyped(ref, op);
}

export async function addDoc<T, IX>(ref: CollectionReference<T, IX>, data: WithFieldValue<T>): Promise<DocumentReference<T>> {
  const d = doc(ref);
  await live(ref.firestore).set(d.path, checked(d, data, 'create', 'addDoc'), false);
  return d;
}

export function setDoc<T>(ref: DocumentReference<T>, data: WithFieldValue<T>): Promise<void>;
export function setDoc<T>(ref: DocumentReference<T>, data: PartialWithFieldValue<T>, options: SetOptions): Promise<void>;
export async function setDoc<T>(ref: DocumentReference<T>, data: unknown, options?: SetOptions): Promise<void> {
  const merge = options?.merge === true;
  await live(ref.firestore).set(ref.path, checked(ref, data, merge ? 'merge' : 'set', 'setDoc'), merge);
}

/** updateDoc(ref, { stock: 3 }) — top-level keys. updateDoc(ref, ['address', 'city'], 'Pune', 'stock', 3) — key paths. */
export function updateDoc<T>(ref: DocumentReference<T>, data: UpdateData<T>): Promise<void>;
export function updateDoc<T, F extends keyof T & string>(ref: DocumentReference<T>, field: F, value: T[F], ...moreFieldsAndValues: unknown[]): Promise<void>;
export function updateDoc<T, const P extends PathOf<T>>(ref: DocumentReference<T>, field: P, value: ValueAt<T, P>, ...moreFieldsAndValues: unknown[]): Promise<void>;
export function updateDoc<T>(ref: DocumentReference<T>, field: FieldPath, value: unknown, ...moreFieldsAndValues: unknown[]): Promise<void>;
export async function updateDoc<T>(ref: DocumentReference<T>, ...args: unknown[]): Promise<void> {
  await live(ref.firestore).update(ref.path, updateEntries(ref as DocumentReference<unknown>, args, 'updateDoc'));
}

export async function deleteDoc<T>(ref: DocumentReference<T>): Promise<void> {
  await live(ref.firestore).delete(ref.path);
}

// ─── realtime ──────────────────────────────────────────────────────────────────

export type Unsubscribe = () => void;
type Observer<S> = { next?: (s: S) => void; error?: (e: Error) => void; complete?: () => void };

export function onSnapshot<T>(ref: DocumentReference<T>, next: ((s: DocumentSnapshot<T>) => void) | Observer<DocumentSnapshot<T>>, error?: (e: Error) => void): Unsubscribe;
export function onSnapshot<T, IX>(q: Query<T, IX> | CollectionReference<T, IX>, next: ((s: QuerySnapshot<T>) => void) | Observer<QuerySnapshot<T>>, error?: (e: Error) => void): Unsubscribe;
export function onSnapshot(target: DocumentReference<unknown> | Query<unknown, unknown>, nextOrObserver: ((s: never) => void) | Observer<never>, error?: (e: Error) => void): Unsubscribe {
  const obs: Observer<unknown> = typeof nextOrObserver === 'function' ? { next: nextOrObserver as (s: unknown) => void, ...(error ? { error } : {}) } : (nextOrObserver as Observer<unknown>);
  const onError = (e: Error) => {
    if (obs.error) obs.error(e);
    else console.error('[icebase] onSnapshot error', e);
  };
  if (target instanceof DocumentReference) {
    return live(target.firestore).listenDoc(target.path, (d) => obs.next?.(new DocumentSnapshot(target, d)), onError);
  }
  checkQuery(target);
  return live(target.firestore).listenQuery(target._spec, (r) => obs.next?.(new QuerySnapshot(target, r)), onError);
}

// ─── transactions and batches ──────────────────────────────────────────────────

export class Transaction {
  constructor(/** @internal */ readonly _tx: import('./internal/firestore-driver.ts').TxDriver) {}
  async get<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
    return new DocumentSnapshot(ref, await this._tx.get(ref.path));
  }
  set<T>(ref: DocumentReference<T>, data: WithFieldValue<T>): Transaction;
  set<T>(ref: DocumentReference<T>, data: PartialWithFieldValue<T>, options: SetOptions): Transaction;
  set<T>(ref: DocumentReference<T>, data: unknown, options?: SetOptions): Transaction {
    const merge = options?.merge === true;
    this._tx.set(ref.path, checked(ref, data, merge ? 'merge' : 'set', 'transaction.set'), merge);
    return this;
  }
  update<T>(ref: DocumentReference<T>, data: UpdateData<T>): Transaction;
  update<T, F extends keyof T & string>(ref: DocumentReference<T>, field: F, value: T[F], ...moreFieldsAndValues: unknown[]): Transaction;
  update<T, const P extends PathOf<T>>(ref: DocumentReference<T>, field: P, value: ValueAt<T, P>, ...moreFieldsAndValues: unknown[]): Transaction;
  update<T>(ref: DocumentReference<T>, field: FieldPath, value: unknown, ...moreFieldsAndValues: unknown[]): Transaction;
  update<T>(ref: DocumentReference<T>, ...args: unknown[]): Transaction {
    this._tx.update(ref.path, updateEntries(ref as DocumentReference<unknown>, args, 'transaction.update'));
    return this;
  }
  delete<T>(ref: DocumentReference<T>): Transaction {
    this._tx.delete(ref.path);
    return this;
  }
}

export async function runTransaction<R>(db: Firestore, fn: (tx: Transaction) => Promise<R>, options?: { maxAttempts?: number }): Promise<R> {
  return live(db).transaction((tx) => fn(new Transaction(tx)), options);
}

export class WriteBatch {
  /** @internal */ _committed = false;
  constructor(/** @internal */ readonly _b: import('./internal/firestore-driver.ts').BatchDriver) {}
  private open(): void {
    if (this._committed) throw new IceBaseError('failed-precondition', 'A write batch can no longer be used after commit() has been called.');
  }
  set<T>(ref: DocumentReference<T>, data: WithFieldValue<T>): WriteBatch;
  set<T>(ref: DocumentReference<T>, data: PartialWithFieldValue<T>, options: SetOptions): WriteBatch;
  set<T>(ref: DocumentReference<T>, data: unknown, options?: SetOptions): WriteBatch {
    this.open();
    const merge = options?.merge === true;
    this._b.set(ref.path, checked(ref, data, merge ? 'merge' : 'set', 'batch.set'), merge);
    return this;
  }
  update<T>(ref: DocumentReference<T>, data: UpdateData<T>): WriteBatch;
  update<T, F extends keyof T & string>(ref: DocumentReference<T>, field: F, value: T[F], ...moreFieldsAndValues: unknown[]): WriteBatch;
  update<T, const P extends PathOf<T>>(ref: DocumentReference<T>, field: P, value: ValueAt<T, P>, ...moreFieldsAndValues: unknown[]): WriteBatch;
  update<T>(ref: DocumentReference<T>, field: FieldPath, value: unknown, ...moreFieldsAndValues: unknown[]): WriteBatch;
  update<T>(ref: DocumentReference<T>, ...args: unknown[]): WriteBatch {
    this.open();
    this._b.update(ref.path, updateEntries(ref as DocumentReference<unknown>, args, 'batch.update'));
    return this;
  }
  delete<T>(ref: DocumentReference<T>): WriteBatch {
    this.open();
    this._b.delete(ref.path);
    return this;
  }
  async commit(): Promise<void> {
    this.open();
    this._committed = true;
    await this._b.commit();
  }
}

export function writeBatch(db: Firestore): WriteBatch {
  return new WriteBatch(live(db).batch());
}

export { IceBaseError as FirestoreError } from './errors.ts';
export type { QuerySpec } from './internal/plan.ts';

// firebase mode (client side) and emulator mode (both sides).
import { createWebDriver } from './drivers/firestore-web.ts';
import { createEmulatorDriver } from './drivers/firestore-emulator.ts';
registerFirestoreDriver('client:firebase', createWebDriver);
registerFirestoreDriver('client:emulator', createEmulatorDriver);
registerFirestoreDriver('admin:emulator', createEmulatorDriver);
