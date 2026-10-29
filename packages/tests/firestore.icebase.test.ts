// Firestore conformance, emulator mode: the IceBase server (SQLite) in-process, through the
// IceBase client and admin. Same suite as firestore.emu.test.ts runs against Firebase.
import { afterAll } from 'vitest';
import { getAdminFirestore, initializeAdminApp } from '@panth977/icebase-server/admin';
import { initializeApp } from '@panth977/icebase/app';
import { startEmulator } from '@panth977/icebase-cli/emulator';
import { encode } from '@panth977/icebase/internal';
import { getFirestore } from '@panth977/icebase/firestore';
import { firestoreConfig, firestoreSuite } from './suites/firestore.suite.js';

const boot = async () => {
  const emu = await startEmulator({ config: firestoreConfig('emulator'), port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
  const config = firestoreConfig('emulator', emu.port);
  const rawSet = async (path: string, data: Record<string, unknown>) => void (await emu.context.firestore.commit([{ op: 'set', path, data: encode(data) as never }]));
  return { emu, config, rawSet };
};
let shared: Promise<Awaited<ReturnType<typeof boot>>> | null = null;
const once = () => (shared ??= boot());
afterAll(async () => {
  if (shared) await (await shared).emu.close();
});

firestoreSuite('emulator mode · IceBase client', 'client', async (tag) => {
  const { config, rawSet } = await once();
  const app = initializeApp(config, 'test', { name: tag, firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
  return { app, db: getFirestore(app), rawSet };
});

firestoreSuite('emulator mode · IceBase admin', 'admin', async (tag) => {
  const { config, rawSet } = await once();
  const app = initializeAdminApp(config, 'test', { name: tag });
  return { app, db: getAdminFirestore(app), rawSet };
});
