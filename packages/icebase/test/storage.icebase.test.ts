// Storage conformance, emulator mode: the IceBase server (Firebase REST v0 + GCS JSON API).
import { initializeAdminApp } from '../src/admin.js';
import { initializeApp } from '../src/app.js';
import { startEmulator } from '../src/emulator/server.js';
import { getStorage } from '../src/storage.js';
import { BUCKET, storageConfig, storageSuite } from './suites/storage.suite.js';

storageSuite('emulator mode · IceBase', async () => {
  const emu = await startEmulator({ config: storageConfig('emulator'), port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
  const config = storageConfig('emulator', emu.port);
  const app = initializeApp(config, 'test', { name: 'st-web', firebase: { apiKey: 'demo', projectId: 'demo-icebase', storageBucket: BUCKET } });
  return { app, admin: initializeAdminApp(config, 'test', { name: 'st-admin' }), storage: getStorage(app), close: () => emu.close() };
});
