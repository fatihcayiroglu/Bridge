# Client JS → TypeScript Geçiş Planı

## Mevcut Durum (Sprint 28)

| Tür | Sayı | Durum |
|-----|------|-------|
| `.ts` dosyaları | 47 | Tam TypeScript |
| `.js` dosyaları | 87 | `// @ts-check` + JSDoc ile tip kontrolü aktif |

## Neden Hemen `.ts`'e Geçilmiyor?

Client JS dosyaları tarayıcıya **doğrudan servis edilmektedir** (`<script src="...js">`).
TypeScript derleme pipeline'ı eklenmeden `.ts`'e rename yapmak tarayıcıyı kırar.

## Geçiş için Gerekli Adımlar

1. **Build pipeline ekle** — `esbuild` veya `tsc --outDir` ile `.ts` → `.js` derleme
2. **`index.html`'i güncelle** — `src="*.js"` → `src="dist/*.js"` veya `type="module"` + bundler
3. **`vNx/index.js` loader'larını güncelle** — modül listelerindeki `.js` uzantıları
4. **Dosyaları sırayla geçir** — utility'lerden başla: `api-fetch`, `auth`, `globals`

## Şu An Yapılanlar (Sprint 28)

- Tüm `.js` dosyalarına `// @ts-check` eklendi — TypeScript, JSDoc üzerinden tip hatalarını yakalar
- `'use strict'` direktifleri kaldırıldı — `@ts-check` ile gereksiz
- `api-fetch.js` tam JSDoc tiplerine kavuşturuldu (örnek olarak)
- `tsconfig.json`'a `noFallthroughCasesInSwitch` ve `forceConsistentCasingInFileNames` eklendi

## Öncelikli Geçiş Sırası

Yüksek öncelik (en çok import edilen):
1. `core/api-fetch.js` ✅ JSDoc tamamlandı
2. `core/auth.js`
3. `core/globals.js` (varsa)
4. `core/socket.js`
5. `core/messages/renderer.js`

Orta öncelik (feature modülleri):
- `core/v41/`, `core/v42/`, `core/v43/`, `core/v44/` dizinleri

Düşük öncelik (bağımsız UI modülleri):
- `core/emoji-picker.js`, `core/music-player.js`, vb.

---

## Sprint 43 Tamamlananlar

| Dosya | Satır | Tip |
|-------|-------|-----|
| `core/a11y-focus-trap.ts` | 103 | A11yContainer interface, tam tip annotasyonu |
| `core/a11y-keyboard.ts`   | 119 | Orientation union tipi |
| `core/badges.ts`          | 142 | Badge interface |
| `core/moderation.ts`      | 227 | AuditLog, ServerStats interface'leri |
| `core/auth.ts`            | 296 | CaptchaConfig, LoginResponse, RegisterResponse |
| `core/friends.ts`         | 290 | Friend, PendingRequest interface'leri |
| `core/translate-btn.ts`   | 158 | TranslationEntry, BridgeAPI interface'leri |
| `core/socket.ts`          | 392 | SocketInstance, RtcInstance, BotModal tipleri |
| `core/misc.ts`            | 24  | stub |
| `core/dm-read.ts`         | 68  | ReadState, SocketLike |
| `core/skeleton-loading.ts`| 64  | — |
| `core/api.ts`             | 4   | stub |
| `core/messages.ts`        | 3   | stub |
| `core/channel-permissions.ts` | 3 | stub |
| `core/auth-revoked.ts`    | 30  | — |

**Strict gate: 7 → 18 dosya (+11)**
**tsconfig.strict.json exclude: 2 → 0 (modal-core.ts + slash.ts kapatıldı)**
**Kalan .js: 66 → 50**

## Durum (Sprint 43 Sonu)

| Tür | Sayı |
|-----|------|
| `.ts` dosyaları | 85 |
| `.js` dosyaları (TS karşılığı olmayan) | 50 |
| Strict gate'te | 18 |
| tsconfig.strict.json exclude | **0** ✅ |

## Sprint 44 için Öncelikli Adaylar (strict gate'e alınacak)

1. `core/moderation.ts` — bu sprint yazıldı, gate'e hazır
2. `core/friends.ts` — bu sprint yazıldı, gate'e hazır
3. `core/auth.ts` — bu sprint yazıldı, gate'e hazır
4. `core/socket.ts` — büyük, dikkatli inceleme gerekli
5. `core/settings-modal.ts` — 728 satır, en çok kullanılan TS modal
6. `js/webrtc.ts` + `js/webrtc-sfu.ts` — ses/video core, kritik
