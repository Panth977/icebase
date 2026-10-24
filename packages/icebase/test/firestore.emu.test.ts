// Firestore conformance, firebase mode: the official Firestore emulator through the web SDK
// and firebase-admin. Run with: npm run test:emu -w icebase
import { initializeApp as rawAdminApp } from 'firebase-admin/app';
import { getFirestore as rawAdminFirestore } from 'firebase-admin/firestore';
import { getAdminFirestore, initializeAdminApp } from '../src/admin.js';
import { initializeApp } from '../src/app.js';
import { connectFirestoreEmulator, getFirestore } from '../src/firestore.js';
import { firestoreConfig, firestoreSuite } from './suites/firestore.suite.js';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST) throw new Error('run under scripts/emu.sh (FIRESTORE_EMULATOR_HOST is not set)');
const [host, port] = HOST.split(':') as [string, string];
const config = firestoreConfig('firebase');
const raw = rawAdminFirestore(rawAdminApp({ projectId: 'demo-icebase' }, 'raw-writes'));
const rawSet = async (path: string, data: Record<string, unknown>) => void (await raw.doc(path).set(data));

firestoreSuite('firebase mode · web SDK', 'client', async (tag) => {
  const app = initializeApp(config, 'test', { name: tag, firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, host, Number(port));
  return { app, db, rawSet };
});

firestoreSuite('firebase mode · firebase-admin', 'admin', async (tag) => {
  const app = initializeAdminApp(config, 'test', { name: tag });
  return { app, db: getAdminFirestore(app), rawSet };
});
