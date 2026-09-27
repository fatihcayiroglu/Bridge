// mobile/scripts/bridge-build-options.js
//
// capacitor-bridge.ts → capacitor-bridge.js derleme seçenekleri TEK yerde (Final21 Faz 19, 19-28).
// `setup.js` derlemeyi yalnızca .ts dosyası .js'ten YENİYSE yapar; sürüm ZIP'i ise zaman damgalarını
// normalize eder (scripts/deterministic-zip.js). Taze bir çıkartmada ikisi eşit tarihlidir ve
// DEPODAKİ .js kullanılır. Bu yüzden depodaki .js, .ts'in bu seçeneklerle derlenmiş hâline bayt-bayt
// eşit olmak zorundadır — mobile/tests/capacitor-bridge-freshness.test.js bunu kilitler.

'use strict';

const path = require('path');

const MOBILE = path.resolve(__dirname, '..');

module.exports = {
  entry: path.join(MOBILE, 'capacitor-bridge.ts'),
  output: path.join(MOBILE, 'capacitor-bridge.js'),
  esbuildOptions: {
    // Çıktıdaki kaynak yolu yorumu çalışma dizinine göredir; kök sabitlenmezse derleme,
    // çağrıldığı dizine göre FARKLI baytlar üretiyordu (ölçüldü: "// mobile/capacitor-bridge.ts"
    // ↔ "// capacitor-bridge.ts").
    absWorkingDir: path.resolve(MOBILE, '..'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    logLevel: 'silent',
    legalComments: 'none',
  },
};
