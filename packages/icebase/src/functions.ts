// icebase/functions — client side, same as firebase/functions. Server-side triggers are in
// icebase/functions/v2. Callables can be typed from the server definition:
//   import type { cancelOrder } from '../../icebase/functions/src/orders';
//   const cancel = httpsCallable<typeof cancelOrder>(functions, 'cancelOrder');

import * as fn from 'firebase/functions';
import { emulatorOrigin, service, type IceBaseApp } from './app.js';
import { IceBaseError } from './errors.js';
import { nativeWebApp } from './internal/firebase-web-app.js';
import { validateValue, type Field } from './schema.js';

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
    if (mode === 'vm') throw new IceBaseError('unimplemented', 'functions in vm mode are not built yet (phase 3)', { reason: 'mode', service: 'functions' });
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
