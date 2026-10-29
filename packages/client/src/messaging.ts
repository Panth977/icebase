// icebase/messaging — same names as firebase/messaging, with typed payloads: a message of a kind
// declared in config.messaging.messages arrives in onMessage as { kind, data } with data in its
// declared types (payload.data stays FCM's string map in payload.rawData).
//
// firebase mode: the Firebase JS SDK (Web Push through a service worker; vapidKey defaults to
// config.messaging.vapidKey). emulator / vm mode: the IceBase server issues the registration token
// and delivers messages to the open app over the realtime socket (foreground only: no Web Push, no
// service worker, no background notifications). Messages sent while the app is closed wait on the
// server and arrive when it listens again.

import * as fm from 'firebase/messaging';
import { service, type IceBaseApp } from './app.ts';
import type { AnyConfig, MessageKindsOf } from './config.ts';
import { IceBaseError } from './errors.ts';
import { nativeWebApp } from './internal/firebase-web-app.ts';
import { decodeMessageData } from './internal/messaging-shared.ts';
import { post, realtimeOf } from './drivers/firestore-emulator.ts';
import { nextId } from './internal/rt-client.ts';
import type { Infer, FieldMap } from './schema.ts';

export type NotificationPayload = fm.NotificationPayload;
export type FcmOptions = fm.FcmOptions;
export type GetTokenOptions = fm.GetTokenOptions;
export type Unsubscribe = () => void;
export type NextFn<T> = (value: T) => void;
export interface Observer<T> {
  next: NextFn<T>;
  error?: (e: Error) => void;
  complete?: () => void;
}

type Kinds<Cfg> = MessageKindsOf<Cfg>;
/** The typed part of a payload: one of the declared kinds with its data, or no kind (untyped / notification only). */
export type TypedData<Cfg> =
  | { [K in keyof Kinds<Cfg> & string]: { kind: K; data: Kinds<Cfg>[K] extends FieldMap ? Infer<Kinds<Cfg>[K]> : never } }[keyof Kinds<Cfg> & string]
  | { kind: undefined; data?: Record<string, string> };

/** Firebase's MessagePayload; `kind` + `data` typed from config.messaging.messages, `rawData` as FCM sent it. */
export type MessagePayload<Cfg extends AnyConfig = AnyConfig> = Omit<fm.MessagePayload, 'data'> & TypedData<Cfg> & { rawData?: Record<string, string> };

export class Messaging<Cfg extends AnyConfig = AnyConfig> {
  /** @internal emulator: the token the server issued, once getToken ran. */
  _token: string | null = null;
  /** @internal emulator: onMessage handlers. */
  readonly _handlers: Set<Observer<MessagePayload<Cfg>>> = new Set();
  /** @internal */ _unlisten: (() => void) | null = null;
  constructor(
    readonly app: IceBaseApp<Cfg>,
    /** @internal firebase mode */ readonly _native: fm.Messaging | null,
  ) {}
}

export function getMessaging<Cfg extends AnyConfig>(app: IceBaseApp<Cfg>): Messaging<Cfg> {
  if (app.kind === 'admin') throw new IceBaseError('invalid-argument', 'This is an admin app: use getAdminMessaging(app) from icebase/admin', { reason: 'config' });
  return service(app, 'messaging', () => new Messaging(app, app.modes.messaging === 'firebase' ? fm.getMessaging(nativeWebApp(app)) : null));
}

/** firebase mode: whether this browser can receive pushes; the IceBase server's delivery always works. */
export const isSupported = (): Promise<boolean> => fm.isSupported();

function typed<Cfg extends AnyConfig>(m: Messaging<Cfg>, p: fm.MessagePayload): MessagePayload<Cfg> {
  const d = decodeMessageData((m.app.config.messaging?.messages ?? {}) as Record<string, FieldMap>, p.data);
  if (d.error) console.warn(`[icebase messaging] ${d.error}: delivered untyped`);
  return { ...p, kind: d.kind, data: d.data, ...(p.data ? { rawData: p.data } : {}) } as MessagePayload<Cfg>;
}

/** The registration token of this app instance (emulator: issued by the IceBase server, kept for the app's life). */
export async function getToken(m: Messaging<any>, options: GetTokenOptions = {}): Promise<string> {
  if (m._native) {
    const vapidKey = options.vapidKey ?? m.app.config.messaging?.vapidKey;
    return fm.getToken(m._native, { ...options, ...(vapidKey ? { vapidKey } : {}) });
  }
  if (!m._token) {
    const r = await post<{ token: string }>(m.app, '/v1/fcm/register', {});
    m._token = r.token;
    listen(m);
  }
  return m._token;
}

export async function deleteToken(m: Messaging<any>): Promise<boolean> {
  if (m._native) return fm.deleteToken(m._native);
  if (!m._token) return false;
  const token = m._token;
  m._token = null;
  m._unlisten?.();
  m._unlisten = null;
  await post(m.app, '/v1/fcm/unregister', { token });
  return true;
}

/** Messages that arrive while the app is open (typed by kind). */
export function onMessage<Cfg extends AnyConfig>(m: Messaging<Cfg>, nextOrObserver: NextFn<MessagePayload<Cfg>> | Observer<MessagePayload<Cfg>>): Unsubscribe {
  const o: Observer<MessagePayload<Cfg>> = typeof nextOrObserver === 'function' ? { next: nextOrObserver } : nextOrObserver;
  if (m._native) return fm.onMessage(m._native, { next: (p) => o.next(typed(m, p)), error: (e) => o.error?.(e), complete: () => o.complete?.() });
  m._handlers.add(o);
  listen(m);
  return () => {
    m._handlers.delete(o);
    // No handler left: messages wait on the server until one listens again.
    if (m._handlers.size === 0) {
      m._unlisten?.();
      m._unlisten = null;
    }
  };
}

/** emulator: once there is a token and a handler, take the token's messages over the realtime socket. */
function listen(m: Messaging<any>): void {
  if (m._unlisten || !m._token || m._handlers.size === 0) return;
  const token = m._token;
  m._unlisten = realtimeOf(m.app).listen(
    'fcm',
    nextId(),
    { token },
    (msg) => {
      if (msg.t !== 'message') return;
      const p = typed(m, msg.payload as fm.MessagePayload);
      for (const h of m._handlers) h.next(p);
    },
    (e) => {
      m._unlisten = null;
      for (const h of m._handlers) h.error?.(e);
    },
  );
}
