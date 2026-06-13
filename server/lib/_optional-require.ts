// server/lib/_optional-require.ts
// Runtime'da yüklü olmayabilecek opsiyonel bağımlılıklar için güvenli require wrapper.
//
// Kullanım:
//   const mod = tryRequire<{ createClient: ... }>('redis');
//   if (!mod) return; // modül yüklü değil, devre dışı kal
//   const { createClient } = mod;
//
// Neden require() ve import() değil:
//   - Koşullu yükleme: modül yoksa crash yerine null döner
//   - Erken başlatma (telemetry) için senkron kalması gerekiyor
//   - OTel/Redis/Sentry production'da opsiyonel; eksikse uygulama çalışmaya devam eder

export function tryRequire<T>(moduleId: string): T | null {
  try {
    // require() burada kasıtlı: opsiyonel runtime bağımlılığı
    return require(moduleId) as T;
  } catch (err) {
    if (process.env.NODE_ENV === 'e2e' || process.env.DEBUG_OPTIONAL_REQUIRE === '1') {
      console.error(`[tryRequire] failed to load ${moduleId}`, err);
    }
    return null;
  }
}
