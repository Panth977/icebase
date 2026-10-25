// icebase/api — the API's schema, declared like the database's. Every endpoint (a callable or an
// HTTP route) names its input, its output and the errors it may answer, built from the same field
// types — and mostly from the database schema itself (docOf, pick, fieldOf). One declaration gives:
//
//   · runtime validation on both sides (onCall / onRequest on the server, callable() on the client)
//   · types (the input and output types are inferred, nothing is written twice)
//   · generated clients (icebase gen dart) and an OpenAPI document (icebase openapi)
//   · a browsable reference of the database and the API (icebase docs)
//
//   export const api = defineApi({
//     createOrder: endpoint({
//       summary: 'Place an order',
//       input: f.map({ product: f.ref(products), qty: fieldOf(orders, 'qty') }),
//       output: f.map({ id: f.string(), order: docOf(orders) }),
//       errors: { 'not-found': 'The product does not exist' },
//     }),
//     orderStatus: endpoint({ http: { method: 'GET', path: '/orders/{id}' }, input: f.map({ id: f.string() }), output: pick(orders, ['status']) }),
//   });

import { IceBaseError } from './errors.ts';
import { GeoPoint, Timestamp } from './values.ts';
import { f, fieldAt, pathOf, showPath, validateValue, type AnyCollection, type DocOf, type Field, type FieldDef, type FieldMap, type FieldRef } from './schema.ts';

// ─── declaring ─────────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'invalid-argument'
  | 'failed-precondition'
  | 'out-of-range'
  | 'unauthenticated'
  | 'permission-denied'
  | 'not-found'
  | 'already-exists'
  | 'aborted'
  | 'resource-exhausted'
  | 'cancelled'
  | 'unavailable'
  | 'deadline-exceeded'
  | 'unimplemented'
  | 'internal'
  | 'data-loss'
  | 'unknown';

export interface EndpointSpec<I, O> {
  /** One line: what it does. */
  summary?: string;
  /** Longer notes (Markdown). */
  description?: string;
  /** A callable (Firebase's callable protocol) unless `http` is given. */
  http?: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
  input: Field<I>;
  output: Field<O>;
  /** The errors it answers on purpose, and when. */
  errors?: Partial<Record<ErrorCode, string>>;
  /** Who may call it (documentation; the handler enforces it). Default 'signed-in'. */
  auth?: 'none' | 'signed-in' | 'admin';
  /** A group heading in the reference (e.g. 'Orders'). */
  tag?: string;
  /** An example input; the reference shows a generated one otherwise. */
  example?: I;
  deprecated?: boolean;
}

export interface Endpoint<I = unknown, O = unknown> extends EndpointSpec<I, O> {
  readonly kind: 'endpoint';
  /** Its name in the API (set by defineApi). */
  readonly name: string;
  readonly __io?: [I, O];
}
export type AnyEndpoint = Endpoint<any, any>;
export type InputOf<E> = E extends Endpoint<infer I, any> ? I : never;
export type OutputOf<E> = E extends Endpoint<any, infer O> ? O : never;

/** One endpoint. Its name comes from its key in defineApi({ … }). */
export function endpoint<I, O>(spec: EndpointSpec<I, O>): Endpoint<I, O> {
  if (!spec || !spec.input || !spec.output) throw new IceBaseError('invalid-argument', 'endpoint({ input, output }): both are required — declare what goes in and what comes out', { reason: 'schema' });
  if (spec.http) {
    if (!spec.http.path.startsWith('/')) throw new IceBaseError('invalid-argument', `endpoint http.path '${spec.http.path}' must start with '/'`, { reason: 'schema' });
    for (const m of spec.http.path.matchAll(/\{([^}]+)\}/g)) {
      if (spec.input.def.kind !== 'map' || !spec.input.def.fields[m[1]!]) throw new IceBaseError('invalid-argument', `endpoint path parameter {${m[1]}} must be a field of its input`, { reason: 'schema' });
    }
  }
  return { kind: 'endpoint', name: '', auth: 'signed-in', ...spec } as Endpoint<I, O>;
}

export type Api<E extends Record<string, AnyEndpoint> = Record<string, AnyEndpoint>> = { readonly [K in keyof E]: E[K] & { readonly name: K & string } };

/** The whole API: { name: endpoint(…) }. Names must be usable as function names. */
export function defineApi<const E extends Record<string, AnyEndpoint>>(endpoints: E): Api<E> {
  const out: Record<string, AnyEndpoint> = {};
  const routes = new Map<string, string>();
  for (const [name, e] of Object.entries(endpoints)) {
    if (!e || e.kind !== 'endpoint') throw new IceBaseError('invalid-argument', `defineApi: '${name}' is not an endpoint(…)`, { reason: 'schema' });
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new IceBaseError('invalid-argument', `defineApi: '${name}' is not a usable endpoint name (letters, digits, _)`, { reason: 'schema' });
    if (e.http) {
      const key = `${e.http.method} ${e.http.path.replace(/\{[^}]+\}/g, '{}')}`;
      if (routes.has(key)) throw new IceBaseError('invalid-argument', `defineApi: '${name}' and '${routes.get(key)}' both answer ${e.http.method} ${e.http.path}`, { reason: 'schema' });
      routes.set(key, name);
    }
    out[name] = { ...e, name };
  }
  return out as Api<E>;
}

// ─── reusing the database schema ───────────────────────────────────────────────

/** A whole document of a collection, as a field (output of a get, input of a create). */
export function docOf<C extends AnyCollection>(c: C): Field<DocOf<C>> {
  return withRef(f.map(c.fields, c.rest ? { rest: c.rest } : {}), c.path) as Field<DocOf<C>>;
}

/** Some fields of a collection's documents, as they are declared there. */
export function pick<C extends AnyCollection, const K extends keyof DocOf<C> & string>(c: C, keys: readonly K[]): Field<Pick<DocOf<C>, K>> {
  const fields: FieldMap = {};
  for (const k of keys) {
    const def = c.fields[k];
    if (!def) throw new IceBaseError('invalid-argument', `pick(collection('${c.path}'), …): '${k}' is not a field`, { reason: 'schema' });
    fields[k] = def;
  }
  return withRef(f.map(fields), c.path) as Field<Pick<DocOf<C>, K>>;
}

/** Every field optional: a patch of a document. */
export function partial<T>(field: Field<T>): Field<Partial<T>> {
  if (field.def.kind !== 'map') throw new IceBaseError('invalid-argument', 'partial(field) needs a map field', { reason: 'schema' });
  const fields = Object.fromEntries(Object.entries(field.def.fields).map(([k, v]) => [k, v.optional ? v : f.optional(v)]));
  return { ...field, def: { ...field.def, fields } } as Field<Partial<T>>;
}

/** One field of a collection, at a key path: fieldOf(orders, 'qty'), fieldOf(users, ['address', 'city']). */
export function fieldOf<C extends AnyCollection>(c: C, path: FieldRef): Field<any> {
  const def = fieldAt(c.fields, pathOf(path), c.rest);
  if (!def) throw new IceBaseError('invalid-argument', `fieldOf(collection('${c.path}'), ${showPath(pathOf(path))}): no such field`, { reason: 'schema' });
  return { ...def, optional: false };
}

/** A list of something (the output of a query). */
export const listOf = <T>(item: Field<T>): Field<T[]> => f.array(item);

/** Where a field came from in the database schema (the reference links it). Kept on the field
 * itself (not enumerable), so it survives tools that load the config in their own module instance. */
function withRef<T>(field: Field<T>, collectionPath: string): Field<T> {
  Object.defineProperty(field, '__icebaseRef', { value: collectionPath, enumerable: false });
  return field;
}
/** The collection a field was taken from (docOf / pick), if any. */
export const refOf = (field: Field<unknown>): string | undefined => (field as { __icebaseRef?: string }).__icebaseRef;

// ─── the wire ──────────────────────────────────────────────────────────────────
//
// Endpoint values travel as JSON: a timestamp as an ISO string, a reference as its document path,
// a geopoint as { latitude, longitude }, bytes as base64. The declaration says which is which, so
// both ends turn them back into real values (Timestamp, { type: 'document', path }, …).


/** A value → its JSON form, guided by its field. */
export function toWire(field: Field<unknown>, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const d = field.def;
  switch (d.kind) {
    case 'timestamp':
      return v instanceof Timestamp ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v;
    case 'ref':
      return typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string' ? (v as { path: string }).path : v;
    case 'geopoint':
      return v instanceof GeoPoint ? { latitude: v.latitude, longitude: v.longitude } : v;
    case 'array':
      return Array.isArray(v) ? v.map((x) => toWire(d.of, x)) : v;
    case 'record':
      return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toWire(d.of, x)])) : v;
    case 'map':
      return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, d.fields[k] ? toWire(d.fields[k]!, x) : d.rest ? toWire(d.rest, x) : x])) : v;
    case 'union':
      return v;
    default:
      return v instanceof Uint8Array ? b64(v) : v;
  }
}

/** JSON → the value its field declares (the reverse of toWire). Anything unexpected is left for validation to report. */
export function fromWire(field: Field<unknown>, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const d = field.def;
  switch (d.kind) {
    case 'timestamp': {
      if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return Timestamp.fromDate(new Date(v));
      // Firebase's callable encoder sends a Timestamp as { seconds, nanoseconds } (or _seconds).
      const o = v as { seconds?: number; nanoseconds?: number; _seconds?: number; _nanoseconds?: number };
      if (isObj(v) && typeof (o.seconds ?? o._seconds) === 'number') return new Timestamp((o.seconds ?? o._seconds)!, (o.nanoseconds ?? o._nanoseconds ?? 0)!);
      return v;
    }
    case 'ref': {
      const path = typeof v === 'string' ? v : isObj(v) && typeof v.path === 'string' ? v.path : null;
      return path ? { type: 'document', path, id: path.slice(path.lastIndexOf('/') + 1) } : v;
    }
    case 'geopoint':
      return isObj(v) && typeof v.latitude === 'number' && typeof v.longitude === 'number' ? new GeoPoint(v.latitude, v.longitude as number) : v;
    case 'array':
      return Array.isArray(v) ? v.map((x) => fromWire(d.of, x)) : v;
    case 'record':
      return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromWire(d.of, x)])) : v;
    case 'map':
      return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, d.fields[k] ? fromWire(d.fields[k]!, x) : d.rest ? fromWire(d.rest, x) : x])) : v;
    default:
      return v;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

// ─── validating ────────────────────────────────────────────────────────────────

/** Check a call's input against its endpoint; throws invalid-argument naming every bad field. */
export function checkInput<E extends AnyEndpoint>(e: E, data: unknown): InputOf<E> {
  return validateValue(e.input, data, `${e.name || 'endpoint'} input`) as InputOf<E>;
}
/** Check what a handler returns against its endpoint (a bug when it fails: internal). */
export function checkOutput<E extends AnyEndpoint>(e: E, data: unknown): OutputOf<E> {
  try {
    return validateValue(e.output, data, `${e.name || 'endpoint'} output`) as OutputOf<E>;
  } catch (err) {
    throw new IceBaseError('internal', `${e.name}: the handler returned something its declared output does not allow:\n${(err as Error).message}`, { reason: 'schema' });
  }
}

// ─── describing: JSON Schema, samples ──────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;

/**
 * A field as JSON Schema (draft 2020-12), the wire form: timestamps as
 * { "__ib": "ts" } objects are described as date-time strings for HTTP endpoints (they travel as
 * ISO strings there) and references as document paths.
 */
export function toJsonSchema(field: Field<unknown>, opts: { refs?: (collectionPath: string) => string | undefined } = {}): JsonSchema {
  const one = (fd: Field<unknown>): JsonSchema => {
    const ref = refOf(fd);
    const $ref = ref && opts.refs?.(ref);
    if ($ref) return withNull({ $ref }, fd);
    return withNull(def(fd.def), fd);
  };
  const withNull = (s: JsonSchema, fd: Field<unknown>): JsonSchema => (fd.nullable ? { anyOf: [s, { type: 'null' }] } : s);
  const def = (d: FieldDef): JsonSchema => {
    switch (d.kind) {
      case 'string':
        return { type: 'string', ...(d.min !== undefined ? { minLength: d.min } : {}), ...(d.max !== undefined ? { maxLength: d.max } : {}) };
      case 'number':
        return { type: d.int ? 'integer' : 'number', ...(d.min !== undefined ? { minimum: d.min } : {}), ...(d.max !== undefined ? { maximum: d.max } : {}) };
      case 'boolean':
        return { type: 'boolean' };
      case 'timestamp':
        return { type: 'string', format: 'date-time' };
      case 'geopoint':
        return { type: 'object', properties: { latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 } }, required: ['latitude', 'longitude'] };
      case 'enum':
        return { type: 'string', enum: [...d.values] };
      case 'literal':
        return { const: d.value };
      case 'ref':
        return { type: 'string', description: `path of a document in ${d.to.path}`, 'x-icebase-ref': d.to.path };
      case 'array':
        return { type: 'array', items: one(d.of), ...(d.max !== undefined ? { maxItems: d.max } : {}) };
      case 'record':
        return { type: 'object', additionalProperties: one(d.of) };
      case 'union':
        return { anyOf: d.of.map(one) };
      case 'map': {
        const properties = Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, one(v)]));
        const required = Object.entries(d.fields).filter(([, v]) => !v.optional).map(([k]) => k);
        return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: d.rest ? one(d.rest) : false };
      }
      case 'any':
        return {};
    }
  };
  return one(field);
}

/** A plausible example value for a field (the reference shows it; a dry run sends it). */
export function sampleOf(field: Field<unknown>, name = 'value'): unknown {
  const d = field.def;
  if (field.optional && d.kind === 'any') return undefined;
  switch (d.kind) {
    case 'string': {
      const s = /id$/i.test(name) ? 'a1b2c3' : /email/i.test(name) ? 'ann@example.com' : /name/i.test(name) ? 'Ann' : /url/i.test(name) ? 'https://example.com' : name;
      return s.length < (d.min ?? 0) ? s.padEnd(d.min!, 'x') : d.max !== undefined ? s.slice(0, d.max) : s;
    }
    case 'number': {
      const n = d.min !== undefined ? d.min : d.max !== undefined && d.max < 1 ? d.max : 1;
      return d.int ? Math.ceil(n) : n;
    }
    case 'boolean':
      return true;
    case 'timestamp':
      return '2026-01-01T00:00:00.000Z';
    case 'geopoint':
      return { latitude: 0, longitude: 0 };
    case 'enum':
      return d.values[0];
    case 'literal':
      return d.value;
    case 'ref':
      return `${d.to.path.replace(/\{[^}]+\}/g, 'id')}/doc1`;
    case 'array':
      return [sampleOf(d.of, name.replace(/s$/, ''))];
    case 'record':
      return { key1: sampleOf(d.of, name) };
    case 'union':
      return sampleOf(d.of[0]!, name);
    case 'map':
      return Object.fromEntries(Object.entries(d.fields).filter(([, v]) => !v.optional).map(([k, v]) => [k, sampleOf(v, k)]));
    case 'any':
      return null;
  }
}
