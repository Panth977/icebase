// Auth conformance, emulator mode: the IceBase server's Identity Toolkit API, in-process.
import { initializeAdminApp } from '../src/admin.js';
import { initializeApp } from '../src/app.js';
import { startEmulator } from '../src/emulator/server.js';
import { authConfig, authSuite } from './suites/auth.suite.js';

authSuite('emulator mode · IceBase', async () => {
  const emu = await startEmulator({ config: authConfig('emulator'), port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
  const config = authConfig('emulator', emu.port);
  return {
    app: initializeApp(config, 'test', { name: 'auth-web', firebase: { apiKey: 'demo', projectId: 'demo-icebase', authDomain: 'localhost' } }),
    admin: initializeAdminApp(config, 'test', { name: 'auth-admin' }),
    origin: emu.url,
    connect: () => {},
    close: () => emu.close(),
  };
});
