import { defineConfig } from 'vitest/config';

// ICEBASE_PG_URL=postgres://…: the IceBase server suites run on Postgres instead of SQLite
// (pg-setup.ts gives each test file schemas of its own and drops them after).
const pg = process.env.ICEBASE_PG_URL;

export default defineConfig({
  test: {
    // live/: a real Firebase project, only when ICEBASE_LIVE_PROJECT names one.
    include: process.env.ICEBASE_LIVE_PROJECT ? ['live/**/*.live.test.ts'] : process.env.ICEBASE_EMU ? ['**/*.emu.test.ts'] : ['**/*.test.ts'],
    exclude: process.env.ICEBASE_LIVE_PROJECT ? ['node_modules/**'] : process.env.ICEBASE_EMU ? ['node_modules/**', 'fixtures/**', 'live/**'] : ['**/*.emu.test.ts', 'node_modules/**', 'fixtures/**', 'live/**'],
    ...(pg ? { setupFiles: ['./pg-setup.ts'] } : {}),
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
