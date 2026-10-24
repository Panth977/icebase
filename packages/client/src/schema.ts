// icebase/schema — explicit schema + explicit composite indexes. The only place data shape is
// declared. The types drive autocomplete and the compile-time index check (icebase/firestore);
// the runtime half validates every write before it leaves, in every mode.

import { IceBaseError } from './errors.ts';
import { FieldValue, GeoPoint, Timestamp, isPlainObject } from './values.ts';

export { Timestamp, GeoPoint } from './values.ts';

import type { DocumentReference } from './firestore.ts';
export type { DocumentReference } from './firestore.ts';

// ─── field definitions ─────────────────────────────────────────────────────────

export type FieldDef =
  | { kind: 'string'; min?: number; max?: number }
  | { kind: 'number'; int?: boolean; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'timestamp' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'array'; of: Field<unknown>; max?: number }
  | { kind: 'map'; fields: FieldMap; rest?: Field<unknown> }
  | { kind: 'ref'; to: AnyCollection }
  | { kind: 'geopoint' }
  /** A map whose keys are data (ids → values): every value has the same type. */
  | { kind: 'record'; of: Field<unknown> }
  /** One of several types (the first that fits). */
  | { kind: 'union'; of: readonly Field<unknown>[] }
  /** Exactly this value. */
  | { kind: 'literal'; value: string | number | boolean | null }
  /** Any value Firestore can store (no check). */
  | { kind: 'any' };

export interface Field<T> {
  readonly kind: FieldDef['kind'];
  readonly optional: boolean;
  /** null is a legal value (f.nullable). */
  readonly nullable?: boolean;
  /** @internal the runtime definition */
  readonly def: FieldDef;
  readonly __t?: T;
}

export type FieldMap = Record<string, Field<any>>;
type Req<S extends FieldMap> = { [K in keyof S as S[K] extends Field<infer T> ? (undefined extends T ? never : K) : never]: S[K] extends Field<infer T> ? T : never };
type Opt<S extends FieldMap> = { [K in keyof S as S[K] extends Field<infer T> ? (undefined extends T ? K : never) : never]?: S[K] extends Field<infer T> ? Exclude<T, undefined> : never };
type Flat<T> = { [K in keyof T]: T[K] } & {};
/** The TypeScript type of a document, inferred from its field map. */
export type Infer<S extends FieldMap> = Flat<Req<S> & Opt<S>>;

const field = <T>(def: FieldDef, optional = false, nullable = false): Field<T> => ({ kind: def.kind, optional, ...(nullable ? { nullable } : {}), def });

export const f = {
  string: (opts: { min?: number; max?: number } = {}): Field<string> => field({ kind: 'string', ...opts }),
  number: (opts: { int?: boolean; min?: number; max?: number } = {}): Field<number> => field({ kind: 'number', ...opts }),
  boolean: (): Field<boolean> => field({ kind: 'boolean' }),
  timestamp: (): Field<Timestamp> => field({ kind: 'timestamp' }),
  enum: <const E extends readonly string[]>(values: E): Field<E[number]> => {
    if (values.length === 0) throw new IceBaseError('invalid-argument', 'f.enum([]) needs at least one value', { reason: 'schema' });
    return field({ kind: 'enum', values });
  },
  array: <T>(of: Field<T>, opts: { max?: number } = {}): Field<T[]> => {
    if (of.optional) throw new IceBaseError('invalid-argument', 'f.array(f.optional(…)): array elements cannot be optional', { reason: 'schema' });
    return field({ kind: 'array', of, ...opts });
  },
  /** A map of known keys; `rest` types any other key (an open map). */
  map: <S extends FieldMap>(fields: S, opts: { rest?: Field<unknown> } = {}): Field<Infer<S>> => field({ kind: 'map', fields, ...(opts.rest ? { rest: { ...opts.rest, optional: true } } : {}) }),
  ref: <C extends AnyCollection>(to: C): Field<DocumentReference<DocOf<C>>> => field({ kind: 'ref', to }),
  geopoint: (): Field<{ latitude: number; longitude: number }> => field({ kind: 'geopoint' }),
  optional: <T>(inner: Field<T>): Field<T | undefined> => field(inner.def, true, !!inner.nullable),
  /** null is a legal value too. */
  nullable: <T>(inner: Field<T>): Field<T | null> => field(inner.def, inner.optional, true),
  /** A map keyed by data (ids → values), e.g. f.record(f.number()) for { u1: 3, u2: 5 }. */
  record: <T>(of: Field<T>): Field<Record<string, T>> => {
    if (of.optional) throw new IceBaseError('invalid-argument', 'f.record(f.optional(…)): record values cannot be optional', { reason: 'schema' });
    return field({ kind: 'record', of });
  },
  union: <const U extends readonly Field<any>[]>(...of: U): Field<U[number] extends Field<infer T> ? T : never> => {
    if (of.length < 2) throw new IceBaseError('invalid-argument', 'f.union(…) needs at least two types', { reason: 'schema' });
    return field({ kind: 'union', of });
  },
  literal: <const V extends string | number | boolean | null>(value: V): Field<V> => field({ kind: 'literal', value }),
  /** Any storable value, unchecked: for free-form JSON. */
  any: <T = unknown>(): Field<T> => field({ kind: 'any' }),
};

// ─── field paths ───────────────────────────────────────────────────────────────
//
// A field is named by a top-level key (a plain string: dots are just characters in it) or by
// the path of keys into nested maps (an array). IceBase never splits a string on dots.

/** A field reference: a top-level key, or the keys into nested maps. */
export type FieldRef = string | readonly string[];

/** 'a' → ['a'];  ['a', 'b'] → ['a', 'b']. */
export const pathOf = (f: FieldRef): string[] => (typeof f === 'string' ? [f] : [...f]);
/** A stable key for a path (for maps and sets). */
export const pathKey = (p: readonly string[]): string => JSON.stringify(p);
/** How a path is written back to a person: 'a' or ['a', 'b']. */
export const showPath = (p: readonly string[]): string => (p.length === 1 ? `'${p[0]}'` : `[${p.map((s) => `'${s}'`).join(', ')}]`);

type Leaf = string | number | boolean | null | undefined | Timestamp | GeoPoint | DocumentReference<any> | readonly unknown[] | Uint8Array;
/** Every path into a document type, as key tuples: ['name'] | ['address'] | ['address', 'city'] … (4 levels). */
export type PathOf<T, D extends unknown[] = []> = D['length'] extends 4
  ? never
  : T extends Leaf
    ? never
    : T extends object
      ? { [K in keyof T & string]-?: [K] | (NonNullable<T[K]> extends Leaf ? never : [K, ...PathOf<NonNullable<T[K]>, [...D, 0]>]) }[keyof T & string]
      : never;
/** The value at a path. */
export type ValueAt<T, P> = P extends readonly [infer H, ...infer R] ? (H extends keyof NonNullable<T> ? (R extends [] ? NonNullable<T>[H] : ValueAt<NonNullable<T>[H], R>) : never) : never;
/** A path as one string, for the type-level index check: ['address', 'city'] → 'address/city'. */
export type JoinPath<P> = P extends readonly [infer H extends string] ? H : P extends readonly [infer H extends string, ...infer R] ? `${H}/${JoinPath<R>}` : never;
/** Every field of a document type as a key: 'name' | 'address' | 'address/city' … */
export type FieldKeys<T> = JoinPath<PathOf<T>>;

// ─── indexes ───────────────────────────────────────────────────────────────────
//
// Every index a query uses is declared — single-field ones too. A query whose index is not
// declared does not compile, is refused at runtime in every mode, and the emulator builds a
// SQLite index for exactly the declared ones and nothing else.

export type IndexMode = 'asc' | 'desc' | 'contains';
export interface IndexField {
  readonly path: readonly string[];
  readonly mode: IndexMode;
}
/** One entry of index(…): a field (ascending), or asc() / desc() / contains() of one. */
export interface IndexPart<K extends string> {
  readonly path: readonly string[];
  readonly mode: IndexMode;
  readonly __k?: K;
}
type PartKey<E> = E extends string ? E : E extends readonly string[] ? JoinPath<E> : E extends IndexPart<infer K> ? K : never;
type PartArg = string | readonly string[] | IndexPart<string>;

const part = (f: FieldRef, mode: IndexMode) => ({ path: pathOf(f), mode });
export const asc = <const F extends FieldRef>(f: F): IndexPart<PartKey<F>> => part(f, 'asc');
export const desc = <const F extends FieldRef>(f: F): IndexPart<PartKey<F>> => part(f, 'desc');
/** The array field of an array-contains query, in a composite index. */
export const contains = <const F extends FieldRef>(f: F): IndexPart<PartKey<F>> => part(f, 'contains');

/** One declared index (the type is the set of fields it covers). */
export interface IndexSpec<K extends string> {
  readonly kind: 'index';
  readonly fields: readonly IndexField[];
  readonly __k?: K;
}
/** For the type-level check: a declared index over the fields F. */
export interface IndexDecl<F extends string> {
  readonly f: F;
}

/**
 * index('stock') — a single-field index (serves ==, ranges and orderBy either way, and
 * array-contains on an array field). index('category', desc('priceCents')) — a composite
 * index, fields in order. Nested fields are key arrays: index(['address', 'city']).
 */
export function index<const E extends readonly PartArg[]>(...entries: E): IndexSpec<PartKey<E[number]>> {
  if (entries.length === 0) throw new IceBaseError('invalid-argument', 'index(): name at least one field', { reason: 'schema' });
  return { kind: 'index', fields: entries.map((e) => (typeof e === 'string' || Array.isArray(e) ? part(e as FieldRef, 'asc') : { path: [...(e as IndexPart<string>).path], mode: (e as IndexPart<string>).mode })) };
}
type IndexSetOf<I> = I extends readonly (infer X)[] ? (X extends IndexSpec<infer K> ? IndexDecl<K> : never) : never;
export type ParsedIndex = IndexSpec<string>;

/** The schema definition of the field at a path (through nested maps), or undefined. */
export function fieldAt(fields: FieldMap, path: readonly string[], rest?: Field<unknown>): Field<unknown> | undefined {
  let def: Field<unknown> | undefined = { kind: 'map', optional: false, def: { kind: 'map', fields, ...(rest ? { rest } : {}) } };
  for (const key of path) {
    def = childField(def, key);
    if (!def) return undefined;
  }
  return def;
}

const ANY: Field<unknown> = { kind: 'any', optional: true, def: { kind: 'any' } };

/** The field under one key of a map-like field (map, record, any, or a union containing one). */
function childField(parent: Field<unknown>, key: string): Field<unknown> | undefined {
  const d = parent.def;
  if (d.kind === 'map') return d.fields[key] ?? d.rest;
  if (d.kind === 'record') return { ...d.of, optional: true };
  if (d.kind === 'any') return ANY;
  if (d.kind === 'union') {
    const kids = d.of.map((u) => childField(u, key)).filter((x): x is Field<unknown> => !!x);
    if (kids.length === 0) return undefined;
    if (kids.length === 1) return { ...kids[0]!, optional: true };
    return { kind: 'union', optional: true, def: { kind: 'union', of: kids } };
  }
  return undefined;
}

export interface Collection<P extends string, T, IX> {
  readonly kind: 'collection';
  readonly path: P;
  /** The collection id: the last path segment ('users/{uid}/orders' → 'orders'). */
  readonly id: string;
  /** Path parameter names, in order ('users/{uid}/orders' → ['uid']). */
  readonly params: readonly string[];
  readonly fields: FieldMap;
  /** Any other top-level key (an open document). */
  readonly rest?: Field<unknown>;
  /** Every declared index: single-field and composite. */
  readonly indexes: readonly ParsedIndex[];
  readonly ttl?: string;
  /** Queried with collectionGroup(): its indexes are also declared with collection-group scope. */
  readonly group: boolean;
  /** The path ends in {name=**}: that collection and every collection below it (data whose shape users define). */
  readonly glob?: boolean;
  /**
   * Single-field queries need no declaration (like Firestore's automatic indexes) — only for
   * collections whose fields users define (a glob). Composite indexes are still declared.
   */
  readonly autoIndex?: boolean;
  readonly __doc?: T;
  /** Union of declared indexes, e.g. IndexDecl<'stock'> | IndexDecl<'category' | 'priceCents'> */
  readonly __ix?: IX;
}
export type AnyCollection = Collection<string, any, any>;
export type DocOf<C> = C extends Collection<string, infer T, any> ? T : never;
export type IndexesOf<C> = C extends Collection<string, any, infer IX> ? IX : never;

const SEGMENT = /^[^/{}]+$/;
const PARAM = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const GLOB = /^\{([A-Za-z_][A-Za-z0-9_]*)=\*\*\}$/;

/** Parse a collection path template: 'users/{uid}/orders' → ['users', '{uid}', 'orders']. */
function parsePath(path: string): { segments: string[]; params: string[]; glob: boolean } {
  const segments = path.split('/');
  const params: string[] = [];
  const last = segments[segments.length - 1]!;
  if (GLOB.test(last)) {
    // 'artifacts/{a}/db/{path=**}': every collection below artifacts/{a}/db (any depth).
    const head = segments.slice(0, -1);
    if (head.length % 2 !== 1) throw new IceBaseError('invalid-argument', `collection('${path}'): {${GLOB.exec(last)![1]}=**} follows a collection id (collection/{doc}/…/data/{rest=**} — every collection below data's documents)`, { reason: 'schema' });
    const p = parsePath(head.join('/'));
    return { segments, params: p.params, glob: true };
  }
  if (segments.some((x) => GLOB.test(x))) throw new IceBaseError('invalid-argument', `collection('${path}'): {name=**} can only be the last segment`, { reason: 'schema' });
  if (segments.length % 2 === 0) throw new IceBaseError('invalid-argument', `collection('${path}'): a collection path has an odd number of segments (collection/{doc}/collection…)`, { reason: 'schema' });
  segments.forEach((s, i) => {
    const m = PARAM.exec(s);
    if (i % 2 === 1) {
      if (!m) throw new IceBaseError('invalid-argument', `collection('${path}'): segment ${i + 1} ('${s}') must be a {param}, e.g. 'users/{uid}/orders'`, { reason: 'schema' });
      if (params.includes(m[1]!)) throw new IceBaseError('invalid-argument', `collection('${path}'): {${m[1]}} is used twice`, { reason: 'schema' });
      params.push(m[1]!);
    } else if (!SEGMENT.test(s) || s === '.' || s === '..' || /^__.*__$/.test(s)) {
      throw new IceBaseError('invalid-argument', `collection('${path}'): '${s}' is not a valid collection id`, { reason: 'schema' });
    }
  });
  return { segments, params, glob: false };
}

function checkIndex(path: string, fields: FieldMap, ix: ParsedIndex, rest?: Field<unknown>): ParsedIndex {
  if (!ix || ix.kind !== 'index') throw new IceBaseError('invalid-argument', `collection('${path}'): indexes are index(…) declarations, e.g. index('stock') or index('category', desc('priceCents'))`, { reason: 'schema' });
  for (const f of ix.fields) {
    const def = fieldAt(fields, f.path, rest);
    if (!def) throw new IceBaseError('invalid-argument', `collection('${path}'): index field ${showPath(f.path)} is not in the schema`, { reason: 'schema' });
    if (f.mode === 'contains' && def.def.kind !== 'array') throw new IceBaseError('invalid-argument', `collection('${path}'): contains(${showPath(f.path)}) needs an array field, it is ${def.def.kind}`, { reason: 'schema' });
  }
  const keys = ix.fields.map((f) => pathKey(f.path));
  const dup = ix.fields.find((_f, i) => keys.indexOf(keys[i]!) !== i);
  if (dup) throw new IceBaseError('invalid-argument', `collection('${path}'): an index names ${showPath(dup.path)} twice`, { reason: 'schema' });
  if (ix.fields.filter((x) => x.mode === 'contains').length > 1) throw new IceBaseError('invalid-argument', `collection('${path}'): an index may have at most one contains() field`, { reason: 'schema' });
  return ix;
}

/** Declare a collection. `path` may contain {params} for subcollections: 'users/{uid}/orders'.
 * `indexes` declares every index queries may use — single-field and composite — and nothing
 * else is indexed. Every index field must be in the schema: a typo is a compile error. */
export function collection<const P extends string, S extends FieldMap, const I extends readonly IndexSpec<FieldKeys<Infer<S>>>[]>(
  path: P,
  def: {
    fields: S;
    indexes: I;
    ttl?: keyof S & string;
    group?: boolean;
    /** Types any other top-level key: an open document (e.g. f.any()). */
    rest?: Field<unknown>;
    /** Single-field queries need no declaration (only with a {name=**} path: data whose fields users define). */
    autoIndex?: boolean;
  },
): Collection<P, Infer<S>, IndexSetOf<I>> {
  const { segments, params, glob } = parsePath(path);
  if (def.autoIndex && !glob) throw new IceBaseError('invalid-argument', `collection('${path}'): autoIndex is only for {name=**} collections (data whose fields users define); declare this collection's indexes`, { reason: 'schema' });
  for (const name of Object.keys(def.fields)) {
    // Any key Firestore accepts, except reserved __x__ names and characters that break JSON paths.
    if (!name || /^__.*__$/.test(name) || /["\u0000-\u001f]/.test(name)) throw new IceBaseError('invalid-argument', `collection('${path}'): '${name}' is not a usable field name`, { reason: 'schema' });
  }
  if (def.ttl !== undefined) {
    const t = def.fields[def.ttl];
    if (!t || t.def.kind !== 'timestamp') throw new IceBaseError('invalid-argument', `collection('${path}'): ttl field '${String(def.ttl)}' must be a timestamp field`, { reason: 'schema' });
  }
  const rest = def.rest ? { ...def.rest, optional: true } : undefined;
  const indexes = def.indexes.map((ix) => checkIndex(path, def.fields, ix, rest));
  return {
    kind: 'collection',
    path,
    id: glob ? '*' : segments[segments.length - 1]!,
    params,
    fields: def.fields,
    ...(rest ? { rest } : {}),
    ...(glob ? { glob: true } : {}),
    ...(def.autoIndex ? { autoIndex: true } : {}),
    indexes,
    ...(def.ttl !== undefined ? { ttl: def.ttl } : {}),
    group: def.group ?? false,
  } as Collection<P, Infer<S>, IndexSetOf<I>>;
}

// ─── Realtime Database paths ───────────────────────────────────────────────────

/** A Realtime Database location: 'rooms/{roomId}/messages/{msgId}' holding one value type. */
export interface DbPath<P extends string, T, IX extends string> {
  readonly kind: 'dbPath';
  readonly path: P;
  readonly params: readonly string[];
  readonly value: Field<T>;
  /** Children this path's items are queried by (orderByChild); becomes .indexOn in database.rules.json. */
  readonly indexOn: readonly IX[];
  readonly __t?: T;
}
export type AnyDbPath = DbPath<string, any, string>;
export type DbValueOf<D> = D extends DbPath<string, infer T, any> ? T : never;

const DB_FIELD_KINDS = new Set<FieldDef['kind']>(['string', 'number', 'boolean', 'enum', 'array', 'map']);
function dbKinds(f: Field<unknown>, where: string): void {
  if (!DB_FIELD_KINDS.has(f.def.kind)) throw new IceBaseError('invalid-argument', `dbPath ${where}: f.${f.def.kind}() is not a Realtime Database type (use f.number() for milliseconds, a string for references)`, { reason: 'schema' });
  if (f.def.kind === 'map') for (const [k, x] of Object.entries(f.def.fields)) dbKinds(x, `${where}.${k}`);
  if (f.def.kind === 'array') dbKinds(f.def.of, `${where}[]`);
}

/** Declare a Realtime Database path. `indexOn` names the children that orderByChild() may use (IDX-6). */
export function dbPath<const P extends string, T, const IX extends string = never>(
  path: P,
  value: Field<T>,
  opts: { indexOn?: readonly (IX & (T extends Record<string, unknown> ? keyof T & string : never))[] } = {},
): DbPath<P, T, IX> {
  const segs = path.split('/');
  const params: string[] = [];
  for (const s of segs) {
    const m = PARAM.exec(s);
    if (m) {
      if (params.includes(m[1]!)) throw new IceBaseError('invalid-argument', `dbPath('${path}'): {${m[1]}} is used twice`, { reason: 'schema' });
      params.push(m[1]!);
    } else if (!s || /[.#$[\]]/.test(s)) {
      throw new IceBaseError('invalid-argument', `dbPath('${path}'): '${s}' is not a valid key (no empty segments, '.', '#', '$', '[' or ']')`, { reason: 'schema' });
    }
  }
  dbKinds(value, `'${path}'`);
  for (const ix of opts.indexOn ?? []) {
    if (value.def.kind !== 'map' || !value.def.fields[ix]) throw new IceBaseError('invalid-argument', `dbPath('${path}'): indexOn '${ix}' is not a child of the value`, { reason: 'schema' });
  }
  return { kind: 'dbPath', path, params, value, indexOn: (opts.indexOn ?? []) as readonly IX[] };
}

/** Validate one value against a field — used by the Realtime Database, where a location holds any field. */
export function validateValue(def: Field<unknown>, value: unknown, where: string): unknown {
  const ctx: Ctx = { issues: [], kind: 'set', write: true, bounds: true };
  const out = checkF(def, value, where, ctx, false);
  if (ctx.issues.length) {
    const lines = ctx.issues.slice(0, 10).map((i) => `  ${i.path}: expected ${i.expected}, got ${i.got}`);
    throw new IceBaseError('invalid-argument', `write to '${where}' does not match the schema:\n${lines.join('\n')}`, { reason: 'schema', issues: ctx.issues });
  }
  return out;
}

// ─── Cloud Storage paths ───────────────────────────────────────────────────────

/** Where files may go, and what they may be: checked before upload (all modes) and usable in storage.rules. */
export interface FilePath<P extends string> {
  readonly kind: 'filePath';
  readonly path: P;
  readonly params: readonly string[];
  /** e.g. ['image/*', 'application/pdf']. Empty = anything. */
  readonly contentTypes: readonly string[];
  readonly maxBytes?: number;
}
export type AnyFilePath = FilePath<string>;

export function filePath<const P extends string>(path: P, opts: { contentTypes?: readonly string[]; maxMb?: number } = {}): FilePath<P> {
  const params: string[] = [];
  for (const s of path.split('/')) {
    const m = PARAM.exec(s);
    if (m) params.push(m[1]!);
    else if (!s) throw new IceBaseError('invalid-argument', `filePath('${path}'): empty segment`, { reason: 'schema' });
  }
  return { kind: 'filePath', path, params, contentTypes: opts.contentTypes ?? [], ...(opts.maxMb !== undefined ? { maxBytes: Math.floor(opts.maxMb * 1024 * 1024) } : {}) };
}

/** The declared file path a concrete object path falls under, or null. */
export function matchFilePath(files: Record<string, AnyFilePath>, path: string): AnyFilePath | null {
  const segs = path.split('/');
  for (const fp of Object.values(files)) {
    const tpl = fp.path.split('/');
    if (tpl.length === segs.length && tpl.every((s, i) => PARAM.test(s) || s === segs[i])) return fp;
  }
  return null;
}

export interface Schema<C extends Record<string, AnyCollection>, D extends Record<string, AnyDbPath> = {}, Fs extends Record<string, AnyFilePath> = {}> {
  readonly collections: C;
  /** Realtime Database paths. */
  readonly paths: D;
  /** Cloud Storage paths. */
  readonly files: Fs;
}

export function defineSchema<const C extends Record<string, AnyCollection>, const D extends Record<string, AnyDbPath> = {}, const Fs extends Record<string, AnyFilePath> = {}>(
  collections: C,
  more: { paths?: D; files?: Fs } = {},
): Schema<C, D, Fs> {
  for (const [key, c] of Object.entries(collections)) {
    // Collections may share an id (Firestore keys indexes by id: they are merged when deployed,
    // and a collectionGroup(id) query reads every group: true collection with that id).
    if (!c || c.kind !== 'collection') throw new IceBaseError('invalid-argument', `defineSchema: '${key}' is not a collection(…)`, { reason: 'schema' });
  }
  for (const [key, p] of Object.entries(more.paths ?? {})) {
    if (!p || p.kind !== 'dbPath') throw new IceBaseError('invalid-argument', `defineSchema: paths.${key} is not a dbPath(…)`, { reason: 'schema' });
  }
  for (const [key, p] of Object.entries(more.files ?? {})) {
    if (!p || p.kind !== 'filePath') throw new IceBaseError('invalid-argument', `defineSchema: files.${key} is not a filePath(…)`, { reason: 'schema' });
  }
  return { collections, paths: (more.paths ?? {}) as D, files: (more.files ?? {}) as Fs };
}

/** Find the schema collection a concrete path ('users/u1/orders') belongs to. */
export function matchCollectionPath(schema: Schema<Record<string, AnyCollection>, any, any>, path: string): { collection: AnyCollection; params: Record<string, string> } | null {
  const segs = path.split('/');
  const all = Object.values(schema.collections);
  // Exact templates first, then {rest=**} ones (the longest prefix wins).
  const ordered = [...all.filter((c) => !c.glob), ...all.filter((c) => c.glob).sort((a, b) => b.path.length - a.path.length)];
  for (const c of ordered) {
    const tpl = c.glob ? c.path.split('/').slice(0, -1) : c.path.split('/');
    if (c.glob ? segs.length < tpl.length || segs.length % 2 === 0 : tpl.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < tpl.length; i++) {
      const m = PARAM.exec(tpl[i]!);
      if (m) params[m[1]!] = segs[i]!;
      else if (tpl[i] !== segs[i]) ok = false;
    }
    if (ok) return { collection: c, params };
  }
  return null;
}

/** 'users/{uid}/orders' + ['u1'] → 'users/u1/orders'. */
export function fillPath(c: AnyCollection, params: readonly string[]): string {
  if (params.length !== c.params.length) {
    throw new IceBaseError('invalid-argument', `collection '${c.path}' needs ${c.params.length} path parameter(s) (${c.params.map((p) => `{${p}}`).join(', ') || 'none'}), got ${params.length}`, { reason: 'schema' });
  }
  let i = 0;
  return c.path
    .split('/')
    .map((s) => {
      if (!PARAM.test(s)) return s;
      const v = params[i++]!;
      if (typeof v !== 'string' || v === '' || v.includes('/')) throw new IceBaseError('invalid-argument', `collection '${c.path}': path parameter ${s} must be a non-empty string without '/', got ${JSON.stringify(v)}`, { reason: 'schema' });
      return v;
    })
    .join('/');
}

// ─── runtime validation ────────────────────────────────────────────────────────

/** How a write is applied, which decides what must be present. */
export type WriteKind = 'create' | 'set' | 'merge' | 'update';

export interface Issue {
  readonly path: string;
  readonly expected: string;
  readonly got: string;
}

const describe = (v: unknown): string => {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (v instanceof Timestamp) return 'Timestamp';
  if (v instanceof GeoPoint) return 'GeoPoint';
  if (v instanceof FieldValue) return `${v.op}()`;
  if (v instanceof Date) return 'Date';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object' && (v as { type?: unknown }).type === 'document') return `reference ${(v as { path: string }).path}`;
  if (typeof v === 'string') return `"${v.length > 40 ? `${v.slice(0, 40)}…` : v}"`;
  if (typeof v === 'object') return 'object';
  return `${typeof v} ${String(v)}`;
};

const expectedOf = (d: FieldDef): string => {
  switch (d.kind) {
    case 'string':
      return `string${d.min !== undefined || d.max !== undefined ? ` (length ${d.min ?? 0}..${d.max ?? '∞'})` : ''}`;
    case 'number':
      return `${d.int ? 'integer' : 'number'}${d.min !== undefined || d.max !== undefined ? ` (${d.min ?? '-∞'}..${d.max ?? '∞'})` : ''}`;
    case 'enum':
      return d.values.map((v) => JSON.stringify(v)).join(' | ');
    case 'array':
      return `array of ${expectedOf(d.of.def)}${d.max !== undefined ? ` (max ${d.max})` : ''}`;
    case 'map':
      return 'map';
    case 'ref':
      return `reference to ${d.to.path}`;
    case 'record':
      return `map of ${expectedOf(d.of.def)}`;
    case 'union':
      return d.of.map((u) => expectedOf(u.def) + (u.nullable ? ' | null' : '')).join(' | ');
    case 'literal':
      return JSON.stringify(d.value);
    default:
      return d.kind;
  }
};

function refMatches(target: AnyCollection, path: string): boolean {
  const segs = path.split('/');
  const tpl = target.path.split('/');
  if (segs.length !== tpl.length + 1) return false;
  return tpl.every((s, i) => PARAM.test(s) || s === segs[i]);
}

interface Ctx {
  issues: Issue[];
  kind: WriteKind;
  /** Sentinels are legal in writes only. */
  write: boolean;
  /** Length / range / size limits apply to stored values, not to query operands. */
  bounds: boolean;
}

/** check() for a Field: null passes when the field is nullable (or any). */
function checkF(field: Field<unknown>, v: unknown, path: string, ctx: Ctx, partial: boolean): unknown {
  if (v === null && (field.nullable || field.def.kind === 'any')) return null;
  return check(field.def, v, path, ctx, partial);
}

/** Validate one value against a field. Returns the value normalised for drivers (Date → Timestamp, {lat,lng} → GeoPoint). */
function check(def: FieldDef, v: unknown, path: string, ctx: Ctx, partial: boolean): unknown {
  const bad = (expected = expectedOf(def)) => {
    ctx.issues.push({ path, expected, got: describe(v) });
    return v;
  };
  if (v instanceof FieldValue) {
    if (!ctx.write) return bad();
    if (def.kind === 'any' && v.op !== 'delete') return v;
    if (def.kind === 'union' && v.op !== 'delete') {
      for (const alt of def.of) {
        const sub: Ctx = { ...ctx, issues: [] };
        check(alt.def, v, path, sub, partial);
        if (sub.issues.length === 0) return v;
      }
      return bad();
    }
    switch (v.op) {
      case 'serverTimestamp':
        return def.kind === 'timestamp' ? v : bad(`${expectedOf(def)} (serverTimestamp() only fits timestamp fields)`);
      case 'serverTime':
        return def.kind === 'number' ? v : bad(`${expectedOf(def)} (the Realtime Database's serverTimestamp() is milliseconds: it fits number fields)`);
      case 'increment':
        if (def.kind !== 'number') return bad(`${expectedOf(def)} (increment() only fits number fields)`);
        if (def.int && !Number.isInteger(v.operand)) return bad('increment() by an integer (the field is an integer)');
        return v;
      case 'arrayUnion':
      case 'arrayRemove':
        if (def.kind !== 'array') return bad(`${expectedOf(def)} (${v.op}() only fits array fields)`);
        (v.operand as unknown[]).forEach((e, i) => checkF(def.of, e, `${path}[${i}]`, ctx, false));
        return v;
      case 'delete':
        return bad('a value (deleteField() is only allowed on optional fields, with updateDoc or setDoc merge)');
    }
  }
  switch (def.kind) {
    case 'any':
      return v;
    case 'literal':
      return v === def.value ? v : bad();
    case 'union': {
      for (const alt of def.of) {
        const sub: Ctx = { ...ctx, issues: [] };
        const out = checkF(alt, v, path, sub, partial);
        if (sub.issues.length === 0) return out;
      }
      return bad();
    }
    case 'record': {
      if (!isPlainObject(v)) return bad();
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue;
        if (x instanceof FieldValue && x.op === 'delete' && ctx.write && (ctx.kind === 'update' || ctx.kind === 'merge')) {
          out[k] = x;
          continue;
        }
        out[k] = checkF(def.of, x, `${path}.${k}`, ctx, false);
      }
      return out;
    }
    case 'string':
      if (typeof v !== 'string') return bad();
      if (ctx.bounds && ((def.min !== undefined && v.length < def.min) || (def.max !== undefined && v.length > def.max))) return bad();
      return v;
    case 'number':
      if (typeof v !== 'number' || Number.isNaN(v)) return bad();
      if (def.int && !Number.isInteger(v)) return bad();
      if (ctx.bounds && ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max))) return bad();
      return v;
    case 'boolean':
      return typeof v === 'boolean' ? v : bad();
    case 'timestamp':
      if (v instanceof Timestamp) return v;
      if (v instanceof Date && !Number.isNaN(v.getTime())) return Timestamp.fromDate(v);
      return bad();
    case 'enum':
      return typeof v === 'string' && def.values.includes(v) ? v : bad();
    case 'geopoint':
      if (v instanceof GeoPoint) return v;
      if (isPlainObject(v) && typeof v.latitude === 'number' && typeof v.longitude === 'number' && Object.keys(v).length === 2) {
        try {
          return new GeoPoint(v.latitude, v.longitude);
        } catch {
          return bad('geopoint (latitude -90..90, longitude -180..180)');
        }
      }
      return bad();
    case 'ref': {
      const r = v as { type?: unknown; path?: unknown } | null;
      if (!r || typeof r !== 'object' || r.type !== 'document' || typeof r.path !== 'string') return bad();
      return refMatches(def.to, r.path) ? v : bad();
    }
    case 'array': {
      if (!Array.isArray(v)) return bad();
      if (ctx.bounds && def.max !== undefined && v.length > def.max) return bad();
      return v.map((e, i) => checkF(def.of, e, `${path}[${i}]`, ctx, false));
    }
    case 'map': {
      if (!isPlainObject(v)) return bad();
      return checkFields(def.fields, v, path, ctx, partial, def.rest);
    }
  }
}

function checkFields(fields: FieldMap, data: Record<string, unknown>, prefix: string, ctx: Ctx, partial: boolean, rest?: Field<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const def = fields[k] ?? rest;
    if (!def) {
      ctx.issues.push({ path, expected: `no such field (fields: ${Object.keys(fields).join(', ') || 'none'})`, got: describe(v) });
      continue;
    }
    if (v === undefined) {
      // Firebase rejects undefined unless ignoreUndefinedProperties is on; treat it as absent.
      if (!def.optional && !partial) ctx.issues.push({ path, expected: expectedOf(def.def), got: 'undefined' });
      continue;
    }
    if (v instanceof FieldValue && v.op === 'delete') {
      if (!ctx.write || !(ctx.kind === 'update' || ctx.kind === 'merge')) ctx.issues.push({ path, expected: expectedOf(def.def), got: 'deleteField() (only with updateDoc or setDoc merge)' });
      else if (!def.optional) ctx.issues.push({ path, expected: `${expectedOf(def.def)} (required: deleteField() would remove it)`, got: 'deleteField()' });
      out[k] = v;
      continue;
    }
    out[k] = checkF(def, v, path, ctx, partial);
  }
  if (!partial) {
    for (const [k, def] of Object.entries(fields)) {
      if (!def.optional && !(k in data && data[k] !== undefined)) ctx.issues.push({ path: prefix ? `${prefix}.${k}` : k, expected: expectedOf(def.def), got: 'missing' });
    }
  }
  return out;
}

function fail(c: AnyCollection, what: string, issues: Issue[]): never {
  const lines = issues.slice(0, 10).map((i) => `  ${i.path}: expected ${i.expected}, got ${i.got}`);
  if (issues.length > 10) lines.push(`  … and ${issues.length - 10} more`);
  throw new IceBaseError('invalid-argument', `${what} on '${c.path}' does not match the schema:\n${lines.join('\n')}`, { reason: 'schema', collection: c.path, issues });
}

/**
 * Validate a write (SCH-1). `create`/`set` need every required field; `merge` checks only what
 * is given. Returns the data normalised for the drivers, or throws invalid-argument naming every
 * bad field.
 */
export function validateWrite(c: AnyCollection, data: unknown, kind: Exclude<WriteKind, 'update'>): Record<string, unknown> {
  const ctx: Ctx = { issues: [], kind, write: true, bounds: true };
  if (!isPlainObject(data)) fail(c, kind, [{ path: '(document)', expected: 'an object', got: describe(data) }]);
  const out = checkFields(c.fields, data, '', ctx, kind === 'merge', c.rest);
  if (ctx.issues.length) fail(c, kind, ctx.issues);
  return out;
}

/** One field of an update: the key path and its new value. */
export type UpdateEntry = readonly [path: readonly string[], value: unknown];

/**
 * Validate an update (updateDoc): each entry sets the field at its key path. Setting a whole map
 * replaces it, so the map must be complete; deleteField() only on optional fields.
 */
export function validateUpdate(c: AnyCollection, entries: readonly UpdateEntry[]): [string[], unknown][] {
  const ctx: Ctx = { issues: [], kind: 'update', write: true, bounds: true };
  const out: [string[], unknown][] = [];
  for (const [path, v] of entries) {
    // Plain for an ordinary key; quoted when a key path or a key with a dot could be misread.
    const shown = path.length === 1 && !path[0]!.includes('.') ? path[0]! : showPath(path);
    const def = path.length ? fieldAt(c.fields, path, c.rest) : undefined;
    if (!def) {
      ctx.issues.push({ path: shown, expected: 'a field in the schema', got: describe(v) });
      continue;
    }
    if (v instanceof FieldValue && v.op === 'delete') {
      if (!def.optional) ctx.issues.push({ path: shown, expected: `${expectedOf(def.def)} (required: deleteField() would remove it)`, got: 'deleteField()' });
      out.push([[...path], v]);
      continue;
    }
    if (v === undefined) {
      ctx.issues.push({ path: shown, expected: expectedOf(def.def), got: 'undefined' });
      continue;
    }
    out.push([[...path], checkF(def, v, shown, ctx, false)]);
  }
  if (ctx.issues.length) fail(c, 'update', ctx.issues);
  return out;
}

/** Check a document read from the database (SCH-2). Never throws: legacy data is returned as is. */
export function readIssues(c: AnyCollection, data: unknown): Issue[] {
  const ctx: Ctx = { issues: [], kind: 'set', write: false, bounds: true };
  if (!isPlainObject(data)) return [{ path: '(document)', expected: 'an object', got: describe(data) }];
  checkFields(c.fields, data, '', ctx, false, c.rest);
  return ctx.issues;
}

/** Validate one query value against a field (used by where()); throws like validateWrite. */
export function validateQueryValue(c: AnyCollection, path: readonly string[], op: string, value: unknown): void {
  if (path.length === 1 && path[0] === '__name__') return;
  const def = fieldAt(c.fields, path, c.rest);
  const field = path.join('.');
  if (!def) {
    throw new IceBaseError('invalid-argument', `where(${showPath(path)}, …) on '${c.path}': ${showPath(path)} is not a field (fields: ${Object.keys(c.fields).join(', ')})`, { reason: 'schema' });
  }
  const ctx: Ctx = { issues: [], kind: 'set', write: false, bounds: false };
  const one = (v: unknown, d: FieldDef, p: string) => check(d, v, p, ctx, false);
  if (value === null && (op === '==' || op === '!=')) return; // null equality is legal in Firestore
  if (op === 'in' || op === 'not-in') {
    if (!Array.isArray(value)) ctx.issues.push({ path: field, expected: `an array for '${op}'`, got: describe(value) });
    else value.forEach((v, i) => one(v, def.def, `${field}[${i}]`));
  } else if (op === 'array-contains' || op === 'array-contains-any') {
    if (def.def.kind === 'any' || def.def.kind === 'union') return;
    if (def.def.kind !== 'array') ctx.issues.push({ path: field, expected: `an array field for '${op}'`, got: def.def.kind });
    else if (op === 'array-contains') one(value, def.def.of.def, field);
    else if (!Array.isArray(value)) ctx.issues.push({ path: field, expected: `an array for '${op}'`, got: describe(value) });
    else value.forEach((v, i) => one(v, (def.def as { of: Field<unknown> }).of.def, `${field}[${i}]`));
  } else {
    one(value, def.def, field);
  }
  if (ctx.issues.length) fail(c, `where(${showPath(path)}, '${op}', …)`, ctx.issues);
}
