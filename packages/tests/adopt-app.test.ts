// initializeApp(config, env, { firebaseApp }): IceBase runs its firebase-mode services on a Firebase
// web app the caller already created (so its signed-in user stays signed in), never re-initializes
// its Auth, never deletes it, and refuses one from another project. No emulator needed: nothing here
// reaches Google (the sign-in round trip is in adopt-app.emu.test.ts).
import { describe, expect, it } from 'vitest';
import * as fb from 'firebase/app';
import * as fa from 'firebase/auth';
import * as fs from 'firebase/firestore';
import { deleteApp, initializeApp } from '@panth977/icebase/app';
import { getAuth } from '@panth977/icebase/auth';
import { defineConfig } from '@panth977/icebase/config';
import { getDatabase } from '@panth977/icebase/database';
import { getFirestore, initializeFirestore } from '@panth977/icebase/firestore';
import { getFunctions } from '@panth977/icebase/functions';
import { defineSchema } from '@panth977/icebase/schema';
import { getStorage } from '@panth977/icebase/storage';

const PROJECT = 'demo-adopt';
const webConfig = { apiKey: 'demo', projectId: PROJECT, appId: '1:1:web:1', databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`, storageBucket: `${PROJECT}.appspot.com` };
const cfg = defineConfig({
  name: 'adopt-unit',
  schema: defineSchema({}),
  firebase: { projectId: PROJECT, webConfig },
  environments: { prod: { mode: 'firebase' }, local: { mode: 'emulator' } },
});
// initializeFirestore refuses a database that is already initialized (with other settings).
const initialized = (app: fb.FirebaseApp, id: string) => {
  try {
    fs.initializeFirestore(app, { ignoreUndefinedProperties: true }, id);
    return false;
  } catch {
    return true;
  }
};

describe('adopting a Firebase app', () => {
  it('every firebase-mode service runs on the adopted app; Auth is the instance it already had', async () => {
    const native = fb.initializeApp(webConfig, 'adopt-native-1');
    const nativeAuth = fa.initializeAuth(native, { persistence: fa.inMemoryPersistence });
    const app = initializeApp(cfg, 'prod', { name: 'adopt-1', firebaseApp: native });

    expect(getAuth(app)._native).toBe(nativeAuth);
    expect(getStorage(app)._native.app).toBe(native);
    expect(getFunctions(app)._native.app).toBe(native);
    expect(getDatabase(app)._native?.app).toBe(native);
    getFirestore(app);
    getFirestore(app, 'other');
    expect(initialized(native, '(default)')).toBe(true);
    expect(initialized(native, 'other')).toBe(true);
    expect(initialized(native, 'never-used')).toBe(false);
    // IceBase made no app of its own.
    expect(fb.getApps().map((a) => a.name)).not.toContain('icebase:adopt-1');

    await deleteApp(app);
    // Still alive: options would throw 'app-deleted' otherwise.
    expect(fb.getApps()).toContain(native);
    expect(native.options.projectId).toBe(PROJECT);
    expect(fa.getAuth(native)).toBe(nativeAuth);
    await fb.deleteApp(native);
  });

  it('a Firestore the adopted app already initialized is used as it is', async () => {
    const native = fb.initializeApp(webConfig, 'adopt-native-2');
    const nativeDb = fs.initializeFirestore(native, { ignoreUndefinedProperties: true });
    const app = initializeApp(cfg, 'prod', { name: 'adopt-2', firebaseApp: native });
    // Other settings than the app used: Firebase would refuse a second initializeFirestore.
    initializeFirestore(app, { experimentalForceLongPolling: true } as never);
    expect(fs.getFirestore(native)).toBe(nativeDb);
    await deleteApp(app);
    await fb.deleteApp(native);
  });

  it('refuses an app of another project', async () => {
    const native = fb.initializeApp({ ...webConfig, projectId: 'someone-else' }, 'adopt-native-3');
    expect(() => initializeApp(cfg, 'prod', { name: 'adopt-3', firebaseApp: native })).toThrow(/project 'someone-else'.*firebase\.projectId is 'demo-adopt'/);
    await fb.deleteApp(native);
    const deleted = fb.initializeApp(webConfig, 'adopt-native-4');
    await fb.deleteApp(deleted);
    expect(() => initializeApp(cfg, 'prod', { name: 'adopt-4', firebaseApp: deleted })).toThrow(/was deleted/);
  });

  it('emulator mode ignores it: the emulator never takes over the adopted app', async () => {
    const native = fb.initializeApp({ ...webConfig, projectId: 'someone-else' }, 'adopt-native-5');
    const nativeAuth = fa.initializeAuth(native, { persistence: fa.inMemoryPersistence });
    const app = initializeApp(cfg, 'local', { name: 'adopt-5', firebaseApp: native, emulator: { port: 4999 } });
    const auth = getAuth(app);
    expect(auth._native).not.toBe(nativeAuth);
    expect(auth._native.app).not.toBe(native);
    expect(getStorage(app)._native.app).not.toBe(native);
    await deleteApp(app);
    expect(native.options.projectId).toBe('someone-else');
    await fb.deleteApp(native);
  });
});
