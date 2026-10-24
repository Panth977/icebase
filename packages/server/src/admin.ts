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

// ─── realtime database ─────────────────────────────────────────────────────────

export function getAdminDatabase(app: IceBaseApp, url?: string): Database {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', 'getAdminDatabase(app) needs an app from initializeAdminApp(config, env)', { reason: 'config' });
  return service(app, `database:${url ?? ''}`, () => {
    const mode = app.modes.database;
    if (mode === 'emulator') return new Database(app, emulatorDatabaseDriver(app));
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
    return nativeGetStorage(nativeAdminApp(app));
  });
}
