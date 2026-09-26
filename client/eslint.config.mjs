// client/eslint.config.mjs
// ESLint flat config — Bridge istemci tarafı
// Sprint 77: no-console kuralı eklendi; tüm console çağrıları createLogger ile değiştirildi.
//
// Faz 7.3: dosya CJS'ten ESM'e taşındı. Sebep: eslint-plugin-svelte ve
// svelte-eslint-parser ESM-only paketler (type: module), CJS `require()` ile
// yüklenemiyorlardı. Kural setleri ve politika AYNEN korundu; yalnızca
// `.svelte` kapsamı eklendi (öncesinde hiç lint edilmiyorlardı).

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import sveltePlugin from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';

// Tarayıcı global'leri — .ts ve .svelte blokları paylaşır.
const browserGlobals = {
  window:    'readonly',
  document:  'readonly',
  navigator: 'readonly',
  fetch:     'readonly',
  URL:       'readonly',
  URLSearchParams: 'readonly',
  FormData:  'readonly',
  Blob:      'readonly',
  File:      'readonly',
  FileReader: 'readonly',
  Worker:    'readonly',
  MediaStream: 'readonly',
  MediaRecorder: 'readonly',
  RTCPeerConnection: 'readonly',
  AudioContext: 'readonly',
  WebSocket: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  location: 'readonly',
  history: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  globalThis: 'readonly',
  CSS: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  Headers: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  HTMLElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  HTMLDivElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLButtonElement: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  ClipboardEvent: 'readonly',
  queueMicrotask: 'readonly',
  caches: 'readonly',
  console: 'readonly',
};

// TS ve Svelte bloklarının ortak kural seti — politika tek yerde.
const sharedRules = {
  // Sprint 77: console.* yasak — createLogger kullan
  'no-console': 'error',
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-var': 'error',
  'prefer-const': 'warn',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'eqeqeq': ['warn', 'always', { null: 'ignore' }],
  'no-duplicate-imports': 'error',
};

export default [
  {
    files: ['js/**/*.ts', 'js/**/*.js'],
    ignores: [
      // DİKKAT — `js/core/logger.ts` BURADAN ÇIKARILDI (Faz E).
      // Amaç yalnızca `no-console`dan muaf tutmaktı; ama flat config'te
      // `ignores` dosyayı tek bir KURALDAN değil TÜM BLOKTAN çıkarır —
      // `languageOptions.parser: tsParser` dâhil. Sonuç: logger.ts varsayılan
      // espree ile ayrıştırılıyor, `declare global` satırında PARSE HATASI
      // veriyordu. Yani dosya hem hiç lint EDİLMİYOR hem de tek başına tüm
      // ESLint kapısını exit 1 yapıyordu.
      // Muafiyet artık aşağıda, yalnız `no-console`u kapatan kendi bloğunda.
      // (Aynı hata satır 139'da testler için zaten bir kez yaşanmıştı.)
      'tests/**',
      'node_modules/',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: browserGlobals,
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...sharedRules,
      '@typescript-eslint/no-explicit-any': 'warn',
      // ── TS-FARKINDA kullanilmayan-degisken kurali ──────────────────────────
      // Cekirdek `no-unused-vars` TypeScript'i ANLAMAZ: `interface` metot
      // imzalarindaki PARAMETRE ADLARINI (ornegin `process(stream: MediaStream)`)
      // kullanilmayan degisken sanip uyari uretir. Bunlar YAPISAL yanlis
      // pozitiftir; bir tip imzasinda adin 'kullanilmasi' diye bir sey yoktur.
      //
      // Ayni kusur `.svelte` blogunda ZATEN duzeltilmisti; `.ts` blogunda
      // atlanmis. OLCUM: `js/webrtc.ts` icindeki 31 uyarinin 19'u dogrudan
      // `interface` imzalarindan geliyordu.
      //
      // GEVSETME DEGILDIR: TS-farkinda kural GERCEKTEN kullanilmayan
      // degiskenleri bildirmeye DEVAM eder; yalnizca tip imzalari haric tutulur.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Faz E — logger.ts DAR muafiyeti.
    // Dosya yukarıdaki blokla NORMAL biçimde (TS parser'ıyla) lint edilir;
    // burada YALNIZCA `no-console` kapatılır. Logger'ın kendisi console'a
    // yazmak zorundadır — muafiyetin gerçek kapsamı budur.
    files: ['js/core/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Faz 7.3: .svelte dosyaları artık gerçekten lint ediliyor.
    // svelte-eslint-parser template'i ayrıştırır, <script lang="ts"> bloklarını
    // parserOptions.parser ile TypeScript parser'a devreder.
    files: ['js/**/*.svelte'],
    ignores: ['node_modules/'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: browserGlobals,
    },
    plugins: { svelte: sveltePlugin, '@typescript-eslint': tsPlugin },
    rules: {
      ...sharedRules,
      '@typescript-eslint/no-explicit-any': 'warn',

      // ── Svelte 5 runes'a özgü düzeltmeler (yanlış pozitifleri kaldırır) ────
      // Çekirdek `prefer-const`, runes bildirimlerini yanlış işaretliyor:
      //   let x = $state(0)  → const olamaz (reaktivite kırılır)
      //   let { children } = $props()
      // svelte/prefer-const runes farkındadır.
      'prefer-const': 'off',
      'svelte/prefer-const': ['warn', { excludedRunes: ['$props', '$derived', '$state'] }],

      // Çekirdek no-unused-vars, TS tip imzalarındaki parametre ADLARINI
      // (örn. `onReply?: (message: X) => void`) kullanılmayan değişken sanıyor.
      // TypeScript sürümü bunu doğru anlar.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Test dosyaları — console serbest.
    // Faz 8.1: burada `languageOptions.parser` yoktu; ESLint varsayılan espree
    // ile ayrıştırıyor ve HER TypeScript test dosyası "Parsing error" veriyordu
    // (yani testler gerçekte hiç lint edilmiyordu). TS parser eklendi.
    files: ['tests/**/*.ts', 'tests/**/*.js'],
    ignores: ['node_modules/'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        ...browserGlobals,
        describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly',
        vi: 'readonly', jest: 'readonly', global: 'readonly', process: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...sharedRules,
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    // ── TIP BILDIRIM DOSYALARI (*.d.ts) ──────────────────────────────────────
    // Bildirim dosyalari AMBIENT semboller tanimlar: global arayuzler, pencere
    // genisletmeleri, legacy kopruler. Bu semboller dosyanin ICINDE
    // "kullanilmaz" — kullanilmalari zaten BASKA dosyalarin isidir. Dolayisiyla
    // burada `no-unused-vars` YAPISAL OLARAK yanlis pozitiftir.
    //
    // OLCUM: 701 uyarinin 233'u (yaklasik %33) yalnizca iki bildirim
    // dosyasindan geliyordu:
    //     js/types/globals.d.ts              158
    //     js/types/bridge-legacy-globals.d.ts 75
    //
    // Bu KURAL BAZINDA ve YALNIZ `.d.ts` icin kapatilir; uretim kodunda
    // kullanilmayan degisken uyarilari AYNEN gecerli kalir.
    files: ['**/*.d.ts'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
