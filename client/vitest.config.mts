// client/vitest.config.mts
// Svelte bileşen testleri için Vitest yapılandırması (ESM).

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
    setupFiles: ['./vitest.setup.ts'],
    // Include patterns relative to project root (client dir)
    include: ['js/core/__tests__/**/*.test.ts', 'js/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts', '!js/**/__tests__.skip/**'],
    exclude: ['node_modules', 'dist', '**/*.skip/**', '**/*.node.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'js/**/*.ts',
        'js/**/*.svelte',
      ],
      exclude: [
        'js/**/__tests__/**',
        'tests/**',
        'node_modules/',
        '**/*.test.ts',
        '**/*.d.ts',
      ],
      all: true,
      lines: 60,
      functions: 60,
      branches: 60,
      statements: 60,
      skipFull: false,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'js'),
    },
  },
});
