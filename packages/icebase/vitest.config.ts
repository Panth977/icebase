import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: process.env.ICEBASE_EMU ? ['test/**/*.emu.test.ts'] : ['test/**/*.test.ts'],
    exclude: process.env.ICEBASE_EMU ? [] : ['test/**/*.emu.test.ts', 'node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
