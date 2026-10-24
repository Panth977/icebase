// compat Firestore, emulator mode: the IceBase server in-process.
import { afterAll } from 'vitest';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { startEmulator } from '@panth977/icebase-cli/emulator';
import { compatConfig, compatSuite } from './suites/compat.suite.js';

let emu: Awaited<ReturnType<typeof startEmulator>> | null = null;
afterAll(async () => void (await emu?.close()));

compatSuite('emulator mode', async (tag) => {
  emu ??= await startEmulator({ config: compatConfig('emulator'), port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
  return initializeAdminApp(compatConfig('emulator', emu.port), 'test', { name: tag });
});
