// Realtime Database conformance, firebase mode: Firebase's database emulator (web SDK + admin).
import { beforeAll } from 'vitest';
import { getAdminDatabase, initializeAdminApp } from '../src/admin.js';
import { initializeApp } from '../src/app.js';
import { connectDatabaseEmulator, databaseRulesJson, getDatabase } from '../src/database.js';
import { counter, databaseConfig, databaseSuite, messages, presence } from './suites/database.suite.js';

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!HOST) throw new Error('run under scripts/emu.sh with database');
const [host, port] = HOST.split(':') as [string, string];
const config = databaseConfig('firebase');

beforeAll(async () => {
  // The emulator enforces .indexOn like production; deploy the generated rules to both namespaces
  // (the web app uses demo-icebase, admin the one in config.firebase.databaseURL).
  const rules = databaseRulesJson({ messages, presence, counter }, { rules: { '.read': true, '.write': true } });
  for (const ns of ['demo-icebase', 'demo-icebase-default-rtdb']) {
    const r = await fetch(`http://${HOST}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { authorization: 'Bearer owner' }, body: JSON.stringify(rules) });
    if (!r.ok) throw new Error(`rules PUT ${r.status}`);
  }
});

databaseSuite('firebase mode · web SDK', async (tag) => {
  const app = initializeApp(config, 'test', { name: `db-${tag}`, firebase: { apiKey: 'demo', projectId: 'demo-icebase', databaseURL: `http://${HOST}?ns=demo-icebase` } });
  const db = getDatabase(app);
  connectDatabaseEmulator(db, host, Number(port));
  return { app, db };
});

databaseSuite('firebase mode · firebase-admin', async (tag) => {
  const app = initializeAdminApp(config, 'test', { name: `db-${tag}` });
  return { app, db: getAdminDatabase(app) };
});
