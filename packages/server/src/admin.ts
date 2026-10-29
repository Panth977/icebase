// icebase/admin — server/backend access that bypasses rules (like firebase-admin). The typed
// query API is icebase/firestore's: the same functions take an admin Firestore.

import type { Credential } from 'firebase-admin/app';
import { getAuth as nativeGetAuth, type Auth as NativeAdminAuth } from 'firebase-admin/auth';
import { getDatabase as nativeGetDatabase, getDatabaseWithUrl } from 'firebase-admin/database';
import { getStorage as nativeGetStorage, type Storage as NativeAdminStorage } from 'firebase-admin/storage';
import { Database } from '@panth977/icebase/database';
import { adminDatabaseDriver } from './drivers/database-admin.ts';
import { emulatorDatabaseDriver } from '@panth977/icebase/internal';
import { createApp, emulatorOrigin, service, type IceBaseApp, type IceBaseAppOptions } from '@panth977/icebase/app';
import type { AnyConfig, ClaimsOf, EnvOf, IceBaseConfig, MessageKinds, MessageKindsOf, RemoteConfigParams } from '@panth977/icebase/config';
import { checkMessage, checkTemplate, encodeMessageData, type RemoteConfigTemplate, type RemoteConfigVersion } from '@panth977/icebase/internal';
import { createAdminDriver } from './drivers/firestore-admin.ts';
import { IceBaseError } from '@panth977/icebase/errors';
import { Firestore, firestoreDriverId, registerFirestoreDriver, type DocumentSnapshot } from '@panth977/icebase/firestore';
import { nativeAdminApp } from './internal/firebase-admin-app.ts';
import { collection as schemaCollection, validateWrite, type FieldMap, type Infer } from '@panth977/icebase/schema';

export { cert, applicationDefault, refreshToken } from 'firebase-admin/app';
export { deleteApp } from '@panth977/icebase/app';

registerFirestoreDriver('admin:firebase', createAdminDriver);

export interface AdminAppOptions extends IceBaseAppOptions {
  /** Overrides config.firebase.serviceAccountEnv. */
  credential?: Credential;
  /** firebase mode: use this firebase-admin app (its project, credential and settings) instead of making one. */
  firebaseAdminApp?: import('firebase-admin/app').App;
}

/** initializeAdminApp(config, 'prod') — server side; picks the mode per service like initializeApp. */
export function initializeAdminApp<Cfg extends IceBaseConfig<any, any>>(config: Cfg, env: EnvOf<Cfg>, options?: AdminAppOptions): IceBaseApp<Cfg> {
  return createApp(config as AnyConfig, env, 'admin', options) as unknown as IceBaseApp<Cfg>;
}

export function getAdminFirestore(app: IceBaseApp, databaseId = '(default)'): Firestore {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'getAdminFirestore(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  return service(app, `firestore:${databaseId}`, () => new Firestore(app, databaseId, firestoreDriverId(app)));
}

/** Admin-only Firestore extras (same as firebase-admin's Firestore methods). */
export async function getAll(db: Firestore, ...refs: { path: string }[]): Promise<DocumentSnapshot<unknown>[]> {
  const { DocumentSnapshot, docFromPath } = await import('@panth977/icebase/firestore');
  const raws = await need(db, 'getAll')(refs.map((r) => r.path));
  return raws.map((r) => new DocumentSnapshot(docFromPath(db, r.path), r));
}

export async function listCollections(db: Firestore, docRef?: { path: string }): Promise<string[]> {
  return need(db, 'listCollections')(docRef?.path ?? null);
}

export async function recursiveDelete(db: Firestore, ref: { path: string }): Promise<void> {
  return need(db, 'recursiveDelete')(ref.path);
}

function need<K extends 'getAll' | 'listCollections' | 'recursiveDelete'>(db: Firestore, k: K): NonNullable<Firestore['_driver'][K]> {
  const f = db._driver[k];
  if (!f) throw new IceBaseError('invalid-argument', `${k}() needs an admin Firestore (getAdminFirestore)`, { reason: 'config' });
  return f.bind(db._driver) as NonNullable<Firestore['_driver'][K]>;
}

// ─── auth ──────────────────────────────────────────────────────────────────────


/** firebase-admin's Auth, with custom claims typed and validated against config.auth.claims. */
export type AdminAuth<C = Record<string, unknown>> = Omit<NativeAdminAuth, 'setCustomUserClaims'> & {
  setCustomUserClaims(uid: string, claims: C | null): Promise<void>;
};

export function getAdminAuth<Cfg extends AnyConfig>(app: IceBaseApp<Cfg>): AdminAuth<ClaimsOf<Cfg>> {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'getAdminAuth(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  return service(app, 'auth', () => {
    const mode = app.modes.auth;
    if (mode === 'emulator') {
      // firebase-admin reads this at call time; the IceBase server speaks the same API.
      // One process talks to one emulator: the latest admin app's wins.
      const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
      if (env) env.FIREBASE_AUTH_EMULATOR_HOST = emulatorOrigin(app).replace(/^https?:\/\//, '');
    }
    const native = nativeGetAuth(nativeAdminApp(app));
    const claims = app.config.auth?.claims as FieldMap | undefined;
    const claimsColl = claims ? schemaCollection('__claims__x', { fields: claims, indexes: [] }) : null;
    const typed = Object.create(native) as AdminAuth<ClaimsOf<Cfg>>;
    if (mode === 'emulator') {
      // The IceBase server may sign its tokens; firebase-admin's emulator path only reads unsigned ones.
      const call = async <R>(path: string, body: unknown): Promise<R> => {
        const { emulatorFetch } = await import('@panth977/icebase/app');
        const { callerToken } = await import('@panth977/icebase/internal');
        const token = await callerToken(app);
        const res = await emulatorFetch(`${emulatorOrigin(app)}/__/icebase/admin/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
        const j = (await res.json()) as R & { error?: { code: string; message: string } };
        if (!res.ok || j.error) throw Object.assign(new Error(j.error?.message ?? `auth ${res.status}`), { code: j.error?.code ?? 'auth/internal-error' });
        return j;
      };
      // firebase-admin sends 'Bearer owner' to an emulator; this server's admin token may be another.
      const http = (native as unknown as { authRequestHandler?: { httpClient?: { getToken?: () => Promise<string> } } }).authRequestHandler?.httpClient;
      if (http?.getToken) {
        http.getToken = async () => {
          const { callerToken } = await import('@panth977/icebase/internal');
          return (await callerToken(app)) ?? 'owner';
        };
      }
      typed.verifyIdToken = async (idToken: string, checkRevoked?: boolean) => (await call<{ claims: never }>('verifyIdToken', { idToken, checkRevoked: !!checkRevoked })).claims;
      typed.createCustomToken = async (uid: string, claims?: object) => (await call<{ token: string }>('createCustomToken', { uid, ...(claims ? { claims } : {}) })).token;
    }
    typed.setCustomUserClaims = async (uid: string, c: ClaimsOf<Cfg> | null) => {
      if (c !== null && claimsColl) {
        try {
          validateWrite(claimsColl, c, 'merge');
        } catch (e) {
          throw new IceBaseError('invalid-argument', `setCustomUserClaims(${uid}): the claims do not match config.auth.claims:\n${(e as Error).message.split('\n').slice(1).join('\n')}`, { reason: 'schema' });
        }
      }
      return native.setCustomUserClaims(uid, c as object | null);
    };
    return typed;
  });
}

/** A user brought from another system (emulator mode: the IceBase server). */
export interface ImportedUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  photoURL?: string;
  phoneNumber?: string;
  /** IceBase's scrypt$salt$key or scrypt$N$r$p$salt$key (base64url): the password keeps working. */
  passwordHash?: string;
  disabled?: boolean;
  customClaims?: Record<string, unknown>;
  /** Sign-in methods it had ('password', 'emailLink' …). */
  providers?: string[];
  createdAt?: string | number;
  lastSignInAt?: string | number;
  tokensValidAfter?: string | number;
}

/** Bring users into the IceBase server's auth with their uids (a migration); no events fire. */
export async function importAuthUsers(app: IceBaseApp, users: ImportedUser[], opts: { overwrite?: boolean } = {}): Promise<{ uid: string; ok: boolean; error?: string }[]> {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'importAuthUsers(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  if (app.modes.auth !== 'emulator') throw new IceBaseError('unimplemented', "importAuthUsers is the IceBase server's; on Firebase use firebase-admin's importUsers", { reason: 'mode', service: 'auth' });
  const { emulatorFetch } = await import('@panth977/icebase/app');
  const { callerToken } = await import('@panth977/icebase/internal');
  const token = await callerToken(app);
  const res = await emulatorFetch(`${emulatorOrigin(app)}/__/icebase/admin/auth/import`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ users, overwrite: !!opts.overwrite }) });
  const j = (await res.json()) as { results?: { uid: string; ok: boolean; error?: string }[]; error?: { message: string } };
  if (!res.ok || !j.results) throw new IceBaseError('internal', `importAuthUsers: ${j.error?.message ?? res.status}`, { service: 'auth' });
  return j.results;
}

// ─── realtime database ─────────────────────────────────────────────────────────

export function getAdminDatabase(app: IceBaseApp, url?: string): Database {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'getAdminDatabase(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  return service(app, `database:${url ?? ''}`, () => {
    const mode = app.modes.database;
    if (mode === 'emulator') return new Database(app, emulatorDatabaseDriver(app, url));
    if (mode !== 'firebase') throw new IceBaseError('unimplemented', `the Realtime Database in ${mode} mode is not available yet`, { reason: 'mode', service: 'database' });
    const native = url ? getDatabaseWithUrl(url, nativeAdminApp(app)) : nativeGetDatabase(nativeAdminApp(app));
    return new Database(app, adminDatabaseDriver(native));
  });
}

// ─── storage ───────────────────────────────────────────────────────────────────

export { getDownloadURL } from 'firebase-admin/storage';

/** firebase-admin's Storage (buckets and files from @google-cloud/storage). Bypasses storage.rules. */
export function getAdminStorage(app: IceBaseApp): NativeAdminStorage {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'getAdminStorage(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  return service(app, 'storage', () => {
    const mode = app.modes.storage;
    if (mode === 'emulator') {
      const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
      if (env) env.FIREBASE_STORAGE_EMULATOR_HOST = emulatorOrigin(app).replace(/^https?:\/\//, '');
    }
    const native = nativeGetStorage(nativeAdminApp(app));
    if (mode === 'emulator') {
      // The IceBase server's GCS API is the admin's: every request carries the admin token.
      const token = app.options.emulator?.adminToken ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_ADMIN_TOKEN ?? 'owner';
      const client = (native as unknown as { storageClient?: { interceptors?: { request(o: { headers?: Record<string, string> }): unknown }[] } }).storageClient;
      client?.interceptors?.push({ request: (o) => ({ ...o, headers: { ...o.headers, authorization: `Bearer ${token}` } }) });
      // Resumable uploads go through the auth client itself.
      const auth = (client as { authClient?: { request?: (o: { headers?: Record<string, string> }) => unknown } } | undefined)?.authClient;
      if (auth?.request) {
        const request = auth.request.bind(auth);
        auth.request = (o) => request({ ...o, headers: { ...o.headers, authorization: `Bearer ${token}` } });
      }
      // getSignedUrl needs a service account; the IceBase server signs instead. The URL is on
      // ICEBASE_PUBLIC_URL (the address people reach, e.g. https://tt.example.com), else the server's.
      const origin = emulatorOrigin(app);
      const bucketOf = native.bucket.bind(native);
      native.bucket = ((name?: string) => {
        const b = bucketOf(name);
        const fileOf = b.file.bind(b);
        b.file = ((fileName: string, o?: unknown) => {
          const f = fileOf(fileName, o as never);
          f.getSignedUrl = (async (cfg: { action: string; expires: string | number | Date; contentType?: string }) => {
            const { emulatorFetch } = await import('@panth977/icebase/app');
            const expires = new Date(cfg.expires).getTime();
            const res = await emulatorFetch(`${origin}/__/icebase/storage/sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ bucket: b.name, name: fileName, action: cfg.action === 'write' ? 'write' : 'read', expires, ...(cfg.contentType ? { contentType: cfg.contentType } : {}) }) });
            const j = (await res.json()) as { path?: string; error?: { message: string } };
            if (!res.ok || !j.path) throw new IceBaseError('internal', `getSignedUrl: ${j.error?.message ?? res.status}`, { service: 'storage' });
            const pub = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_PUBLIC_URL;
            return [`${(pub ?? origin).replace(/\/+$/, '')}${j.path}`];
          }) as never;
          return f;
        }) as typeof b.file;
        return b;
      }) as typeof native.bucket;
    }
    return native;
  });
}

// ─── task queues ───────────────────────────────────────────────────────────────

export interface EnqueueOptions {
  /** Run no sooner than this many seconds from now. */
  scheduleDelaySeconds?: number;
  /** Or at this time. */
  scheduleTime?: Date;
  /** A task id: enqueuing the same id twice fails (dedupe). */
  id?: string;
  dispatchDeadlineSeconds?: number;
}

export interface TaskQueue<T = unknown> {
  enqueue(data: T, opts?: EnqueueOptions): Promise<void>;
}

/** The queue of an onTaskDispatched function: taskQueue(app, 'resizeImage').enqueue({ path }). */
export function taskQueue<T = unknown>(app: IceBaseApp, functionName: string, opts: { region?: string } = {}): TaskQueue<T> {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'taskQueue(app, name) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  const region = opts.region ?? app.config.functions?.region ?? 'us-central1';
  const mode = app.modes.functions;
  if (mode === 'emulator') {
    return {
      async enqueue(data, o = {}) {
        const { emulatorFetch } = await import('@panth977/icebase/app');
        const { callerToken } = await import('@panth977/icebase/internal');
        const token = await callerToken(app);
        const res = await emulatorFetch(`${emulatorOrigin(app)}/__/icebase/tasks/enqueue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ name: functionName, data, ...(o.id ? { id: o.id } : {}), ...(o.scheduleDelaySeconds !== undefined ? { scheduleDelaySeconds: o.scheduleDelaySeconds } : {}), ...(o.scheduleTime ? { scheduleTime: o.scheduleTime.toISOString() } : {}) }),
        });
        const j = (await res.json()) as { error?: { code: string; message: string } };
        if (!res.ok || j.error) throw new IceBaseError((j.error?.code ?? 'internal') as IceBaseError['code'], j.error?.message ?? `enqueue ${res.status}`, { service: 'functions' });
      },
    };
  }
  return {
    async enqueue(data, o = {}) {
      const { getFunctions } = await import('firebase-admin/functions');
      const q = getFunctions(nativeAdminApp(app)).taskQueue(`locations/${region}/functions/${functionName}`);
      await q.enqueue(data as Record<string, unknown>, {
        ...(o.scheduleDelaySeconds !== undefined ? { scheduleDelaySeconds: o.scheduleDelaySeconds } : {}),
        ...(o.scheduleTime ? { scheduleTime: o.scheduleTime } : {}),
        ...(o.id ? { id: o.id } : {}),
        ...(o.dispatchDeadlineSeconds !== undefined ? { dispatchDeadlineSeconds: o.dispatchDeadlineSeconds } : {}),
      } as never);
    },
  };
}

// ─── the IceBase server's admin endpoints ───────────────────────────────────────

async function onServer<T>(app: IceBaseApp, path: string, body: unknown, service: string): Promise<T> {
  const { emulatorFetch } = await import('@panth977/icebase/app');
  const { callerToken } = await import('@panth977/icebase/internal');
  const token = await callerToken(app);
  const res = await emulatorFetch(`${emulatorOrigin(app)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: { code: string; message: string } };
  if (!res.ok || j.error) throw new IceBaseError((j.error?.code ?? 'internal') as IceBaseError['code'], j.error?.message ?? `${service} ${res.status}`, { service });
  return j;
}
const manageOp = <T>(app: IceBaseApp, svc: string, op: string, body: Record<string, unknown> = {}): Promise<T> => onServer<T>(app, `/__/icebase/admin/manage/${svc}/${op}`, body, svc);

// ─── messaging ─────────────────────────────────────────────────────────────────

/** firebase-admin's Message (token / topic / condition + notification, data, webpush …). */
export type Message = import('firebase-admin/messaging').Message;
export type MulticastMessage = import('firebase-admin/messaging').MulticastMessage;
export interface SendResponse {
  success: boolean;
  messageId?: string;
  error?: Error;
}
export interface BatchResponse {
  successCount: number;
  failureCount: number;
  responses: SendResponse[];
}
export interface MessagingTopicManagementResponse {
  successCount: number;
  failureCount: number;
  errors: { index: number; error: { code: string; message: string } }[];
}

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Kinds<Cfg> = MessageKindsOf<Cfg>;
/** A message's data: one declared kind with its typed data, or (no kinds declared) FCM's string map. */
export type MessageData<Cfg> = [keyof Kinds<Cfg>] extends [never]
  ? { kind?: undefined; data?: Record<string, string> }
  : { [K in keyof Kinds<Cfg> & string]: { kind: K; data: Kinds<Cfg>[K] extends FieldMap ? Infer<Kinds<Cfg>[K]> : never } }[keyof Kinds<Cfg> & string] | { kind?: undefined; data?: undefined };
/** firebase-admin's Message with `kind` + typed `data` (config.messaging.messages). */
export type TypedMessage<Cfg = AnyConfig> = DistOmit<Message, 'data'> & MessageData<Cfg>;
export type TypedMulticastMessage<Cfg = AnyConfig> = Omit<MulticastMessage, 'data'> & MessageData<Cfg>;

export interface AdminMessaging<Cfg = AnyConfig> {
  /** Send one message; resolves to its message id (projects/<p>/messages/<id>). */
  send(message: TypedMessage<Cfg>, dryRun?: boolean): Promise<string>;
  sendEach(messages: TypedMessage<Cfg>[], dryRun?: boolean): Promise<BatchResponse>;
  sendEachForMulticast(message: TypedMulticastMessage<Cfg>, dryRun?: boolean): Promise<BatchResponse>;
  subscribeToTopic(tokens: string | string[], topic: string): Promise<MessagingTopicManagementResponse>;
  unsubscribeFromTopic(tokens: string | string[], topic: string): Promise<MessagingTopicManagementResponse>;
}

/** A typed message as FCM's (kind folded into data), checked against config.messaging.messages. */
export function messageToWire(config: AnyConfig, m: { kind?: string; data?: unknown } & Record<string, unknown>, opts: { multicast?: boolean } = {}): Record<string, unknown> {
  const kinds = (config.messaging?.messages ?? {}) as MessageKinds;
  const { kind, ...rest } = m;
  const wire: Record<string, unknown> = kind !== undefined ? { ...rest, data: encodeMessageData(kinds, kind, m.data) } : rest;
  checkMessage(kinds, wire, opts);
  return wire;
}

/**
 * Push messages (Firebase Cloud Messaging), typed by config.messaging.messages. firebase mode:
 * firebase-admin. On the IceBase server: delivered to the apps listening (icebase/messaging
 * onMessage) and kept in an outbox (GET /__/icebase/messaging/outbox, the console).
 */
export function getAdminMessaging<Cfg extends AnyConfig>(app: IceBaseApp<Cfg>): AdminMessaging<Cfg> {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'getAdminMessaging(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  return service(app, 'messaging', (): AdminMessaging<Cfg> => {
    const wire = (m: unknown, multicast = false) => messageToWire(app.config, m as Record<string, unknown>, { multicast });
    const list = (t: string | string[]) => (Array.isArray(t) ? t : [t]);
    const batch = (responses: SendResponse[]): BatchResponse => ({ successCount: responses.filter((r) => r.success).length, failureCount: responses.filter((r) => !r.success).length, responses });
    if (app.modes.messaging === 'firebase') {
      const native = async () => (await import('firebase-admin/messaging')).getMessaging(nativeAdminApp(app));
      const fromNative = (r: { responses: { success: boolean; messageId?: string; error?: unknown }[] }) => batch(r.responses.map((x) => ({ success: x.success, ...(x.messageId ? { messageId: x.messageId } : {}), ...(x.error ? { error: x.error as Error } : {}) })));
      const topics = (r: { successCount: number; failureCount: number; errors: { index: number; error: { code: string; message: string } }[] }): MessagingTopicManagementResponse => ({ successCount: r.successCount, failureCount: r.failureCount, errors: r.errors.map((e) => ({ index: e.index, error: { code: e.error.code, message: e.error.message } })) });
      return {
        // Checked before firebase-admin is reached.
        send: async (m, dryRun) => {
          const w = wire(m) as unknown as Message;
          return (await native()).send(w, dryRun);
        },
        sendEach: async (ms, dryRun) => {
          const w = ms.map((m) => wire(m) as unknown as Message);
          return fromNative(await (await native()).sendEach(w, dryRun));
        },
        sendEachForMulticast: async (m, dryRun) => {
          const w = wire(m, true) as unknown as MulticastMessage;
          return fromNative(await (await native()).sendEachForMulticast(w, dryRun));
        },
        subscribeToTopic: async (t, topic) => topics(await (await native()).subscribeToTopic(list(t), topic)),
        unsubscribeFromTopic: async (t, topic) => topics(await (await native()).unsubscribeFromTopic(list(t), topic)),
      };
    }
    const post = async (m: Record<string, unknown>, dryRun?: boolean) => (await onServer<{ name: string }>(app, '/__/icebase/messaging/send', { message: m, ...(dryRun ? { dryRun } : {}) }, 'messaging')).name;
    const each = (ms: Record<string, unknown>[], dryRun?: boolean) => Promise.all(ms.map((m) => post(m, dryRun).then((messageId): SendResponse => ({ success: true, messageId }), (error: Error): SendResponse => ({ success: false, error })))).then(batch);
    return {
      send: async (m, dryRun) => post(wire(m), dryRun),
      sendEach: async (ms, dryRun) => {
        // Like firebase-admin: a malformed message fails the whole call, before anything is sent.
        const w = ms.map((m) => wire(m));
        return each(w, dryRun);
      },
      sendEachForMulticast: async (m, dryRun) => {
        const { tokens, ...rest } = wire(m, true) as { tokens: string[] } & Record<string, unknown>;
        return each(tokens.map((token) => ({ ...rest, token })), dryRun);
      },
      subscribeToTopic: (t, topic) => manageOp(app, 'messaging', 'subscribe', { tokens: list(t), topic }),
      unsubscribeFromTopic: (t, topic) => manageOp(app, 'messaging', 'unsubscribe', { tokens: list(t), topic }),
    };
  });
}

// ─── Remote Config ─────────────────────────────────────────────────────────────

export type { RemoteConfigTemplate, RemoteConfigTemplateParameter, RemoteConfigParameterValue, RemoteConfigCondition, RemoteConfigVersion } from '@panth977/icebase/internal';

export interface AdminRemoteConfig {
  getTemplate(): Promise<RemoteConfigTemplate>;
  getTemplateAtVersion(versionNumber: number | string): Promise<RemoteConfigTemplate>;
  /** Checks the template against config.remoteConfig.parameters (and, on Firebase, with Firebase). */
  validateTemplate(template: RemoteConfigTemplate): Promise<RemoteConfigTemplate>;
  /** Publishes it (checked against the declarations first). Fails when the template changed since its etag, unless force. */
  publishTemplate(template: RemoteConfigTemplate, options?: { force: boolean }): Promise<RemoteConfigTemplate>;
  rollback(versionNumber: number | string): Promise<RemoteConfigTemplate>;
  listVersions(options?: { pageSize?: number }): Promise<{ versions: RemoteConfigVersion[] }>;
  createTemplateFromJSON(json: string): RemoteConfigTemplate;
}

/**
 * Remote Config templates (firebase-admin's API), checked against config.remoteConfig.parameters:
 * a parameter that is not declared, or a value that is not of its declared type, is refused.
 * firebase mode: firebase-admin. On the IceBase server: kept with its versions (no conditions).
 */
export function getAdminRemoteConfig(app: IceBaseApp): AdminRemoteConfig {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'getAdminRemoteConfig(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  return service(app, 'remoteConfig', (): AdminRemoteConfig => {
    const params = (app.config.remoteConfig?.parameters ?? {}) as RemoteConfigParams;
    const createTemplateFromJSON = (json: string): RemoteConfigTemplate => {
      let t: RemoteConfigTemplate;
      try {
        t = JSON.parse(json) as RemoteConfigTemplate;
      } catch {
        throw new IceBaseError('invalid-argument', 'createTemplateFromJSON: not JSON', { service: 'remoteConfig' });
      }
      return { conditions: t.conditions ?? [], parameters: t.parameters ?? {}, parameterGroups: t.parameterGroups ?? {}, etag: t.etag, ...(t.version ? { version: t.version } : {}) };
    };
    if (app.modes.remoteConfig === 'firebase') {
      const native = async () => (await import('firebase-admin/remote-config')).getRemoteConfig(nativeAdminApp(app));
      const plain = (t: unknown) => JSON.parse(JSON.stringify(t)) as RemoteConfigTemplate;
      return {
        getTemplate: async () => plain(await (await native()).getTemplate()),
        getTemplateAtVersion: async (v) => plain(await (await native()).getTemplateAtVersion(v)),
        async validateTemplate(t) {
          checkTemplate(params, t);
          return plain(await (await native()).validateTemplate(t as never));
        },
        async publishTemplate(t, o) {
          checkTemplate(params, t);
          return plain(await (await native()).publishTemplate(t as never, o));
        },
        rollback: async (v) => plain(await (await native()).rollback(v)),
        listVersions: async (o) => plain(await (await native()).listVersions(o)) as unknown as { versions: RemoteConfigVersion[] },
        createTemplateFromJSON,
      };
    }
    const op = <T>(name: string, body: Record<string, unknown> = {}) => manageOp<T>(app, 'remoteConfig', name, body);
    return {
      getTemplate: () => op('getTemplate'),
      getTemplateAtVersion: (v) => op('getTemplateAtVersion', { versionNumber: String(v) }),
      async validateTemplate(t) {
        checkTemplate(params, t, { conditions: false });
        return op('validateTemplate', { template: t });
      },
      async publishTemplate(t, o) {
        checkTemplate(params, t, { conditions: false });
        return op('publishTemplate', { template: t, force: !!o?.force });
      },
      rollback: (v) => op('rollback', { versionNumber: String(v) }),
      listVersions: (o) => op('listVersions', { ...(o?.pageSize ? { pageSize: o.pageSize } : {}) }),
      createTemplateFromJSON,
    };
  });
}

// ─── App Check ─────────────────────────────────────────────────────────────────

export interface AppCheckToken {
  token: string;
  ttlMillis: number;
}
export interface VerifyAppCheckTokenResponse {
  appId: string;
  token: { sub: string; app_id?: string; aud: string[]; iss: string; exp: number; iat: number; [k: string]: unknown };
  alreadyConsumed?: boolean;
}
export interface AdminAppCheck {
  /** An App Check token for an app (e.g. for a custom provider's backend). */
  createToken(appId: string, options?: { ttlMillis?: number }): Promise<AppCheckToken>;
  /** Verify a token from X-Firebase-AppCheck: resolves to its app, rejects when it is invalid or expired. */
  verifyToken(appCheckToken: string, options?: { consume?: boolean }): Promise<VerifyAppCheckTokenResponse>;
}

/** App Check's admin API (firebase-admin's). On the IceBase server: the tokens it issues. */
export function getAdminAppCheck(app: IceBaseApp): AdminAppCheck {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'getAdminAppCheck(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  return service(app, 'appCheck', (): AdminAppCheck => {
    if (app.modes.appCheck === 'firebase') {
      const native = async () => (await import('firebase-admin/app-check')).getAppCheck(nativeAdminApp(app));
      return {
        createToken: async (appId, o) => (await native()).createToken(appId, o),
        verifyToken: async (t, o) => (await (await native()).verifyToken(t, o)) as unknown as VerifyAppCheckTokenResponse,
      };
    }
    return {
      createToken: (appId, o) => manageOp(app, 'appCheck', 'createToken', { appId, ...(o?.ttlMillis !== undefined ? { ttlMillis: o.ttlMillis } : {}) }),
      verifyToken: (token) => manageOp(app, 'appCheck', 'verifyToken', { token }),
    };
  });
}
