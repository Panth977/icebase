// icebase/functions — client side, same as firebase/functions. Server-side triggers are in
// icebase/functions/v2. Callables can be typed from the server definition:
//   import type { cancelOrder } from '../../icebase/functions/src/orders';
//   const cancel = httpsCallable<typeof cancelOrder>(functions, 'cancelOrder');

import * as fn from 'firebase/functions';
import { emulatorOrigin, service, type IceBaseApp } from './app.ts';
import { IceBaseError } from './errors.ts';
import { nativeWebApp } from './internal/firebase-web-app.ts';
import { validateValue, type Field } from './schema.ts';

export class Functions {
  constructor(
    readonly app: IceBaseApp,
    readonly region: string,
    /** @internal */ readonly _native: fn.Functions,
  ) {}
}

export function getFunctions(app: IceBaseApp, regionOrCustomDomain?: string): Functions {
  if (app.kind === 'admin') throw new IceBaseError('invalid-argument', 'getFunctions(app) is the client SDK; call functions from the server directly', { reason: 'config' });
  const region = regionOrCustomDomain ?? app.config.functions?.region ?? 'us-central1';
  return service(app, `functions:${region}`, () => {
    const mode = app.modes.functions;
    const native = fn.getFunctions(nativeWebApp(app), region);
    if (mode === 'emulator') {
      const u = new URL(emulatorOrigin(app));
      fn.connectFunctionsEmulator(native, u.hostname, Number(u.port));
    }
    return new Functions(app, region, native);
  });
}

export function connectFunctionsEmulator(functions: Functions, host: string, port: number): void {
  fn.connectFunctionsEmulator(functions._native, host, port);
}

/** What icebase/functions/v2's onCall() returns, as a type (never imported at runtime by the client). */
export interface CallableDefinition<Req, Res> {
  readonly __callable?: [Req, Res];
}
type ReqOf<A, B> = A extends CallableDefinition<infer R, any> ? (B extends unknown ? R : R) : A;
type ResOf<A, B> = A extends CallableDefinition<any, infer S> ? S : B;

export interface HttpsCallableResult<Res> {
  readonly data: Res;
}
export interface HttpsCallable<Req, Res> {
  (data?: Req | null): Promise<HttpsCallableResult<Res>>;
  stream?: unknown;
}
export interface HttpsCallableOptions extends fn.HttpsCallableOptions {
  /** Validate the request on the client before it is sent (the server validates again). */
  input?: Field<unknown>;
}

/** httpsCallable<Req, Res>(functions, name) — or httpsCallable<typeof serverCallable>(functions, name). */
export function httpsCallable<A = unknown, B = unknown>(functions: Functions, name: string, options?: HttpsCallableOptions): HttpsCallable<ReqOf<A, B>, ResOf<A, B>> {
  const { input, ...rest } = options ?? {};
  const call = fn.httpsCallable<ReqOf<A, B>, ResOf<A, B>>(functions._native, name, rest);
  return (async (data?: ReqOf<A, B> | null) => {
    if (input) validateValue(input, data, `httpsCallable('${name}') request`);
    const r = await call(data);
    return { data: r.data };
  }) as HttpsCallable<ReqOf<A, B>, ResOf<A, B>>;
}

export function httpsCallableFromURL<Req = unknown, Res = unknown>(functions: Functions, url: string, options?: fn.HttpsCallableOptions): HttpsCallable<Req, Res> {
  const call = fn.httpsCallableFromURL<Req, Res>(functions._native, url, options);
  return (async (data?: Req | null) => ({ data: (await call(data)).data })) as HttpsCallable<Req, Res>;
}

export type FunctionsErrorCode = fn.FunctionsErrorCode;
export type FunctionsError = fn.FunctionsError;

// ─── declared endpoints (icebase/api) ──────────────────────────────────────────

import type { AnyEndpoint, InputOf, OutputOf } from './api.ts';
import { checkInput, checkOutput, fromWire, toWire } from './api.ts';

/** A declared callable: callable(functions, api.createOrder)(input) — the input is checked before
 * it is sent and the result after it arrives, both against the endpoint's declaration. */
export function callable<E extends AnyEndpoint>(functions: Functions, e: E): (input: InputOf<E>) => Promise<OutputOf<E>> {
  if (e.http) throw new IceBaseError('invalid-argument', `callable(api.${e.name}): it is an HTTP endpoint — use request(functions, api.${e.name}, input)`, { reason: 'schema', service: 'functions' });
  const call = fn.httpsCallable(functions._native, e.name);
  return async (input) => {
    const data = toWire(e.input, checkInput(e, fromWire(e.input, input)));
    const r = await call(data);
    return checkOutput(e, fromWire(e.output, r.data));
  };
}

/** Call a declared HTTP endpoint: path parameters filled from the input, the rest as query (GET,
 * DELETE) or JSON body; the signed-in user's ID token is sent; the JSON answer is checked. */
export async function request<E extends AnyEndpoint>(functions: Functions, e: E, input: InputOf<E>, opts: { baseUrl?: string } = {}): Promise<OutputOf<E>> {
  if (!e.http) throw new IceBaseError('invalid-argument', `request(api.${e.name}): it is a callable — use callable(functions, api.${e.name})`, { reason: 'schema', service: 'functions' });
  const data = toWire(e.input, checkInput(e, fromWire(e.input, input))) as Record<string, unknown>;
  const app = functions.app;
  const project = app.config.firebase?.projectId ?? `demo-${app.config.name}`;
  const base = opts.baseUrl ?? (app.modes.functions === 'emulator' ? `${emulatorOrigin(app)}/${project}/${functions.region}/${e.name}` : `https://${functions.region}-${project}.cloudfunctions.net/${e.name}`);
  const rest = { ...data };
  const path = e.http.path.replace(/\{([^}]+)\}/g, (_m, k: string) => {
    const v = rest[k];
    delete rest[k];
    return encodeURIComponent(String(v));
  });
  const url = new URL(base.replace(/\/$/, '') + path);
  const bodyless = e.http.method === 'GET' || e.http.method === 'DELETE';
  if (bodyless) for (const [k, v] of Object.entries(rest)) if (v !== undefined) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const auth = app._services.get('auth') as { currentUser?: { getIdToken(): Promise<string> } | null } | undefined;
  const token = auth?.currentUser ? await auth.currentUser.getIdToken() : null;
  const res = await fetch(url, { method: e.http.method, headers: { ...(bodyless ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(bodyless ? {} : { body: JSON.stringify(rest) }) });
  const j = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok || (j && j.error)) throw new IceBaseError((j?.error?.code ?? 'internal') as IceBaseError['code'], j?.error?.message ?? `${e.name}: HTTP ${res.status}`, { service: 'functions' });
  return checkOutput(e, fromWire(e.output, j));
}
