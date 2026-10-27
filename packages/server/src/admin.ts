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
import type { AnyConfig, ClaimsOf, EnvOf, IceBaseConfig } from '@panth977/icebase/config';
import { createAdminDriver } from './drivers/firestore-admin.ts';
import { IceBaseError } from '@panth977/icebase/errors';
import { Firestore, firestoreDriverId, registerFirestoreDriver, type DocumentSnapshot } from '@panth977/icebase/firestore';
import { nativeAdminApp } from './internal/firebase-admin-app.ts';
import { collection as schemaCollection, validateWrite, type FieldMap } from '@panth977/icebase/schema';

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
    if (mode === 'vm') throw new IceBaseError('unimplemented', 'auth in vm mode is not built yet (phase 3)', { reason: 'mode', service: 'auth' });
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
    if (mode === 'vm') throw new IceBaseError('unimplemented', 'storage in vm mode is not built yet (phase 3)', { reason: 'mode', service: 'storage' });
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
  if (mode === 'vm') throw new IceBaseError('unimplemented', 'task queues in vm mode are not built yet', { reason: 'mode', service: 'functions' });
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

// ─── messaging ─────────────────────────────────────────────────────────────────

/** firebase-admin's Message (token / topic / condition + notification, data, webpush …). */
export type Message = import('firebase-admin/messaging').Message;

export interface AdminMessaging {
  /** Send one message; resolves to its message id. */
  send(message: Message): Promise<string>;
  sendEach(messages: Message[]): Promise<{ successCount: number; failureCount: number; responses: { success: boolean; messageId?: string; error?: Error }[] }>;
}

/** Push messages (Firebase Cloud Messaging). On the IceBase server they land in an outbox
 * (GET /__/icebase/messaging/outbox) — and are delivered by web push when config.messaging.webPush is set. */
export function getAdminMessaging(app: IceBaseApp): AdminMessaging {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'getAdminMessaging(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  return service(app, 'messaging', (): AdminMessaging => {
    if (app.modes.functions !== 'emulator') {
      const native = async () => (await import('firebase-admin/messaging')).getMessaging(nativeAdminApp(app));
      return {
        send: async (m) => (await native()).send(m),
        sendEach: async (ms) => {
          const r = await (await native()).sendEach(ms);
          return { successCount: r.successCount, failureCount: r.failureCount, responses: r.responses.map((x) => ({ success: x.success, ...(x.messageId ? { messageId: x.messageId } : {}), ...(x.error ? { error: x.error as Error } : {}) })) };
        },
      };
    }
    const post = async (m: Message) => {
      const { emulatorFetch } = await import('@panth977/icebase/app');
      const { callerToken } = await import('@panth977/icebase/internal');
      const token = await callerToken(app);
      const res = await emulatorFetch(`${emulatorOrigin(app)}/__/icebase/messaging/send`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ message: m }) });
      const j = (await res.json()) as { name?: string; error?: { code: string; message: string } };
      if (!res.ok || j.error) throw new IceBaseError((j.error?.code ?? 'internal') as IceBaseError['code'], j.error?.message ?? `messaging ${res.status}`, { service: 'messaging' });
      return j.name!;
    };
    return {
      send: post,
      sendEach: async (ms) => {
        const responses = await Promise.all(ms.map((m) => post(m).then((messageId) => ({ success: true, messageId }), (error: Error) => ({ success: false, error }))));
        return { successCount: responses.filter((r) => r.success).length, failureCount: responses.filter((r) => !r.success).length, responses };
      },
    };
  });
}
