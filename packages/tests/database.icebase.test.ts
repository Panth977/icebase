// Realtime Database conformance, emulator mode: the IceBase server, client and admin.
import { afterAll } from 'vitest';
import { getAdminDatabase, initializeAdminApp } from '@panth977/icebase-server/admin';
import { initializeApp } from '@panth977/icebase/app';
import { getDatabase } from '@panth977/icebase/database';
import { startEmulator } from '@panth977/icebase-cli/emulator';
import { databaseConfig, databaseSuite } from './suites/database.suite.js';

const boot = startEmulator({ config: databaseConfig('emulator'), port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
afterAll(async () => (await boot).close());

databaseSuite('emulator mode · IceBase client', async (tag) => {
  const config = databaseConfig('emulator', (await boot).port);
  const app = initializeApp(config, 'test', { name: `db-${tag}`, firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
  return { app, db: getDatabase(app) };
});

databaseSuite('emulator mode · IceBase admin', async (tag) => {
  const config = databaseConfig('emulator', (await boot).port);
  const app = initializeAdminApp(config, 'test', { name: `db-${tag}` });
  return { app, db: getAdminDatabase(app) };
});
