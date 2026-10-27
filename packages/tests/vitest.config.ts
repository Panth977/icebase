import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // live/: a real Firebase project, only when ICEBASE_LIVE_PROJECT names one.
    include: process.env.ICEBASE_LIVE_PROJECT ? ['live/**/*.live.test.ts'] : process.env.ICEBASE_EMU ? ['**/*.emu.test.ts'] : ['**/*.test.ts'],
    exclude: process.env.ICEBASE_LIVE_PROJECT ? ['node_modules/**'] : process.env.ICEBASE_EMU ? ['node_modules/**', 'fixtures/**', 'live/**'] : ['**/*.emu.test.ts', 'node_modules/**', 'fixtures/**', 'live/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
