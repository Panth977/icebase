// icebase-server/compat — Firestore with firebase-admin's API (collection('a').doc('b').get(),
// where('counts.active', '>', 0), FieldValue.increment(1) …), for code written against
// firebase-admin that moves to IceBase without rewriting its call sites.
//
// Underneath it is IceBase: every write is validated against the schema, every query needs its
// indexes declared, and the backend is the app's mode (firebase-admin in firebase mode, the IceBase
// server in emulator mode). Unlike IceBase's typed API — and like firebase-admin — a string field
// path is split on dots here; use new FieldPath('a.b') for a key that contains a dot.

import { IceBaseError } from '@panth977/icebase/errors';
import type { IceBaseApp } from '@panth977/icebase/app';
import { assertIndexed, autoId, fullOrder, isName, FieldValue as IbFieldValue, GeoPoint as IbGeoPoint, isPlainObject, Timestamp as IbTimestamp, type FilterNode, type FirestoreDriver, type QuerySpec, type RawDoc, type TxDriver, type WhereOp } from '@panth977/icebase/internal';
import { matchCollectionPath, validateQueryValue, validateUpdate, validateWrite, type AnyCollection } from '@panth977/icebase/schema';
import { getAdminFirestore } from './admin.ts';

// ─── values ──────────────────────────────────────────────────────────────────────

/** firebase-admin's Timestamp (IceBase's, with the same methods). */
export const Timestamp: typeof IbTimestamp = IbTimestamp;
export type Timestamp = IbTimestamp;
export const GeoPoint: typeof IbGeoPoint = IbGeoPoint;
export type GeoPoint = IbGeoPoint;

/** firebase-admin's FieldValue: FieldValue.increment(1), FieldValue.delete() … */
export class FieldValue extends IbFieldValue {
  static increment(n: number): FieldValue {
    return new IbFieldValue('increment', n) as FieldValue;
  }
  static arrayUnion(...elements: unknown[]): FieldValue {
    return new IbFieldValue('arrayUnion', elements) as FieldValue;
  }
  static arrayRemove(...elements: unknown[]): FieldValue {
    return new IbFieldValue('arrayRemove', elements) as FieldValue;
  }
  static delete(): FieldValue {
    return new IbFieldValue('delete') as FieldValue;
  }
  static serverTimestamp(): FieldValue {
    return new IbFieldValue('serverTimestamp') as FieldValue;
  }
  static [Symbol.hasInstance](v: unknown): boolean {
    return v instanceof IbFieldValue;
  }
}

/** A field path given as its keys (a key may contain dots), or the document id. */
export class FieldPath {
  readonly segments: string[];
  constructor(...segments: string[]) {
    if (!segments.length || segments.some((s) => typeof s !== 'string' || !s)) throw new IceBaseError('invalid-argument', 'new FieldPath(…) needs one or more non-empty keys');
    this.segments = segments;
  }
  static documentId(): FieldPath {
    return new FieldPath('__name__');
  }
  isEqual(other: FieldPath): boolean {
    return other instanceof FieldPath && other.segments.join('\u0000') === this.segments.join('\u0000');
  }
  toString(): string {
    return this.segments.join('.');
  }
}

const keysOf = (f: string | FieldPath): string[] => {
  if (f instanceof FieldPath) return f.segments;
  if (typeof f !== 'string' || !f) throw new IceBaseError('invalid-argument', `A field path must be a non-empty string or a FieldPath, got ${String(f)}`);
  return f === '__name__' ? ['__name__'] : f.split('.');
};

export interface SetOptions {
  readonly merge?: boolean;
  readonly mergeFields?: Array<string | FieldPath>;
}
export interface Precondition {
  readonly lastUpdateTime?: Timestamp;
  readonly exists?: boolean;
}
export interface WriteResult {
  readonly writeTime: Timestamp;
}
export type DocumentData = Record<string, any>;
export interface FirestoreDataConverter<T> {
  toFirestore(modelObject: T, options?: SetOptions): DocumentData;
  fromFirestore(snapshot: QueryDocumentSnapshot<DocumentData>): T;
}
export type WhereFilterOp = WhereOp;
export type OrderByDirection = 'asc' | 'desc';

/**
 * firebase-admin's errors carry the gRPC status as a number (6 = ALREADY_EXISTS …); code written
 * for it checks e.code === 6. Errors from the IceBase layer are given that shape.
 */
export class FirestoreError extends Error {
  /** The gRPC status number. */
  readonly code: number;
  /** IceBase's code ('already-exists' …). */
  readonly icebaseCode: string;
  readonly details: string;
  constructor(e: IceBaseError) {
    const code = codeOf(e.code);
    super(`${code} ${STATUS[code] ?? 'UNKNOWN'}: ${e.message}`, { cause: e });
    this.name = 'FirestoreError';
    this.code = code;
    this.icebaseCode = e.code;
    this.details = e.message;
  }
}

/** Errors the caller's own code threw inside a transaction pass through untouched. */
const own = new WeakSet<object>();

async function guard<R>(p: Promise<R> | (() => Promise<R>)): Promise<R> {
  try {
    return await (typeof p === 'function' ? p() : p);
  } catch (e) {
    throw adminError(e);
  }
}
function adminError(e: unknown): unknown {
  if (e && typeof e === 'object' && own.has(e)) return e;
  if (e instanceof IceBaseError) return new FirestoreError(e);
  return e;
}
const sync = <R>(fn: () => R): R => {
  try {
    return fn();
  } catch (e) {
    throw adminError(e);
  }
};

const written = (): WriteResult => ({ writeTime: Timestamp.now() });
const toTs = (t: { seconds: number; nanoseconds: number } | undefined) => (t ? new Timestamp(t.seconds, t.nanoseconds) : undefined);

/** firebase-admin's ignoreUndefinedProperties: undefined fields are dropped, at every depth. */
function dropUndefined(v: unknown): unknown {
  // A Date is stored as a Timestamp, as firebase-admin does.
  if (v instanceof Date && !Number.isNaN(v.getTime())) return Timestamp.fromDate(v);
  if (Array.isArray(v)) return v.filter((x) => x !== undefined).map(dropUndefined);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, dropUndefined(x)]));
  if (v instanceof IbFieldValue && (v.op === 'arrayUnion' || v.op === 'arrayRemove')) return new IbFieldValue(v.op, (v.operand as unknown[]).map(dropUndefined));
  return v;
}

// ─── the database ────────────────────────────────────────────────────────────────

export interface CompatIssue {
  kind: 'collection' | 'index' | 'write' | 'query-value';
  /** The collection path (template when known). */
  collection: string;
  message: string;
  /** For 'index': the index(…) to declare. */
  suggestion?: string;
}

export interface CompatOptions {
  /** Check where() values against the field's type (default true). */
  checkQueryValues?: boolean;
  /** Validate writes against the schema (default true). */
  validate?: boolean;
  /**
   * Learning mode, for moving an existing codebase: instead of refusing an undeclared collection,
   * an undeclared index, a write or a query value that does not match the schema, report it here
   * and go on. Never use it in production.
   */
  learn?: (issue: CompatIssue) => void;
}

export class Firestore {
  /** @internal */ readonly _driver: FirestoreDriver;
  /** @internal */ readonly _opts: Required<Omit<CompatOptions, 'learn'>> & Pick<CompatOptions, 'learn'>;
  constructor(
    readonly app: IceBaseApp,
    opts: CompatOptions = {},
  ) {
    this._driver = getAdminFirestore(app)._driver;
    this._opts = { checkQueryValues: opts.checkQueryValues ?? true, validate: opts.validate ?? true, ...(opts.learn ? { learn: opts.learn } : {}) };
  }

  /** @internal the declared collection of a collection path (learning mode: null when undeclared). */
  _coll(collectionPath: string): AnyCollection {
    const m = matchCollectionPath(this.app.config.schema, collectionPath);
    if (!m) {
      const message = `'${collectionPath}' is not a collection in the schema; declare it with collection(…)`;
      if (this._opts.learn) {
        this._opts.learn({ kind: 'collection', collection: collectionPath, message });
        return null as unknown as AnyCollection;
      }
      throw new IceBaseError('invalid-argument', message, { reason: 'unknown-collection', collection: collectionPath });
    }
    return m.collection;
  }
  /** @internal run a check; in learning mode report its failure instead of throwing. */
  _try<R>(kind: CompatIssue['kind'], c: AnyCollection | null, fn: () => R, fallback: R): R {
    if (!c) return fallback;
    if (!this._opts.learn) return fn();
    try {
      return fn();
    } catch (e) {
      const err = e as IceBaseError;
      this._opts.learn({ kind, collection: c.path, message: err.message, ...(err.details?.index ? { suggestion: String(err.details.index) } : {}) });
      return fallback;
    }
  }
  /** @internal */
  _group(collectionId: string): AnyCollection {
    const c = Object.values(this.app.config.schema.collections).find((x) => x.id === collectionId && x.group) ?? Object.values(this.app.config.schema.collections).find((x) => x.id === collectionId);
    if (!c) {
      const message = `collectionGroup('${collectionId}'): no collection with that id in the schema`;
      if (this._opts.learn) {
        this._opts.learn({ kind: 'collection', collection: `**/${collectionId}`, message });
        return null as unknown as AnyCollection;
      }
      throw new IceBaseError('invalid-argument', message, { reason: 'unknown-collection', collection: collectionId });
    }
    return c;
  }

  settings(_s: unknown): void {}
  doc(documentPath: string): DocumentReference {
    const p = clean(documentPath);
    if (p.split('/').length % 2) throw new IceBaseError('invalid-argument', `doc('${documentPath}'): a document path has an even number of segments`);
    return new DocumentReference(this, p);
  }
  collection(collectionPath: string): CollectionReference {
    const p = clean(collectionPath);
    if (p.split('/').length % 2 === 0) throw new IceBaseError('invalid-argument', `collection('${collectionPath}'): a collection path has an odd number of segments`);
    return new CollectionReference(this, p);
  }
  collectionGroup(collectionId: string): Query {
    return new Query(this, { path: null, collectionId, filters: [], orders: [] });
  }
  async getAll<T>(...refsOrOptions: Array<DocumentReference<T> | { fieldMask?: unknown }>): Promise<DocumentSnapshot<T>[]> {
    const refs = refsOrOptions.filter((r): r is DocumentReference<T> => r instanceof DocumentReference);
    if (!refs.length) return [];
    const raws = await guard(() => (this._driver.getAll ? this._driver.getAll(refs.map((r) => r.path)) : Promise.all(refs.map((r) => this._driver.get(r.path)))));
    return raws.map((r, i) => refs[i]!._snap(r));
  }
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>, opts?: { maxAttempts?: number } | { readOnly?: boolean }): Promise<T> {
    const maxAttempts = opts && 'maxAttempts' in opts ? opts.maxAttempts : undefined;
    return guard(() =>
      this._driver.transaction(async (tx) => {
        try {
          return await fn(new Transaction(this, tx));
        } catch (e) {
          // The caller's error (not a FirestoreError of ours): through as is, never retried as a conflict.
          if (e && typeof e === 'object' && !(e instanceof FirestoreError)) own.add(e);
          throw e instanceof FirestoreError ? (e.cause as Error) : e;
        }
      }, maxAttempts ? { maxAttempts } : {}),
    );
  }
  batch(): WriteBatch {
    return new WriteBatch(this);
  }
  bulkWriter(_opts?: unknown): BulkWriter {
    return new BulkWriter(this);
  }
  async recursiveDelete(ref: DocumentReference<unknown> | CollectionReference<unknown>, _bulkWriter?: BulkWriter): Promise<void> {
    if (!this._driver.recursiveDelete) throw new IceBaseError('unimplemented', 'recursiveDelete() is not available on this driver');
    await guard(this._driver.recursiveDelete(ref.path));
  }
  async listCollections(): Promise<CollectionReference[]> {
    if (!this._driver.listCollections) throw new IceBaseError('unimplemented', 'listCollections() is not available on this driver');
    return (await guard(this._driver.listCollections(null))).map((id) => new CollectionReference(this, id));
  }
  terminate(): Promise<void> {
    return this._driver.terminate();
  }

  // ── writes, shared by refs, batches, transactions and the bulk writer ──

  /** @internal set / merge / mergeFields → [data, merge] for the driver. */
  _setData(ref: DocumentReference<any>, data: unknown, options?: SetOptions): [Record<string, unknown>, boolean] {
    let d = ref._conv ? ref._conv.toFirestore(data, options) : data;
    d = dropUndefined(d);
    if (!isPlainObject(d)) throw new IceBaseError('invalid-argument', `set(${ref.path}): the data must be an object`);
    if (options?.mergeFields) {
      // Only the named fields, merged.
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
      return [this._valid(ref, picked, 'merge'), true];
    }
    const merge = !!options?.merge;
    return [this._valid(ref, d, merge ? 'merge' : 'set'), merge];
  }
  /** @internal */
  _valid(ref: DocumentReference<any>, data: Record<string, unknown>, kind: 'create' | 'set' | 'merge'): Record<string, unknown> {
    const c = this._coll(ref.parent.path);
    return this._opts.validate ? this._try('write', c, () => validateWrite(c, data, kind), data) : data;
  }
  /** @internal update(data) or update(field, value, …) → key paths and values. */
  _updateData(ref: DocumentReference<any>, args: unknown[]): { fields: [string[], unknown][]; pre?: Precondition } {
    const entries: [string[], unknown][] = [];
    let pre: Precondition | undefined;
    if (typeof args[0] === 'string' || args[0] instanceof FieldPath) {
      let i = 0;
      for (; i + 1 < args.length; i += 2) entries.push([keysOf(args[i] as string | FieldPath), dropUndefined(args[i + 1])]);
      if (i < args.length) pre = args[i] as Precondition;
    } else {
      const data = args[0];
      if (!isPlainObject(data)) throw new IceBaseError('invalid-argument', `update(${ref.path}): the data must be an object`);
      for (const [k, v] of Object.entries(data)) if (v !== undefined) entries.push([keysOf(k), dropUndefined(v)]);
      pre = args[1] as Precondition | undefined;
    }
    if (!entries.length) throw new IceBaseError('invalid-argument', `update(${ref.path}): nothing to update`);
    const c = this._coll(ref.parent.path);
    return { fields: this._opts.validate ? this._try('write', c, () => validateUpdate(c, entries), entries) : entries, ...(pre ? { pre } : {}) };
  }
  /** @internal a write that needs a precondition runs in its own transaction. */
  async _guarded(ref: DocumentReference<any>, pre: Precondition | undefined, write: (tx: TxDriver) => void): Promise<void> {
    await guard(() =>
      this._driver.transaction(async (tx) => {
        const cur = await tx.get(ref.path);
        check(ref, cur, pre);
        write(tx);
      }),
    );
  }
}

function check(ref: DocumentReference<any>, cur: RawDoc, pre: Precondition | undefined): void {
  if (!pre) return;
  if (pre.exists === true && !cur.data) throw new IceBaseError('not-found', `No document to update: ${ref.path}`);
  if (pre.exists === false && cur.data) throw new IceBaseError('already-exists', `Document already exists: ${ref.path}`);
  if (pre.lastUpdateTime) {
    const u = cur.updateTime;
    if (!u || u.seconds !== pre.lastUpdateTime.seconds || u.nanoseconds !== pre.lastUpdateTime.nanoseconds) throw new IceBaseError('failed-precondition', `The document was updated: ${ref.path}`);
  }
}

const clean = (p: string) => p.replace(/^\/+|\/+$/g, '');

/** Driver data → what firebase-admin code expects (references as DocumentReference). */
function fromDriver(db: Firestore, v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof IbTimestamp || v instanceof IbGeoPoint || v instanceof Uint8Array) return v;
  if ((v as { type?: unknown }).type === 'document' && typeof (v as { path?: unknown }).path === 'string') return new DocumentReference(db, (v as { path: string }).path);
  if (Array.isArray(v)) return v.map((x) => fromDriver(db, x));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromDriver(db, x)]));
}

// ─── references ──────────────────────────────────────────────────────────────────

export class DocumentReference<T = DocumentData> {
  /** Stored as a value, a reference is { type: 'document', path } to IceBase. */
  readonly type = 'document' as const;
  /** @internal */ readonly _conv: FirestoreDataConverter<T> | null;
  constructor(
    readonly firestore: Firestore,
    readonly path: string,
    conv: FirestoreDataConverter<T> | null = null,
  ) {
    this._conv = conv;
  }
  get id(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }
  get parent(): CollectionReference<T> {
    return new CollectionReference<T>(this.firestore, this.path.slice(0, this.path.lastIndexOf('/')), this._conv);
  }
  collection(collectionPath: string): CollectionReference {
    return this.firestore.collection(`${this.path}/${clean(collectionPath)}`);
  }
  async listCollections(): Promise<CollectionReference[]> {
    const d = this.firestore._driver;
    if (!d.listCollections) throw new IceBaseError('unimplemented', 'listCollections() is not available on this driver');
    return (await guard(d.listCollections(this.path))).map((id) => this.collection(id));
  }
  /** @internal */
  _snap(r: RawDoc): DocumentSnapshot<T> {
    return new DocumentSnapshot<T>(this, r.data ? (fromDriver(this.firestore, r.data) as DocumentData) : undefined, r);
  }
  async get(): Promise<DocumentSnapshot<T>> {
    return this._snap(await guard(this.firestore._driver.get(this.path)));
  }
  async create(data: T): Promise<WriteResult> {
    const d = sync(() => this.firestore._valid(this, dropUndefined(this._conv ? this._conv.toFirestore(data) : data) as Record<string, unknown>, 'create'));
    await guard(this.firestore._driver.create(this.path, d));
    return written();
  }
  async set(data: Partial<T> | T, options?: SetOptions): Promise<WriteResult> {
    const [d, merge] = sync(() => this.firestore._setData(this, data, options));
    await guard(this.firestore._driver.set(this.path, d, merge));
    return written();
  }
  async update(...args: unknown[]): Promise<WriteResult> {
    const { fields, pre } = sync(() => this.firestore._updateData(this, args));
    if (pre && (pre.lastUpdateTime || pre.exists === false)) await this.firestore._guarded(this, pre, (tx) => tx.update(this.path, fields));
    else await guard(this.firestore._driver.update(this.path, fields));
    return written();
  }
  async delete(precondition?: Precondition): Promise<WriteResult> {
    if (precondition && (precondition.exists !== undefined || precondition.lastUpdateTime)) await this.firestore._guarded(this, precondition, (tx) => tx.delete(this.path));
    else await guard(this.firestore._driver.delete(this.path));
    return written();
  }
  isEqual(other: DocumentReference<unknown>): boolean {
    return other instanceof DocumentReference && other.path === this.path;
  }
  withConverter<U>(converter: FirestoreDataConverter<U> | null): DocumentReference<U> {
    return new DocumentReference<U>(this.firestore, this.path, converter);
  }
  toJSON(): { type: 'document'; path: string } {
    return { type: 'document', path: this.path };
  }
}

export class DocumentSnapshot<T = DocumentData> {
  constructor(
    readonly ref: DocumentReference<T>,
    /** @internal */ readonly _data: DocumentData | undefined,
    /** @internal */ readonly _raw: RawDoc,
  ) {}
  get exists(): boolean {
    return this._data !== undefined;
  }
  get id(): string {
    return this.ref.id;
  }
  get createTime(): Timestamp | undefined {
    return toTs(this._raw.createTime);
  }
  get updateTime(): Timestamp | undefined {
    return toTs(this._raw.updateTime);
  }
  get readTime(): Timestamp {
    return Timestamp.now();
  }
  data(): T | undefined {
    if (this._data === undefined) return undefined;
    if (this.ref._conv) return this.ref._conv.fromFirestore(new QueryDocumentSnapshot(this.ref.withConverter(null), this._data, this._raw));
    return this._data as T;
  }
  get(field: string | FieldPath): any {
    let cur: unknown = this._data;
    for (const k of keysOf(field)) cur = isPlainObject(cur) ? cur[k] : undefined;
    return cur;
  }
  isEqual(other: DocumentSnapshot<T>): boolean {
    return other instanceof DocumentSnapshot && other.ref.path === this.ref.path && JSON.stringify(other._data) === JSON.stringify(this._data);
  }
}

export class QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  override get createTime(): Timestamp {
    return toTs(this._raw.createTime) ?? Timestamp.now();
  }
  override get updateTime(): Timestamp {
    return toTs(this._raw.updateTime) ?? Timestamp.now();
  }
  override data(): T {
    return super.data()!;
  }
}

export class QuerySnapshot<T = DocumentData> {
  constructor(
    readonly query: Query<T>,
    readonly docs: QueryDocumentSnapshot<T>[],
  ) {}
  get size(): number {
    return this.docs.length;
  }
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get readTime(): Timestamp {
    return Timestamp.now();
  }
  forEach(cb: (d: QueryDocumentSnapshot<T>) => void): void {
    this.docs.forEach(cb);
  }
}

// ─── queries ─────────────────────────────────────────────────────────────────────

type Cursor = { kind: 'startAt' | 'startAfter' | 'endAt' | 'endBefore'; args: unknown[] };

export class Query<T = DocumentData> {
  constructor(
    readonly firestore: Firestore,
    /** @internal */ readonly _spec: QuerySpec,
    /** @internal */ readonly _conv: FirestoreDataConverter<T> | null = null,
    /** @internal */ readonly _extra: { offset?: number; select?: string[][]; cursors?: Cursor[] } = {},
  ) {}

  /** @internal */
  _with(spec: Partial<QuerySpec>, extra: Partial<Query['_extra']> = {}): Query<T> {
    return new Query<T>(this.firestore, { ...this._spec, ...spec }, this._conv, { ...this._extra, ...extra });
  }
  /** @internal */
  _collection(): AnyCollection {
    return this._spec.path !== null ? this.firestore._coll(this._spec.path) : this.firestore._group(this._spec.collectionId);
  }
  /** @internal every collection the query reads (a collection-group query: each group: true one with its id). */
  _collections(): AnyCollection[] {
    if (this._spec.path !== null) return [this._collection()];
    const all = Object.values(this.firestore.app.config.schema.collections).filter((c) => c.id === this._spec.collectionId && c.group);
    return all.length ? all : [this._collection()];
  }

  where(fieldPath: string | FieldPath, op: WhereFilterOp, value: unknown): Query<T> {
    const field = keysOf(fieldPath);
    let v = value instanceof DocumentReference ? { type: 'document', path: value.path } : value;
    if (field.length === 1 && field[0] === '__name__') {
      // documentId(): a plain id means a document of this collection.
      const toRef = (x: unknown) => (typeof x === 'string' ? { type: 'document', path: x.includes('/') ? x : `${this._spec.path}/${x}` } : x instanceof DocumentReference ? { type: 'document', path: x.path } : x);
      v = Array.isArray(v) ? v.map(toRef) : toRef(v);
    } else if (this.firestore._opts.checkQueryValues) {
      const c = this._collection();
      sync(() => this.firestore._try('query-value', c, () => validateQueryValue(c, field, op, v), undefined));
    }
    const node: FilterNode = { kind: 'field', field, op, value: v };
    return this._with({ filters: [...this._spec.filters, node] });
  }
  orderBy(fieldPath: string | FieldPath, dir: OrderByDirection = 'asc'): Query<T> {
    return this._with({ orders: [...this._spec.orders, { field: keysOf(fieldPath), dir }] });
  }
  limit(n: number): Query<T> {
    return this._with({ limit: { n, last: false } });
  }
  limitToLast(n: number): Query<T> {
    return this._with({ limit: { n, last: true } });
  }
  offset(n: number): Query<T> {
    return this._with({}, { offset: n });
  }
  select(...fields: (string | FieldPath)[]): Query<DocumentData> {
    return this._with({}, { select: fields.map(keysOf) }) as unknown as Query<DocumentData>;
  }
  startAt(...args: unknown[]): Query<T> {
    return this._cursor('startAt', args);
  }
  startAfter(...args: unknown[]): Query<T> {
    return this._cursor('startAfter', args);
  }
  endAt(...args: unknown[]): Query<T> {
    return this._cursor('endAt', args);
  }
  endBefore(...args: unknown[]): Query<T> {
    return this._cursor('endBefore', args);
  }
  /** @internal */
  _cursor(kind: Cursor['kind'], args: unknown[]): Query<T> {
    const snap = args.length === 1 && args[0] instanceof DocumentSnapshot ? (args[0] as DocumentSnapshot<unknown>) : null;
    const inclusive = kind === 'startAt' || kind === 'endAt';
    const pos = snap
      ? snap._raw.native
        ? { values: [], inclusive, snapshot: snap._raw.native }
        : { values: this._valuesOf(snap), inclusive }
      : { values: this._cursorValues(args), inclusive };
    const key = kind === 'startAt' || kind === 'startAfter' ? 'start' : 'end';
    return this._with({ [key]: pos });
  }
  /** @internal cursor values, aligned with the query's order: a document id for __name__ becomes its reference. */
  _cursorValues(args: unknown[]): unknown[] {
    const order = fullOrder(this._spec);
    return args.map((a, i) => {
      if (a instanceof DocumentReference) return { type: 'document', path: a.path };
      const o = order[i];
      if (o && isName(o.field) && typeof a === 'string') return { type: 'document', path: a.includes('/') || this._spec.path === null ? a : `${this._spec.path}/${a}` };
      return a;
    });
  }
  /** @internal the snapshot's values for every order (explicit, then __name__). */
  _valuesOf(snap: DocumentSnapshot<unknown>): unknown[] {
    const orders = [...this._spec.orders];
    if (!orders.some((o) => o.field.length === 1 && o.field[0] === '__name__')) orders.push({ field: ['__name__'], dir: orders.at(-1)?.dir ?? 'asc' });
    return orders.map((o) => (o.field[0] === '__name__' && o.field.length === 1 ? { type: 'document', path: snap.ref.path } : snap.get(new FieldPath(...o.field))));
  }

  /** @internal checks the indexes, runs, applies offset/select. */
  async _run(): Promise<RawDoc[]> {
    for (const c of this._collections()) sync(() => this.firestore._try('index', c, () => assertIndexed(c, this._spec), undefined));
    const off = this._extra.offset ?? 0;
    const spec: QuerySpec = off && this._spec.limit && !this._spec.limit.last ? { ...this._spec, limit: { n: this._spec.limit.n + off, last: false } } : this._spec;
    let docs = (await guard(this.firestore._driver.query(spec))).docs;
    if (off) docs = docs.slice(off);
    return docs;
  }
  async get(): Promise<QuerySnapshot<T>> {
    const docs = await this._run();
    const sel = this._extra.select;
    return new QuerySnapshot<T>(
      this,
      docs.map((r) => {
        let data = fromDriver(this.firestore, r.data) as DocumentData;
        if (sel) {
          const out: DocumentData = {};
          for (const keys of sel) {
            let src: unknown = data;
            for (const k of keys) src = isPlainObject(src) ? src[k] : undefined;
            if (src === undefined) continue;
            let dst = out;
            keys.slice(0, -1).forEach((k) => (dst = (dst[k] ??= {}) as DocumentData));
            dst[keys[keys.length - 1]!] = src;
          }
          data = out;
        }
        return new QueryDocumentSnapshot<T>(new DocumentReference<T>(this.firestore, r.path, this._conv), data, r);
      }),
    );
  }
  count(): AggregateQuery {
    return new AggregateQuery(this);
  }
  withConverter<U>(converter: FirestoreDataConverter<U> | null): Query<U> {
    return new Query<U>(this.firestore, this._spec, converter, this._extra);
  }
  isEqual(other: Query<T>): boolean {
    return other instanceof Query && JSON.stringify(other._spec) === JSON.stringify(this._spec);
  }
}

export class AggregateQuery {
  constructor(readonly query: Query<unknown>) {}
  async get(): Promise<{ data(): { count: number } }> {
    const q = this.query;
    for (const c of q._collections()) sync(() => q.firestore._try('index', c, () => assertIndexed(c, q._spec), undefined));
    const r = await guard(q.firestore._driver.aggregate(q._spec, { count: { op: 'count' } }));
    const count = Number(r.count ?? 0);
    return { data: () => ({ count }) };
  }
}

export class CollectionReference<T = DocumentData> extends Query<T> {
  constructor(firestore: Firestore, path: string, conv: FirestoreDataConverter<T> | null = null) {
    super(firestore, { path, collectionId: path.slice(path.lastIndexOf('/') + 1), filters: [], orders: [] }, conv);
  }
  get path(): string {
    return this._spec.path!;
  }
  get id(): string {
    return this._spec.collectionId;
  }
  get parent(): DocumentReference | null {
    const i = this.path.lastIndexOf('/');
    return i < 0 ? null : new DocumentReference(this.firestore, this.path.slice(0, i));
  }
  doc(documentPath?: string): DocumentReference<T> {
    return new DocumentReference<T>(this.firestore, `${this.path}/${documentPath === undefined ? autoId() : clean(documentPath)}`, this._conv);
  }
  async add(data: T): Promise<DocumentReference<T>> {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
  /** Every document of the collection (documents that only hold subcollections are not listed). */
  async listDocuments(): Promise<DocumentReference<T>[]> {
    const r = await guard(this.firestore._driver.query(this._spec));
    return r.docs.map((d) => new DocumentReference<T>(this.firestore, d.path, this._conv));
  }
  override withConverter<U>(converter: FirestoreDataConverter<U> | null): CollectionReference<U> {
    return new CollectionReference<U>(this.firestore, this.path, converter);
  }
}

// ─── transactions, batches, the bulk writer ──────────────────────────────────────

export class Transaction {
  constructor(
    private readonly db: Firestore,
    private readonly tx: TxDriver,
  ) {}
  get<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>>;
  get<T>(query: Query<T>): Promise<QuerySnapshot<T>>;
  get(q: AggregateQuery): Promise<{ data(): { count: number } }>;
  async get(x: unknown): Promise<unknown> {
    if (x instanceof DocumentReference) return x._snap(await guard(this.tx.get(x.path)));
    if (x instanceof Query) {
      // Queries inside a transaction read outside it, then lock each result by reading it.
      const snap = await x.get();
      await Promise.all(snap.docs.map((d) => this.tx.get(d.ref.path)));
      return snap;
    }
    if (x instanceof AggregateQuery) return x.get();
    throw new IceBaseError('invalid-argument', 'transaction.get(…) takes a DocumentReference or a Query');
  }
  async getAll<T>(...refs: Array<DocumentReference<T> | { fieldMask?: unknown }>): Promise<DocumentSnapshot<T>[]> {
    const rs = refs.filter((r): r is DocumentReference<T> => r instanceof DocumentReference);
    return Promise.all(rs.map(async (r) => r._snap(await guard(this.tx.get(r.path)))));
  }
  create<T>(ref: DocumentReference<T>, data: T): Transaction {
    const d = sync(() => this.db._valid(ref, dropUndefined(ref._conv ? ref._conv.toFirestore(data) : data) as Record<string, unknown>, 'create'));
    if (!this.tx.create) throw new IceBaseError('unimplemented', 'transaction.create() is not available on this driver');
    this.tx.create(ref.path, d);
    return this;
  }
  set<T>(ref: DocumentReference<T>, data: Partial<T> | T, options?: SetOptions): Transaction {
    const [d, merge] = sync(() => this.db._setData(ref, data, options));
    this.tx.set(ref.path, d, merge);
    return this;
  }
  update(ref: DocumentReference<any>, ...args: unknown[]): Transaction {
    const { fields } = sync(() => this.db._updateData(ref, args));
    this.tx.update(ref.path, fields);
    return this;
  }
  delete(ref: DocumentReference<any>, _pre?: Precondition): Transaction {
    this.tx.delete(ref.path);
    return this;
  }
}

export class WriteBatch {
  private readonly b;
  constructor(private readonly db: Firestore) {
    this.b = db._driver.batch();
  }
  create<T>(ref: DocumentReference<T>, data: T): WriteBatch {
    const d = sync(() => this.db._valid(ref, dropUndefined(ref._conv ? ref._conv.toFirestore(data) : data) as Record<string, unknown>, 'create'));
    if (!this.b.create) throw new IceBaseError('unimplemented', 'batch.create() is not available on this driver');
    this.b.create(ref.path, d);
    return this;
  }
  set<T>(ref: DocumentReference<T>, data: Partial<T> | T, options?: SetOptions): WriteBatch {
    const [d, merge] = sync(() => this.db._setData(ref, data, options));
    this.b.set(ref.path, d, merge);
    return this;
  }
  update(ref: DocumentReference<any>, ...args: unknown[]): WriteBatch {
    const { fields } = sync(() => this.db._updateData(ref, args));
    this.b.update(ref.path, fields);
    return this;
  }
  delete(ref: DocumentReference<any>, _pre?: Precondition): WriteBatch {
    this.b.delete(ref.path);
    return this;
  }
  async commit(): Promise<WriteResult[]> {
    await guard(this.b.commit());
    return [written()];
  }
}

export interface BulkWriterError {
  readonly code: number;
  readonly message: string;
  readonly documentRef: DocumentReference<unknown>;
  readonly failedAttempts: number;
}

/** Each write on its own, a few at a time; failures go to onWriteError (retry when it says so). */
export class BulkWriter {
  private readonly pending = new Set<Promise<unknown>>();
  private retry: (e: BulkWriterError) => boolean = (e) => e.failedAttempts < 3 && e.code === 10;
  constructor(private readonly db: Firestore) {}

  private run<R>(ref: DocumentReference<any>, op: () => Promise<R>): Promise<R> {
    const go = async (attempt: number): Promise<R> => {
      try {
        return await op();
      } catch (e) {
        const code = codeOf((e as IceBaseError).code);
        if (this.retry({ code, message: (e as Error).message, documentRef: ref, failedAttempts: attempt })) return go(attempt + 1);
        throw e;
      }
    };
    const p = go(1);
    const tracked = p.catch(() => undefined).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return p;
  }
  create<T>(ref: DocumentReference<T>, data: T): Promise<WriteResult> {
    return this.run(ref, () => ref.create(data));
  }
  set<T>(ref: DocumentReference<T>, data: Partial<T> | T, options?: SetOptions): Promise<WriteResult> {
    return this.run(ref, () => ref.set(data, options));
  }
  update(ref: DocumentReference<any>, ...args: unknown[]): Promise<WriteResult> {
    return this.run(ref, () => ref.update(...args));
  }
  delete(ref: DocumentReference<any>, pre?: Precondition): Promise<WriteResult> {
    return this.run(ref, () => ref.delete(pre));
  }
  onWriteError(cb: (e: BulkWriterError) => boolean): void {
    this.retry = cb;
  }
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
  close(): Promise<void> {
    return this.flush();
  }
}

const STATUS: Record<number, string> = { 1: 'CANCELLED', 2: 'UNKNOWN', 3: 'INVALID_ARGUMENT', 4: 'DEADLINE_EXCEEDED', 5: 'NOT_FOUND', 6: 'ALREADY_EXISTS', 7: 'PERMISSION_DENIED', 8: 'RESOURCE_EXHAUSTED', 9: 'FAILED_PRECONDITION', 10: 'ABORTED', 11: 'OUT_OF_RANGE', 12: 'UNIMPLEMENTED', 13: 'INTERNAL', 14: 'UNAVAILABLE', 15: 'DATA_LOSS', 16: 'UNAUTHENTICATED' };
const CODES: Record<string, number> = { cancelled: 1, unknown: 2, 'invalid-argument': 3, 'deadline-exceeded': 4, 'not-found': 5, 'already-exists': 6, 'permission-denied': 7, 'resource-exhausted': 8, 'failed-precondition': 9, aborted: 10, 'out-of-range': 11, unimplemented: 12, internal: 13, unavailable: 14, 'data-loss': 15, unauthenticated: 16 };
const codeOf = (c: string | undefined) => CODES[c ?? ''] ?? 2;

const instances = new WeakMap<IceBaseApp, Map<string, Firestore>>();

/**
 * firebase-admin's getFirestore(app), over IceBase (one per app and options).
 * { validate: false, checkQueryValues: false } is a raw handle: writes skip the schema (seeding
 * legacy-shaped data in a migration test, say); indexes are still checked.
 */
export function getFirestore(app: IceBaseApp, opts: CompatOptions = {}): Firestore {
  let byOpts = instances.get(app);
  if (!byOpts) instances.set(app, (byOpts = new Map()));
  const key = `${opts.validate ?? true}|${opts.checkQueryValues ?? true}|${opts.learn ? 'learn' : ''}`;
  let db = byOpts.get(key);
  if (!db) byOpts.set(key, (db = new Firestore(app, opts)));
  return db;
}

/** @internal a driver document as a firebase-admin-shaped snapshot (trigger events). */
export function snapshotFromRaw(db: Firestore, raw: RawDoc): DocumentSnapshot {
  return new QueryDocumentSnapshot(new DocumentReference(db, raw.path), raw.data ? (fromDriver(db, raw.data) as DocumentData) : undefined, raw) as DocumentSnapshot;
}
