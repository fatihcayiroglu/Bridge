// core/api.js — YÖNLENDİRME DOSYASI
// ─────────────────────────────────────────────────────────────
// Bu dosya artık boştur. İçerik iki dosyaya taşındı:
//
//   core/globals.js         — API sabiti, global değişkenler,
//                             loadServerEmojis, applyServerEmojis,
//                             klavye kısayolları
//
//   core/server-settings.js — Emoji yönetimi, sunucu ayarları,
//                             webhook, audit log, SSO, plugin UI
//
// apiFetch ve token yönetimi → core/auth.js içinde
//
// Build sistemi (scripts/build.js) bu dosyayı artık
// ESM modüllere yönlendirmektedir.
// ─────────────────────────────────────────────────────────────

export const apiReady = true;
