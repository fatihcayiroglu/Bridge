// client/vitest.config.ts
// Svelte bileşen testleri için Vitest yapılandırması.
// Çalıştırma: npx vitest run client/js/core/settings/__tests__
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ hot: !process.env.VITEST })],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['js/**/__tests__/**/*.test.ts'],
  },
});
