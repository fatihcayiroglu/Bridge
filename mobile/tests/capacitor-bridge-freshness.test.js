// mobile/tests/capacitor-bridge-freshness.test.js
//
// Final21 Faz 19 (19-28): DEPODAKİ capacitor-bridge.js, capacitor-bridge.ts'in derlenmiş hâline
// BAYT-BAYT eşit olmalıdır. `setup.js` yalnızca .ts daha YENİYSE derler; sürüm ZIP'i zaman
// damgalarını normalize ettiği için taze bir çıkartmada DEPODAKİ .js kullanılır. .ts düzenlenip .js
// yeniden üretilmezse sürüm ESKİ yerel köprüyü taşırdı ve birim testleri de (onlar .js'i yükler) eski
// kodu ölçerdi. Yenileme: `node mobile/scripts/setup.js` (ya da .js'i silip yeniden çalıştırın).

'use strict';

const fs = require('fs');
const { entry, output, esbuildOptions } = require('../scripts/bridge-build-options.js');

test('capacitor-bridge.js, capacitor-bridge.ts ile güncel (bayt-bayt)', () => {
  // eslint-disable-next-line global-require
  const result = require('esbuild').buildSync({ ...esbuildOptions, entryPoints: [entry], write: false });
  const fresh = Buffer.from(result.outputFiles[0].contents).toString('utf8');
  const shipped = fs.readFileSync(output, 'utf8');
  expect(shipped === fresh).toBe(true);
});
