import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: process.env.ICEBASE_EMU ? ['**/*.emu.test.ts'] : ['**/*.test.ts'],
    exclude: process.env.ICEBASE_EMU ? ['node_modules/**', 'fixtures/**'] : ['**/*.emu.test.ts', 'node_modules/**', 'fixtures/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
