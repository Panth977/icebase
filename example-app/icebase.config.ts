import { defineConfig } from 'icebase/config';
import { schema } from './icebase/schema';

export default defineConfig({
  name: 'acme-shop',
  schema,

  // Firebase rules syntax — the same files work in every mode.
  rules: {
    firestore: 'icebase/rules/firestore.rules',
    storage: 'icebase/rules/storage.rules',
  },

  functions: { source: 'icebase/functions', runtime: 'nodejs22', region: 'us-central1' },
  hosting: { public: 'dist', spa: true, rewrites: [{ source: '/api/**', function: 'api' }] },
  auth: { providers: ['password', 'google'], claims: {} },
  storage: { maxUploadMb: 20 },

  // Connection details. Secrets are env-var NAMES, never values.
  firebase: { projectId: 'demo-acme-shop', webConfigEnv: 'FIREBASE_WEB_CONFIG', serviceAccountEnv: 'FIREBASE_SERVICE_ACCOUNT' },
  emulator: { dataDir: '.icebase', port: 4400, hostingPort: 5002, seed: 'icebase/seed/local.ts' },

  // Pick a mode per environment, and override per service when you want to mix.
  environments: {
    local: { mode: 'emulator' }, // `icebase dev`: SQLite, no cloud
    prod: { mode: 'firebase' },
  },
});
