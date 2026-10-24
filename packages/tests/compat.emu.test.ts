// compat Firestore, firebase mode: firebase-admin against the official Firestore emulator.
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { compatConfig, compatSuite } from './suites/compat.suite.js';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('run under scripts/emu.sh (FIRESTORE_EMULATOR_HOST is not set)');
compatSuite('firebase mode', async (tag) => initializeAdminApp(compatConfig('firebase'), 'test', { name: tag }));
