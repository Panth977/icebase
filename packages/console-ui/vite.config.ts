import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// One script and one stylesheet, no chunks: the console serves them from memory (ui.gen.ts).
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000,
    rollupOptions: { input: 'src/main.ts', output: { entryFileNames: 'app.js', assetFileNames: 'app.[ext]', inlineDynamicImports: true, format: 'es' } },
    target: 'es2022',
  },
});
