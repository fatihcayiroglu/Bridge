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
    // ── DIKKAT: `include` icinde NEGATIF DESEN KULLANMAYIN ──────────────────
    // Burada eskiden `'!js/**/__tests__.skip/**'` vardi. Vitest 4 (tinyglobby)
    // altinda `include` icindeki negatif desen HATA VERMEZ ama KAPSAM
    // TOPLAMAYI TAMAMEN SESSIZCE KAPATIR: her dosya %0 raporlanir — calistigi
    // kanitlanabilen moduller bile.
    //
    // Kusur olculdu: ayni tek testle negatif desen VARKEN %0, YOKKEN %66.66.
    // Testlerin kendisi her iki durumda da gectigi icin bu, aylarca gorunmez
    // kalabilecek bir olcum korlugudur.
    //
    // Negatif desen zaten GEREKSIZDI: asagidaki `exclude` icindeki
    // `'**/*.skip/**'` deseni `__tests__.skip` dizinini zaten kapsiyor.
    include: ['js/core/__tests__/**/*.test.ts', 'js/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '**/*.skip/**', '**/*.node.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',

      // ── KAPSAM, BASARISIZLIKTA DA RAPORLANMALIDIR ───────────────────────
      // Vitest'te `reportOnFailure` VARSAYILAN OLARAK false'tur. Yani TEK bir
      // test dosyasi bile duserse kapsam raporu HIC uretilmez; ustelik
      // `coverage/` dizini calisma basinda temizlendigi icin ONCEKI rapor da
      // silinir. Sonuc: kirmizi bir kosuda olcum tamamen KAYBOLUR — tam da
      // kapsamin en cok gerektigi anda.
      //
      // Olculdu: 150 dosyadan 1'i duserken kapsam tablosu basilmadi ve
      // `client/coverage/` olusmadi. Esikler de dolayisiyla uygulanmadi.
      reportOnFailure: true,
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
      skipFull: false,

      // ── ESIKLER `thresholds` ALTINDA OLMALI ────────────────────────────
      // Bunlar eskiden `coverage.lines: 60` gibi DUZ anahtarlardi. O bicim
      // Vitest 3'undur; Vitest 4 esikleri YALNIZCA `coverage.thresholds`
      // altinda okur. Duz anahtarlar sessizce YOK SAYILIYORDU — yani yillardir
      // hicbir esik uygulanmiyordu ve kimse fark etmiyordu (kapsam zaten
      // ayri bir hatadan dolayi %0 raporluyordu).
      //
      // Release hedefi tum anlamli client kaynaklarinda S/B/F/L >= 90'dir. Bu
      // esikler olculen mevcut degeri gizlemez veya paydayi kucultmez: hedefe
      // ulasilana kadar coverage komutu bilincli olarak kirmizi kalir. Kapsam
      // yalniz gercek davranis testleriyle yukseltilir.
      thresholds: {
        // RELEASE GATE: bu sayilar dusurulmez.
        statements: 90,
        branches:   90,
        functions:  90,
        lines:      90,
      },
    },
  },
  resolve: {
    // Svelte 5 + Vitest: 'browser' condition olmadan `svelte` paketinin SSR
    // girişi (index-server.js) çözülür ve mount() "not available on the server"
    // hatası verir. environment jsdom olduğu için tarayıcı girişi doğrudur.
    conditions: ['browser'],
    alias: {
      '@': path.resolve(__dirname, 'js'),
    },
  },
});
