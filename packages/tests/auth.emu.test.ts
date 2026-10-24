// Auth conformance, firebase mode: Firebase's auth emulator.
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { initializeApp } from '@panth977/icebase/app';
import { connectAuthEmulator } from '@panth977/icebase/auth';
import { authConfig, authSuite } from './suites/auth.suite.js';

const HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!HOST) throw new Error('run under scripts/emu.sh (FIREBASE_AUTH_EMULATOR_HOST is not set)');
const config = authConfig('firebase');

authSuite('firebase mode', async () => ({
  app: initializeApp(config, 'test', { name: 'auth-web', firebase: { apiKey: 'demo', projectId: 'demo-icebase', authDomain: 'localhost' } }),
  admin: initializeAdminApp(config, 'test', { name: 'auth-admin' }),
  origin: `http://${HOST}`,
  connect: (auth) => connectAuthEmulator(auth, `http://${HOST}`, { disableWarnings: true }),
}));
