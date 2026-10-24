// Storage conformance, firebase mode: Firebase's storage emulator.
import { initializeAdminApp } from '../src/admin.js';
import { initializeApp } from '../src/app.js';
import { connectStorageEmulator, getStorage } from '../src/storage.js';
import { BUCKET, storageConfig, storageSuite } from './suites/storage.suite.js';

const HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
if (!HOST) throw new Error('run under scripts/emu.sh with storage');
const [host, port] = HOST.replace(/^https?:\/\//, '').split(':') as [string, string];
const config = storageConfig('firebase');

storageSuite('firebase mode', async () => {
  const app = initializeApp(config, 'test', { name: 'st-web', firebase: { apiKey: 'demo', projectId: 'demo-icebase', storageBucket: BUCKET } });
  const storage = getStorage(app);
  connectStorageEmulator(storage, host, Number(port));
  return { app, admin: initializeAdminApp(config, 'test', { name: 'st-admin' }), storage };
});
