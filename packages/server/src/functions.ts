// icebase/functions/v2 — server-side functions, same names as firebase-functions/v2, typed
// from the schema. The same source deploys to Cloud Functions (firebase mode) or runs on the
// IceBase server (emulator mode), which calls the handlers through their `__icebase` record.

import * as fs from 'firebase-functions/v2/firestore';
import * as https from 'firebase-functions/v2/https';
import * as scheduler from 'firebase-functions/v2/scheduler';
import type { CloudFunction } from 'firebase-functions/v2';
import { adminApps, type IceBaseApp } from '@panth977/icebase/app';
import type { AnyConfig, EnvOf, IceBaseConfig } from '@panth977/icebase/config';
import { IceBaseError } from '@panth977/icebase/errors';
import { DocumentSnapshot, QueryDocumentSnapshot, docFromPath, type Firestore } from '@panth977/icebase/firestore';
import { sendResponse, toRequest } from './internal/node-http.ts';
import { validateValue, type AnyCollection, type DocOf, type Field } from '@panth977/icebase/schema';
import { Buffer } from 'node:buffer';

export { HttpsError } from 'firebase-functions/v2/https';
export type { CallableRequest } from 'firebase-functions/v2/https';
export { setGlobalOptions } from 'firebase-functions/v2';

/** How the IceBase emulator finds and runs a function. */
export type IceBaseFunctionRecord =
  | { kind: 'call'; handler: (req: https.CallableRequest<unknown>) => unknown; input?: Field<unknown>; output?: Field<unknown>; region?: string }
  | { kind: 'request'; handler: (req: Request) => Response | Promise<Response>; express?: ExpressHandler; region?: string }
  | { kind: 'document'; event: 'created' | 'updated' | 'deleted' | 'written'; collection: AnyCollection; handler: (e: unknown) => unknown }
  | { kind: 'schedule'; schedule: string; handler: () => unknown };

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
export function onCall<Req, Res>(handler: (req: https.CallableRequest<Req>) => Res | Promise<Res>): https.CallableFunction<Req, Promise<Res>> & { __callable?: [Req, Res] };
export function onCall<Req, Res>(opts: CallableOptions<Req>, handler: (req: https.CallableRequest<Req>) => Res | Promise<Res>): https.CallableFunction<Req, Promise<Res>> & { __callable?: [Req, Res] };
export function onCall(a: unknown, b?: unknown) {
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

type FetchHandler = (req: Request) => Response | Promise<Response>;
type ExpressHandler = (req: https.Request, res: import('express').Response) => void | Promise<void>;

/** onRequest(async (req: Request) => new Response(…)) — fetch-style. An express-style (req, res) handler works too. */
export function onRequest(handler: FetchHandler): https.HttpsFunction;
export function onRequest(handler: ExpressHandler): https.HttpsFunction;
export function onRequest(opts: https.HttpsOptions, handler: FetchHandler): https.HttpsFunction;
export function onRequest(opts: https.HttpsOptions, handler: ExpressHandler): https.HttpsFunction;
export function onRequest(a: unknown, b?: unknown): https.HttpsFunction {
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
export function onDocumentCreated<C extends AnyCollection>(c: C, a: any, b?: any) {
  return trigger<C, DocEvent<C>>('created', c, a, b, async (raw) => ({ ...meta(raw), data: (await snap(raw.data)) as DocEvent<C>['data'] }) as DocEvent<C>);
}
export function onDocumentDeleted<C extends AnyCollection>(c: C, handler: (e: DocEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentDeleted<C extends AnyCollection>(c: C, opts: DocumentOptions, handler: (e: DocEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentDeleted<C extends AnyCollection>(c: C, a: any, b?: any) {
  return trigger<C, DocEvent<C>>('deleted', c, a, b, async (raw) => ({ ...meta(raw), data: (await snap(raw.data)) as DocEvent<C>['data'] }) as DocEvent<C>);
}
export function onDocumentUpdated<C extends AnyCollection>(c: C, handler: (e: DocChangeEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentUpdated<C extends AnyCollection>(c: C, opts: DocumentOptions, handler: (e: DocChangeEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentUpdated<C extends AnyCollection>(c: C, a: any, b?: any) {
  return trigger<C, DocChangeEvent<C>>('updated', c, a, b, async (raw) => ({ ...meta(raw), data: { before: await snap(raw.data.before), after: await snap(raw.data.after) } }) as DocChangeEvent<C>);
}
export function onDocumentWritten<C extends AnyCollection>(c: C, handler: (e: DocWriteEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentWritten<C extends AnyCollection>(c: C, opts: DocumentOptions, handler: (e: DocWriteEvent<C>) => unknown): CloudFunction<fs.FirestoreEvent<unknown>>;
export function onDocumentWritten<C extends AnyCollection>(c: C, a: any, b?: any) {
  return trigger<C, DocWriteEvent<C>>('written', c, a, b, async (raw) => ({ ...meta(raw), data: { before: await snap(raw.data.before), after: await snap(raw.data.after) } }) as DocWriteEvent<C>);
}

// ─── scheduler ─────────────────────────────────────────────────────────────────

/** onSchedule('0 2 * * *', handler) or onSchedule({ schedule, timeZone, … }, handler). */
export function onSchedule(schedule: string | scheduler.ScheduleOptions, handler: (e: scheduler.ScheduledEvent) => void | Promise<void>): scheduler.ScheduleFunction {
  const fn = scheduler.onSchedule(schedule as scheduler.ScheduleOptions, handler);
  return tag(fn, { kind: 'schedule', schedule: typeof schedule === 'string' ? schedule : schedule.schedule, handler: () => handler({ scheduleTime: new Date().toISOString() } as scheduler.ScheduledEvent) });
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
