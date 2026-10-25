// icebase/functions/v2 — server-side functions, same names as firebase-functions/v2, typed
// from the schema. The same source deploys to Cloud Functions (firebase mode) or runs on the
// IceBase server (emulator mode), which calls the handlers through their `__icebase` record.

import * as fs from 'firebase-functions/v2/firestore';
import * as https from 'firebase-functions/v2/https';
import * as scheduler from 'firebase-functions/v2/scheduler';
import * as storageFns from 'firebase-functions/v2/storage';
import * as databaseFns from 'firebase-functions/v2/database';
import * as tasks from 'firebase-functions/v2/tasks';
import * as identity from 'firebase-functions/v2/identity';
import * as v1auth from 'firebase-functions/v1/auth';
import type { CloudEvent } from 'firebase-functions/v2';
import type { CloudFunction } from 'firebase-functions/v2';
import { adminApps, type IceBaseApp } from '@panth977/icebase/app';
import type { AnyConfig, EnvOf, IceBaseConfig } from '@panth977/icebase/config';
import { IceBaseError } from '@panth977/icebase/errors';
import { DocumentSnapshot, QueryDocumentSnapshot, docFromPath, type Firestore } from '@panth977/icebase/firestore';
import { sendResponse, toRequest } from './internal/node-http.ts';
import { validateValue, type AnyCollection, type DocOf, type Field } from '@panth977/icebase/schema';
import { checkInput, checkOutput, fromWire, toWire, type AnyEndpoint, type Endpoint, type InputOf, type OutputOf } from '@panth977/icebase/api';
import { Buffer } from 'node:buffer';

export { HttpsError } from 'firebase-functions/v2/https';
export type { CallableRequest } from 'firebase-functions/v2/https';
export { setGlobalOptions } from 'firebase-functions/v2';

/** How the IceBase emulator finds and runs a function. */
export type IceBaseFunctionRecord =
  | { kind: 'call'; handler: (req: https.CallableRequest<unknown>) => unknown; input?: Field<unknown>; output?: Field<unknown>; region?: string; endpoint?: AnyEndpoint }
  | { kind: 'request'; handler: (req: Request) => Response | Promise<Response>; express?: ExpressHandler; region?: string; endpoint?: AnyEndpoint }
  | { kind: 'document'; event: 'created' | 'updated' | 'deleted' | 'written'; collection: AnyCollection; handler: (e: unknown) => unknown }
  | { kind: 'document'; event: 'created' | 'updated' | 'deleted' | 'written'; pattern: string; collection?: undefined; handler: (e: unknown) => unknown }
  | { kind: 'schedule'; schedule: string; handler: () => unknown }
  | { kind: 'storage'; event: 'finalized' | 'deleted' | 'metadataUpdated'; bucket?: string; handler: (e: CloudEvent<storageFns.StorageObjectData>) => unknown }
  | { kind: 'database'; event: 'created' | 'updated' | 'deleted' | 'written'; ref: string; handler: (e: unknown) => unknown }
  | { kind: 'task'; handler: (req: tasks.Request<unknown>) => unknown; retry: { maxAttempts: number; minBackoffSeconds: number; maxBackoffSeconds: number }; region?: string }
  | { kind: 'auth'; event: 'beforeCreate' | 'beforeSignIn' | 'created' | 'deleted'; handler: (e: unknown) => unknown };

const tag = <F extends object>(f: F, rec: IceBaseFunctionRecord): F & { __icebase: IceBaseFunctionRecord } => Object.assign(f, { __icebase: rec });

// ─── the app triggers use ──────────────────────────────────────────────────────

let triggerApp: IceBaseApp | null = null;
/** The admin app whose Firestore trigger snapshots belong to. Default: the first initializeAdminApp(). */
export function useAdminApp(app: IceBaseApp): void {
  triggerApp = app;
}
async function triggerDb(): Promise<Firestore> {
  const app = triggerApp ?? adminApps()[0];
  if (!app) throw new IceBaseError('failed-precondition', 'Firestore triggers need an admin app: call initializeAdminApp(config, env) in your functions code (or useAdminApp(app))', { reason: 'config', service: 'functions' });
  const { getAdminFirestore } = await import('./admin.ts');
  return getAdminFirestore(app);
}

// ─── https ─────────────────────────────────────────────────────────────────────

export interface CallableOptions<Req> extends https.CallableOptions {
  /** Validate request.data against this field before the handler runs. */
  input?: Field<Req>;
  /** Validate what the handler returns. */
  output?: Field<unknown>;
}

/** onCall(handler) or onCall({ input, output, …options }, handler). Typed for httpsCallable<typeof fn>(). */
export function onCall<E extends AnyEndpoint>(endpoint: E, handler: (req: https.CallableRequest<InputOf<E>>) => OutputOf<E> | Promise<OutputOf<E>>): https.CallableFunction<InputOf<E>, Promise<OutputOf<E>>> & { __callable?: [InputOf<E>, OutputOf<E>] };
export function onCall<E extends AnyEndpoint>(endpoint: E, opts: https.CallableOptions, handler: (req: https.CallableRequest<InputOf<E>>) => OutputOf<E> | Promise<OutputOf<E>>): https.CallableFunction<InputOf<E>, Promise<OutputOf<E>>> & { __callable?: [InputOf<E>, OutputOf<E>] };
export function onCall<Req, Res>(handler: (req: https.CallableRequest<Req>) => Res | Promise<Res>): https.CallableFunction<Req, Promise<Res>> & { __callable?: [Req, Res] };
export function onCall<Req, Res>(opts: CallableOptions<Req>, handler: (req: https.CallableRequest<Req>) => Res | Promise<Res>): https.CallableFunction<Req, Promise<Res>> & { __callable?: [Req, Res] };
export function onCall(a: unknown, b?: unknown, c?: unknown) {
  if (isEndpoint(a)) return endpointCall(a, (typeof b === 'function' ? {} : b) as https.CallableOptions, (typeof b === 'function' ? b : c) as (req: https.CallableRequest<unknown>) => unknown);
  const opts = (typeof a === 'function' ? {} : a) as CallableOptions<unknown>;
  const handler = (typeof a === 'function' ? a : b) as (req: https.CallableRequest<unknown>) => unknown;
  const { input, output, ...native } = opts;
  const run = async (req: https.CallableRequest<unknown>) => {
    if (input) {
      try {
        validateValue(input, req.data, 'request.data');
      } catch (e) {
        throw new https.HttpsError('invalid-argument', (e as Error).message);
      }
    }
    const res = await handler(req);
    if (output) validateValue(output, res, 'the result');
    return res;
  };
  return tag(https.onCall(native, run), { kind: 'call', handler: run, ...(input ? { input } : {}), ...(output ? { output } : {}) });
}

const isEndpoint = (x: unknown): x is AnyEndpoint => !!x && typeof x === 'object' && (x as { kind?: unknown }).kind === 'endpoint';

/** A declared callable: its input is checked before the handler runs, its output after. */
function endpointCall(e: AnyEndpoint, opts: https.CallableOptions, handler: (req: https.CallableRequest<unknown>) => unknown) {
  if (e.http) throw new IceBaseError('invalid-argument', `onCall(api.${e.name}): it is declared as HTTP ${e.http.method} ${e.http.path} — use onRequest(api.${e.name}, …)`, { reason: 'schema', service: 'functions' });
  const run = async (req: https.CallableRequest<unknown>) => {
    if (e.auth !== 'none' && !req.auth) throw new https.HttpsError('unauthenticated', `${e.name} needs a signed-in caller`);
    if (e.auth === 'admin' && !(req.auth?.token as { admin?: unknown } | undefined)?.admin) throw new https.HttpsError('permission-denied', `${e.name} is for admins`);
    let data: unknown;
    try {
      data = checkInput(e, fromWire(e.input, req.data));
    } catch (err) {
      throw new https.HttpsError('invalid-argument', (err as Error).message);
    }
    const out = await handler({ ...req, data } as https.CallableRequest<unknown>);
    try {
      return toWire(e.output, checkOutput(e, out));
    } catch (err) {
      throw new https.HttpsError('internal', (err as Error).message);
    }
  };
  return tag(https.onCall(opts, run), { kind: 'call', handler: run, input: e.input, output: e.output, endpoint: e });
}

const HTTP_STATUS: Record<string, number> = { 'invalid-argument': 400, 'failed-precondition': 400, 'out-of-range': 400, unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409, aborted: 409, 'resource-exhausted': 429, cancelled: 499, unimplemented: 501, unavailable: 503, 'deadline-exceeded': 504 };

/** What an HTTP endpoint's handler gets: the checked input (path params, query, JSON body merged) and the request. */
export interface EndpointRequest<I> {
  input: I;
  request: Request;
}

/** A declared HTTP endpoint: the route, the input (path + query + JSON body) checked, the output checked and sent as JSON. */
function endpointRequest(e: AnyEndpoint, opts: https.HttpsOptions, handler: (r: EndpointRequest<unknown>) => unknown) {
  if (!e.http) throw new IceBaseError('invalid-argument', `onRequest(api.${e.name}): it is declared as a callable — use onCall(api.${e.name}, …)`, { reason: 'schema', service: 'functions' });
  const http = e.http;
  const tpl = http.path.split('/').filter(Boolean);
  const fail = (code: string, message: string) => new Response(JSON.stringify({ error: { code, message } }), { status: HTTP_STATUS[code] ?? 500, headers: { 'content-type': 'application/json' } });
  const run = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== http.method) return fail('invalid-argument', `${e.name} answers ${http.method}`);
    const segs = url.pathname.split('/').filter(Boolean);
    // The function may be mounted at a prefix (a hosting rewrite): match the route's tail.
    const tail = segs.slice(Math.max(0, segs.length - tpl.length));
    const params: Record<string, string> = {};
    if (tail.length !== tpl.length || !tpl.every((t, i) => { const m = /^\{(.+)\}$/.exec(t); if (m) return (params[m[1]!] = decodeURIComponent(tail[i]!)), true; return t === tail[i]; })) return fail('not-found', `No route ${req.method} ${url.pathname}`);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    let body: Record<string, unknown> = {};
    if (req.method !== 'GET' && req.method !== 'DELETE' && (req.headers.get('content-type') ?? '').includes('json')) body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    // Query values are strings: numbers and booleans the input declares are read as such.
    const fields = e.input.def.kind === 'map' ? e.input.def.fields : {};
    const coerce = (k: string, v: string): unknown => { const d = fields[k]?.def.kind; return d === 'number' ? Number(v) : d === 'boolean' ? v === 'true' : v; };
    const raw = { ...Object.fromEntries(Object.entries({ ...query, ...params }).map(([k, v]) => [k, coerce(k, v)])), ...body };
    let input: unknown;
    try {
      input = checkInput(e, fromWire(e.input, raw));
    } catch (err) {
      return fail('invalid-argument', (err as Error).message);
    }
    try {
      const out = await handler({ input, request: req });
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(toWire(e.output, checkOutput(e, out))), { headers: { 'content-type': 'application/json' } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && HTTP_STATUS[code]) return fail(code, (err as Error).message);
      return fail('internal', (err as Error).message);
    }
  };
  return tag(https.onRequest(opts, async (req, res) => {
    const r = await run(await toRequest(req as unknown as import('node:http').IncomingMessage & { rawBody?: Buffer }));
    await sendResponse(res as unknown as import('node:http').ServerResponse, r);
  }), { kind: 'request', handler: run, endpoint: e });
}

type FetchHandler = (req: Request) => Response | Promise<Response>;
type ExpressHandler = (req: https.Request, res: import('express').Response) => void | Promise<void>;

/** onRequest(async (req: Request) => new Response(…)) — fetch-style. An express-style (req, res) handler works too. */
export function onRequest<E extends AnyEndpoint>(endpoint: E, handler: (r: EndpointRequest<InputOf<E>>) => OutputOf<E> | Response | Promise<OutputOf<E> | Response>): https.HttpsFunction;
export function onRequest<E extends AnyEndpoint>(endpoint: E, opts: https.HttpsOptions, handler: (r: EndpointRequest<InputOf<E>>) => OutputOf<E> | Response | Promise<OutputOf<E> | Response>): https.HttpsFunction;
export function onRequest(handler: FetchHandler): https.HttpsFunction;
export function onRequest(handler: ExpressHandler): https.HttpsFunction;
export function onRequest(opts: https.HttpsOptions, handler: FetchHandler): https.HttpsFunction;
export function onRequest(opts: https.HttpsOptions, handler: ExpressHandler): https.HttpsFunction;
export function onRequest(a: unknown, b?: unknown, c?: unknown): https.HttpsFunction {
  if (isEndpoint(a)) return endpointRequest(a, (typeof b === 'function' ? {} : b) as https.HttpsOptions, (typeof b === 'function' ? b : c) as (r: EndpointRequest<unknown>) => unknown);
  const opts = (typeof a === 'function' ? {} : a) as https.HttpsOptions;
  const handler = (typeof a === 'function' ? a : b) as FetchHandler | ExpressHandler;
  if (handler.length >= 2) return tag(https.onRequest(opts, handler as ExpressHandler), { kind: 'request', handler: () => new Response('express-style handlers run on Cloud Functions only', { status: 501 }), express: handler as ExpressHandler });
  const fetchHandler = handler as FetchHandler;
  const fn = https.onRequest(opts, async (req, res) => {
    await sendResponse(res as unknown as import('node:http').ServerResponse, await fetchHandler(await toRequest(req as unknown as import('node:http').IncomingMessage & { rawBody?: Buffer })));
  });
  return tag(fn, { kind: 'request', handler: fetchHandler });
}

// ─── Firestore triggers ────────────────────────────────────────────────────────

type ParamsOf<P extends string> = P extends `${string}{${infer N}}${infer R}` ? { [K in N]: string } & ParamsOf<R> : {};
export interface DocEvent<C extends AnyCollection> {
  params: ParamsOf<C['path']> & { docId: string };
  data: QueryDocumentSnapshot<DocOf<C>>;
  id: string;
  time: string;
}
export interface DocChangeEvent<C extends AnyCollection> {
  params: ParamsOf<C['path']> & { docId: string };
  data: { before: QueryDocumentSnapshot<DocOf<C>>; after: QueryDocumentSnapshot<DocOf<C>> };
  id: string;
  time: string;
}
export interface DocWriteEvent<C extends AnyCollection> {
  params: ParamsOf<C['path']> & { docId: string };
  /** Either side may not exist (create / delete). */
  data: { before: DocumentSnapshot<DocOf<C>>; after: DocumentSnapshot<DocOf<C>> };
  id: string;
  time: string;
}
export type DocumentOptions = Omit<fs.DocumentOptions, 'document'>;

const docPattern = (c: AnyCollection) => `${c.path}/{docId}`;
const snap = async (s: unknown): Promise<QueryDocumentSnapshot<unknown>> => {
  const db = await triggerDb();
  const raw = db._driver.fromNative!(s);
  return new QueryDocumentSnapshot(docFromPath(db, raw.path), raw);
};

/**
 * A trigger on a document path pattern ('boards/{boardId}/tickets/{ticketId}'), firebase-functions'
 * own form: the event and its snapshots are firebase-admin's (in emulator mode, IceBase's
 * firebase-admin-compatible ones), the params named as in the pattern. For code moving over as is.
 */
function patternTrigger(event: 'created' | 'updated' | 'deleted' | 'written', pattern: string, a: DocumentOptions | ((e: any) => unknown), b?: (e: any) => unknown) {
  const opts = (typeof a === 'function' ? {} : a) as DocumentOptions;
  const handler = (typeof a === 'function' ? a : b) as (e: unknown) => unknown;
  const native =
    event === 'created'
      ? fs.onDocumentCreated({ ...opts, document: pattern }, handler as never)
      : event === 'updated'
        ? fs.onDocumentUpdated({ ...opts, document: pattern }, handler as never)
        : event === 'deleted'
          ? fs.onDocumentDeleted({ ...opts, document: pattern }, handler as never)
          : fs.onDocumentWritten({ ...opts, document: pattern }, handler as never);
  // The IceBase server hands this one wire documents: turn them into compat snapshots first.
  const run = async (raw: { params: Record<string, string>; id: string; time: string; data: any }) => {
    const db = await triggerDb();
    const { getFirestore, snapshotFromRaw } = await import('./compat.ts');
    const cdb = getFirestore(db.app);
    const snap = (w: unknown) => snapshotFromRaw(cdb, db._driver.fromNative!(w));
    const data = event === 'created' || event === 'deleted' ? snap(raw.data) : { before: snap(raw.data.before), after: snap(raw.data.after) };
    return handler({ ...raw, document: undefined, data });
  };
  return tag(native, { kind: 'document', event, pattern, handler: run as (e: unknown) => unknown });
}

function trigger<C extends AnyCollection, E>(
  event: 'created' | 'updated' | 'deleted' | 'written',
  c: C,
  a: DocumentOptions | ((e: E) => unknown),
  b: ((e: E) => unknown) | undefined,
  build: (raw: fs.FirestoreEvent<any, Record<string, string>>) => Promise<E>,
) {
  if (!c || c.kind !== 'collection') throw new IceBaseError('invalid-argument', `onDocument${event[0]!.toUpperCase()}${event.slice(1)}(collection, handler): pass a collection from your schema`, { service: 'functions' });
  const opts = (typeof a === 'function' ? {} : a) as DocumentOptions;
  const handler = (typeof a === 'function' ? a : b) as (e: E) => unknown;
  const run = async (raw: fs.FirestoreEvent<any, Record<string, string>>) => handler(await build(raw));
  const native =
    event === 'created'
      ? fs.onDocumentCreated({ ...opts, document: docPattern(c) }, run)
      : event === 'updated'
        ? fs.onDocumentUpdated({ ...opts, document: docPattern(c) }, run)
        : event === 'deleted'
          ? fs.onDocumentDeleted({ ...opts, document: docPattern(c) }, run)
          : fs.onDocumentWritten({ ...opts, document: docPattern(c) }, run);
  return tag(native, { kind: 'document', event, collection: c, handler: run as (e: unknown) => unknown });
}

const meta = (raw: fs.FirestoreEvent<unknown, Record<string, string>>) => ({ params: raw.params, id: raw.id, time: raw.time });

/** Typed trigger: e.params.uid comes from 'users/{uid}/orders', e.data.data() is the order type. */
export function onDocumentCreated<C extends AnyCollection>(c: C, handler: (e: DocEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentCreated<C extends AnyCollection>(c: C, opts: DocumentOptions, handler: (e: DocEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentCreated(pattern: string, handler: (e: fs.FirestoreEvent<any, Record<string, string>>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentCreated(pattern: string, opts: DocumentOptions, handler: (e: fs.FirestoreEvent<any, Record<string, string>>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentCreated<C extends AnyCollection>(c: C, a: any, b?: any) {
  if (typeof c === 'string') return patternTrigger('created', c, a, b);
  return trigger<C, DocEvent<C>>('created', c, a, b, async (raw) => ({ ...meta(raw), data: (await snap(raw.data)) as DocEvent<C>['data'] }) as DocEvent<C>);
}
export function onDocumentDeleted<C extends AnyCollection>(c: C, handler: (e: DocEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentDeleted<C extends AnyCollection>(c: C, opts: DocumentOptions, handler: (e: DocEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentDeleted(pattern: string, handler: (e: fs.FirestoreEvent<any, Record<string, string>>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentDeleted(pattern: string, opts: DocumentOptions, handler: (e: fs.FirestoreEvent<any, Record<string, string>>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentDeleted<C extends AnyCollection>(c: C, a: any, b?: any) {
  if (typeof c === 'string') return patternTrigger('deleted', c, a, b);
  return trigger<C, DocEvent<C>>('deleted', c, a, b, async (raw) => ({ ...meta(raw), data: (await snap(raw.data)) as DocEvent<C>['data'] }) as DocEvent<C>);
}
export function onDocumentUpdated<C extends AnyCollection>(c: C, handler: (e: DocChangeEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentUpdated<C extends AnyCollection>(c: C, opts: DocumentOptions, handler: (e: DocChangeEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentUpdated(pattern: string, handler: (e: fs.FirestoreEvent<any, Record<string, string>>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentUpdated(pattern: string, opts: DocumentOptions, handler: (e: fs.FirestoreEvent<any, Record<string, string>>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentUpdated<C extends AnyCollection>(c: C, a: any, b?: any) {
  if (typeof c === 'string') return patternTrigger('updated', c, a, b);
  return trigger<C, DocChangeEvent<C>>('updated', c, a, b, async (raw) => ({ ...meta(raw), data: { before: await snap(raw.data.before), after: await snap(raw.data.after) } }) as DocChangeEvent<C>);
}
export function onDocumentWritten<C extends AnyCollection>(c: C, handler: (e: DocWriteEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentWritten<C extends AnyCollection>(c: C, opts: DocumentOptions, handler: (e: DocWriteEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentWritten(pattern: string, handler: (e: fs.FirestoreEvent<any, Record<string, string>>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentWritten(pattern: string, opts: DocumentOptions, handler: (e: fs.FirestoreEvent<any, Record<string, string>>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentWritten<C extends AnyCollection>(c: C, a: any, b?: any) {
  if (typeof c === 'string') return patternTrigger('written', c, a, b);
  return trigger<C, DocWriteEvent<C>>('written', c, a, b, async (raw) => ({ ...meta(raw), data: { before: await snap(raw.data.before), after: await snap(raw.data.after) } }) as DocWriteEvent<C>);
}

// ─── scheduler ─────────────────────────────────────────────────────────────────

/** onSchedule('0 2 * * *', handler) or onSchedule({ schedule, timeZone, … }, handler). */
export function onSchedule(schedule: string | scheduler.ScheduleOptions, handler: (e: scheduler.ScheduledEvent) => void | Promise<void>): scheduler.ScheduleFunction {
  const fn = scheduler.onSchedule(schedule as scheduler.ScheduleOptions, handler);
  return tag(fn, { kind: 'schedule', schedule: typeof schedule === 'string' ? schedule : schedule.schedule, handler: () => handler({ scheduleTime: new Date().toISOString() } as scheduler.ScheduledEvent) });
}

// ─── storage ───────────────────────────────────────────────────────────────────

type StorageOpts = storageFns.StorageOptions | string;
type StorageHandler = (e: storageFns.StorageEvent) => unknown;
function storageTrigger(event: 'finalized' | 'deleted' | 'metadataUpdated', a: StorageOpts | StorageHandler, b?: StorageHandler) {
  const opts = typeof a === 'function' ? {} : typeof a === 'string' ? { bucket: a } : a;
  const handler = (typeof a === 'function' ? a : b) as StorageHandler;
  const native =
    event === 'finalized' ? storageFns.onObjectFinalized(opts, handler) : event === 'deleted' ? storageFns.onObjectDeleted(opts, handler) : storageFns.onObjectMetadataUpdated(opts, handler);
  return tag(native, { kind: 'storage', event, ...(opts.bucket ? { bucket: opts.bucket as string } : {}), handler: handler as (e: CloudEvent<storageFns.StorageObjectData>) => unknown });
}
/** A stored object was written (created or replaced). Same event as firebase-functions. */
export function onObjectFinalized(handler: StorageHandler): CloudFunction<storageFns.StorageEvent>;
export function onObjectFinalized(opts: StorageOpts, handler: StorageHandler): CloudFunction<storageFns.StorageEvent>;
export function onObjectFinalized(a: StorageOpts | StorageHandler, b?: StorageHandler): CloudFunction<storageFns.StorageEvent> {
  return storageTrigger('finalized', a, b);
}
export function onObjectDeleted(handler: StorageHandler): CloudFunction<storageFns.StorageEvent>;
export function onObjectDeleted(opts: StorageOpts, handler: StorageHandler): CloudFunction<storageFns.StorageEvent>;
export function onObjectDeleted(a: StorageOpts | StorageHandler, b?: StorageHandler): CloudFunction<storageFns.StorageEvent> {
  return storageTrigger('deleted', a, b);
}
export function onObjectMetadataUpdated(handler: StorageHandler): CloudFunction<storageFns.StorageEvent>;
export function onObjectMetadataUpdated(opts: StorageOpts, handler: StorageHandler): CloudFunction<storageFns.StorageEvent>;
export function onObjectMetadataUpdated(a: StorageOpts | StorageHandler, b?: StorageHandler): CloudFunction<storageFns.StorageEvent> {
  return storageTrigger('metadataUpdated', a, b);
}

// ─── Realtime Database ─────────────────────────────────────────────────────────

/** One side of a Realtime Database change, the same in both modes. */
export interface ValueSnapshot<T = unknown> {
  readonly key: string | null;
  exists(): boolean;
  val(): T | null;
}
export interface ValueEvent<T = unknown> {
  params: Record<string, string>;
  id: string;
  time: string;
  data: ValueSnapshot<T>;
}
export interface ValueChangeEvent<T = unknown> {
  params: Record<string, string>;
  id: string;
  time: string;
  data: { before: ValueSnapshot<T>; after: ValueSnapshot<T> };
}
type DbRef = string | { readonly kind: 'dbPath'; readonly path: string };
const refOf = (r: DbRef) => `/${(typeof r === 'string' ? r : r.path).replace(/^\/+/, '')}`;
const fromNativeSnap = (s: { key: string | null; exists(): boolean; val(): unknown }): ValueSnapshot => ({ key: s.key, exists: () => s.exists(), val: () => s.val() });

function dbTrigger(event: 'created' | 'updated' | 'deleted' | 'written', r: DbRef, a: Omit<databaseFns.ReferenceOptions, 'ref'> | ((e: never) => unknown), b?: (e: never) => unknown) {
  const opts = { ...(typeof a === 'function' ? {} : a), ref: refOf(r) } as databaseFns.ReferenceOptions;
  const handler = (typeof a === 'function' ? a : b) as (e: unknown) => unknown;
  // One event shape in both modes: the native event's snapshots become ValueSnapshots.
  const wrap = (raw: databaseFns.DatabaseEvent<any, Record<string, string>>) => {
    const d = raw.data as { before?: never; after?: never } & { key: string | null; exists(): boolean; val(): unknown };
    const data = d && 'before' in d && d.before ? { before: fromNativeSnap(d.before), after: fromNativeSnap(d.after!) } : fromNativeSnap(d);
    return handler({ params: raw.params, id: raw.id, time: raw.time, data });
  };
  const native =
    event === 'created'
      ? databaseFns.onValueCreated(opts, wrap)
      : event === 'updated'
        ? databaseFns.onValueUpdated(opts, wrap)
        : event === 'deleted'
          ? databaseFns.onValueDeleted(opts, wrap)
          : databaseFns.onValueWritten(opts, wrap);
  return tag(native, { kind: 'database', event, ref: opts.ref, handler });
}
/** dbPath from the schema (typed) or a ref pattern '/rooms/{roomId}'. */
export function onValueCreated<T = unknown>(ref: DbRef, handler: (e: ValueEvent<T>) => unknown): CloudFunction<databaseFns.DatabaseEvent<any>>;
export function onValueCreated<T = unknown>(ref: DbRef, opts: Omit<databaseFns.ReferenceOptions, 'ref'>, handler: (e: ValueEvent<T>) => unknown): CloudFunction<databaseFns.DatabaseEvent<any>>;
export function onValueCreated(ref: DbRef, a: any, b?: any) {
  return dbTrigger('created', ref, a, b);
}
export function onValueDeleted<T = unknown>(ref: DbRef, handler: (e: ValueEvent<T>) => unknown): CloudFunction<databaseFns.DatabaseEvent<any>>;
export function onValueDeleted<T = unknown>(ref: DbRef, opts: Omit<databaseFns.ReferenceOptions, 'ref'>, handler: (e: ValueEvent<T>) => unknown): CloudFunction<databaseFns.DatabaseEvent<any>>;
export function onValueDeleted(ref: DbRef, a: any, b?: any) {
  return dbTrigger('deleted', ref, a, b);
}
export function onValueUpdated<T = unknown>(ref: DbRef, handler: (e: ValueChangeEvent<T>) => unknown): CloudFunction<databaseFns.DatabaseEvent<any>>;
export function onValueUpdated<T = unknown>(ref: DbRef, opts: Omit<databaseFns.ReferenceOptions, 'ref'>, handler: (e: ValueChangeEvent<T>) => unknown): CloudFunction<databaseFns.DatabaseEvent<any>>;
export function onValueUpdated(ref: DbRef, a: any, b?: any) {
  return dbTrigger('updated', ref, a, b);
}
export function onValueWritten<T = unknown>(ref: DbRef, handler: (e: ValueChangeEvent<T>) => unknown): CloudFunction<databaseFns.DatabaseEvent<any>>;
export function onValueWritten<T = unknown>(ref: DbRef, opts: Omit<databaseFns.ReferenceOptions, 'ref'>, handler: (e: ValueChangeEvent<T>) => unknown): CloudFunction<databaseFns.DatabaseEvent<any>>;
export function onValueWritten(ref: DbRef, a: any, b?: any) {
  return dbTrigger('written', ref, a, b);
}

// ─── task queues ───────────────────────────────────────────────────────────────

export type TaskQueueOptions = tasks.TaskQueueOptions;
/** A task queue's worker; enqueue with taskQueue(app, name).enqueue(data) (icebase/admin). */
export function onTaskDispatched<Args = any>(handler: (req: tasks.Request<Args>) => void | Promise<void>): tasks.TaskQueueFunction<Args>;
export function onTaskDispatched<Args = any>(opts: TaskQueueOptions, handler: (req: tasks.Request<Args>) => void | Promise<void>): tasks.TaskQueueFunction<Args>;
export function onTaskDispatched(a: unknown, b?: unknown) {
  const opts = (typeof a === 'function' ? {} : a) as TaskQueueOptions;
  const handler = (typeof a === 'function' ? a : b) as (req: tasks.Request<unknown>) => void | Promise<void>;
  const native = tasks.onTaskDispatched(opts, handler);
  const rc = opts.retryConfig ?? {};
  const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
  return tag(native, {
    kind: 'task',
    handler: handler as (req: tasks.Request<unknown>) => unknown,
    retry: { maxAttempts: num(rc.maxAttempts, 3), minBackoffSeconds: num(rc.minBackoffSeconds, 1), maxBackoffSeconds: num(rc.maxBackoffSeconds, 60) },
    ...(typeof opts.region === 'string' ? { region: opts.region } : {}),
  });
}

// ─── auth ──────────────────────────────────────────────────────────────────────

export type AuthBlockingEvent = identity.AuthBlockingEvent;
type BeforeCreateHandler = Parameters<typeof identity.beforeUserCreated>[0] extends infer H ? (H extends (...a: any[]) => any ? H : never) : never;
type BeforeSignInHandler = Parameters<typeof identity.beforeUserSignedIn>[0] extends infer H ? (H extends (...a: any[]) => any ? H : never) : never;
type BlockingFn = ReturnType<typeof identity.beforeUserCreated>;
/** Runs before a user is created; throw HttpsError to refuse, or return changes (customClaims, displayName, disabled …). */
export function beforeUserCreated(handler: BeforeCreateHandler): BlockingFn;
export function beforeUserCreated(opts: identity.BlockingOptions, handler: BeforeCreateHandler): BlockingFn;
export function beforeUserCreated(a: any, b?: any) {
  const handler = typeof a === 'function' ? a : b;
  const native = typeof a === 'function' ? identity.beforeUserCreated(a) : identity.beforeUserCreated(a, b);
  return tag(native, { kind: 'auth', event: 'beforeCreate', handler });
}
/** Runs before each sign-in; throw HttpsError to refuse, or return changes (sessionClaims …). */
export function beforeUserSignedIn(handler: BeforeSignInHandler): BlockingFn;
export function beforeUserSignedIn(opts: identity.BlockingOptions, handler: BeforeSignInHandler): BlockingFn;
export function beforeUserSignedIn(a: any, b?: any) {
  const handler = typeof a === 'function' ? a : b;
  const native = typeof a === 'function' ? identity.beforeUserSignedIn(a) : identity.beforeUserSignedIn(a, b);
  return tag(native, { kind: 'auth', event: 'beforeSignIn', handler });
}
/** A user was created / deleted (any way: sign-up, admin, custom auth). Uses firebase-functions v1's auth trigger in firebase mode. */
export interface UserRecordLike {
  uid: string;
  email?: string;
  displayName?: string;
  phoneNumber?: string;
  photoURL?: string;
  disabled: boolean;
  emailVerified: boolean;
  customClaims?: Record<string, unknown>;
  providerData: { providerId: string; uid: string; email?: string }[];
}
export function onUserCreated(handler: (user: UserRecordLike) => unknown): ReturnType<ReturnType<typeof v1auth.user>['onCreate']> {
  return tag(v1auth.user().onCreate((u) => handler(u as unknown as UserRecordLike)), { kind: 'auth', event: 'created', handler: handler as (e: unknown) => unknown });
}
export function onUserDeleted(handler: (user: UserRecordLike) => unknown): ReturnType<ReturnType<typeof v1auth.user>['onDelete']> {
  return tag(v1auth.user().onDelete((u) => handler(u as unknown as UserRecordLike)), { kind: 'auth', event: 'deleted', handler: handler as (e: unknown) => unknown });
}

// ─── custom auth endpoint ──────────────────────────────────────────────────────

/** The `icebaseAuth` function: custom auth's endpoint (docs/prd/custom-auth.html). `icebase deploy` adds it when config.auth.custom is set. */
export function icebaseAuth<Cfg extends IceBaseConfig<any, any>>(
  config: Cfg,
  env: EnvOf<Cfg>,
  opts: Omit<import('./auth.ts').AuthHandlerOptions, 'app'> & { https?: https.HttpsOptions } = {},
): https.HttpsFunction {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const lazy = async (req: Request) => {
    if (!handler) {
      const [{ createAuthHandler }, { initializeAdminApp }] = await Promise.all([import('./auth.ts'), import('./admin.ts')]);
      const app = initializeAdminApp(config as AnyConfig, env, { name: 'icebase-auth' });
      handler = createAuthHandler(config as AnyConfig, env, { ...opts, app });
    }
    return handler(req);
  };
  return onRequest({ cors: false, ...opts.https }, lazy);
}
