import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: 'jsdom',
    globals: true,
    environmentOptions: {
      jsdom: { url: 'http://localhost/' },
    },
    setupFiles: ['./vitest.empty-server.setup.ts'],
    include: ['tests/EmptyServerStart.test.ts'],
  },
  resolve: {
    conditions: ['browser', 'module', 'import', 'default'],
    alias: {
      '@': path.resolve(__dirname, 'js'),
    },
  },
});
