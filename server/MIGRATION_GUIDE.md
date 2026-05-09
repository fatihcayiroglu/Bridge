# Bridge Server — TypeScript Migration Guide

## Sprint 13 Çıktısı

Bu sprint'te tüm `server/` dizini JavaScript'ten TypeScript'e geçirildi.

## Strateji: Kademeli Geçiş (allowJs: true)

TS derleyicisi hem `.ts` hem `.js` dosyalarını okur. Bu sayede:
- Tüm `.js` dosyaları korundu (silinmedi)
- Her `.js` dosyasının yanında `.ts` kopyası oluşturuldu
- `.ts` dosyaları zamanla gerçek tip güvenliğiyle güçlendirilecek

## Dosya Sayısı

| Klasör       | .ts Dosyaları |
|-------------|---------------|
| lib/        | 21            |
| routes/     | 65            |
| middleware/ | 8             |
| db/         | 47            |
| socket/     | 10            |
| jobs/       | 4             |
| app/        | 3             |
| plugins/    | 1             |
| **Toplam**  | **~158**      |

## Tam Tip Güvenliği ile Dönüştürülen Dosyalar

Bu dosyalar gerçek TypeScript tip annotasyonları ile yazıldı:

- `lib/permissions.ts` — PERMS const enum, tüm fonksiyon imzaları
- `lib/security.ts` — SpamResult, SafeUser, RateLimitResult tipleri
- `lib/userUtils.ts` — SafeUser interface

## tsconfig Dosyaları

| Dosya | Kullanım |
|-------|---------|
| `tsconfig.json` | IDE ve geliştirme (allowJs: true, checkJs: false) |
| `tsconfig.build.json` | Production build (`tsc -p tsconfig.build.json`) |
| `tsconfig.check.json` | Hızlı tip kontrolü (`npm run typecheck`) |

## Komutlar

```bash
# Tip kontrolü (sadece .ts dosyaları)
npm run typecheck

# Production build
npm run build

# TS ile çalıştır (geliştirme)
npm run start:ts

# TS ile dev (hot-reload)
npm run dev
```

## Yeni @types Paketleri

`npm install` sonrası şu paketler eklenecek:

```
@types/express @types/node @types/bcryptjs @types/jsonwebtoken
@types/multer @types/uuid @types/cors @types/pg @types/jest
@types/nodemailer @types/web-push @types/swagger-ui-express
ts-node ts-node-dev
```

## Sıradaki Adımlar (Sprint 14 önerisi)

1. `lib/` dosyalarına `noImplicitAny: true` uygula
2. Route handler'larına `Request`/`Response` tipleri ekle
3. Repository dönüş tiplerini `Promise<User | null>` gibi genişlet
4. `strict: true`'ya kademeli geçiş

## Önemli Notlar

- `.js` dosyaları silinmedi — `.ts` eklendi yanlarına
- `module.exports` korundu — mevcut `require()` çağrıları çalışmaya devam eder
- `tsconfig.json`'da `strict: false` — tip hataları şimdilik engellemiyor
- `allowJs: true` — mixed codebase tam destekli
