// initializeApp(config, env, { firebaseApp }) against Firebase's emulators: a user signed in on the
// app's own Firebase app is the IceBase Auth's current user, IceBase's Firestore writes as that user,
// and deleting the IceBase app leaves the session alone.
import { afterAll, expect, it } from 'vitest';
import * as fb from 'firebase/app';
import * as fa from 'firebase/auth';
import * as fs from 'firebase/firestore';
import { deleteApp, initializeApp } from '@panth977/icebase/app';
import { getAuth } from '@panth977/icebase/auth';
import { defineConfig } from '@panth977/icebase/config';
import { collection, doc, getDoc, getFirestore, setDoc } from '@panth977/icebase/firestore';
import { collection as coll, defineSchema, f } from '@panth977/icebase/schema';

const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH || !FS) throw new Error('run under scripts/emu.sh (FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST not set)');
const [fsHost, fsPort] = FS.split(':') as [string, string];

const notes = coll('adoptNotes', { fields: { by: f.string() }, indexes: [] });
const cfg = defineConfig({
  name: 'adopt-emu',
  schema: defineSchema({ notes }),
  firebase: { projectId: 'demo-icebase' },
  environments: { test: { mode: 'firebase' } },
});

const native = fb.initializeApp({ apiKey: 'demo', projectId: 'demo-icebase', authDomain: 'localhost' }, 'adopt-emu-native');
const nativeAuth = fa.initializeAuth(native, { persistence: fa.inMemoryPersistence });
fa.connectAuthEmulator(nativeAuth, `http://${AUTH}`, { disableWarnings: true });
fs.connectFirestoreEmulator(fs.getFirestore(native), fsHost, Number(fsPort));
afterAll(() => fb.deleteApp(native));

it('keeps the signed-in user through IceBase and after deleteApp', async () => {
  const { user } = await fa.signInAnonymously(nativeAuth);
  const app = initializeApp(cfg, 'test', { name: 'adopt-emu', firebaseApp: native });
  const auth = getAuth(app);
  await auth.authStateReady();
  expect(auth.currentUser?.uid).toBe(user.uid);

  const db = getFirestore(app);
  const ref = doc(collection(db, notes), user.uid);
  await setDoc(ref, { by: user.uid });
  // Written through the adopted app's own Firestore instance.
  const raw = await fs.getDoc(fs.doc(fs.getFirestore(native), 'adoptNotes', user.uid));
  expect(raw.data()).toEqual({ by: user.uid });
  expect((await getDoc(ref)).data()).toEqual({ by: user.uid });

  await deleteApp(app);
  expect(nativeAuth.currentUser?.uid).toBe(user.uid);
});
