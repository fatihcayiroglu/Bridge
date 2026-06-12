# Sprint 90 — Mobile CI Entegrasyonu

## Sorun

`mobile/www/js/` dizini sadece bir README içeriyordu.
`mobile/scripts/setup.js` yazılmış ama CI'da hiç çalıştırılmıyordu.
`turbo.json`'da `mobile:build` görevi yoktu.
`package.json`'da `mobile` workspace tanımlı değildi.

Sonuç: Her deploy'da `npx cap sync` manuel olarak çalıştırılmak zorundaydı;
atlandığında iOS/Android build'e stale veya boş JS/CSS gidiyordu.

## Yapılanlar

### 1. `turbo.json` — `mobile:build` görevi eklendi

`build` görevine bağımlı. Input olarak `client/js/**`, `client/css/**`,
`mobile/capacitor-bridge.js` ve `mobile/scripts/setup.js` izleniyor.
Output olarak `mobile/www/**` cache'leniyor — client değişmediğinde
Turborepo cache'ten kullanır, setup.js çalıştırmaz.

### 2. `package.json` (root) — `mobile` workspace eklendi

`workspaces: ["mobile", ...]` ile Turborepo mobile paketini tanıyor.
`mobile:build` ve `mobile:build:ci` scriptleri eklendi.

### 3. `mobile/package.json` — `mobile:build` ve `test` scriptleri eklendi

Turbo'nun `mobile:build` görevini tetikleyebilmesi için
script isimleri eşleştirildi. `test` scripti de eklendi (jest.mobile.config.js).

### 4. `.github/workflows/ci.yml` — `mobile-build` job'u eklendi

`build` job'una bağımlı (`needs: [build]`). Adımlar:
1. Build artifact'ını indir (`bridge-build-$sha`)
2. `node mobile/scripts/setup.js` çalıştır
3. `www/` içerik doğrulama: dosya sayısı ≥ 3, `capacitor-bridge.js` var mı?
4. Mobile birim testleri (`jest.mobile.config.js`)
5. `bridge-mobile-www-$sha` artifact'ı yükle (7 gün saklama)

`deploy-staging` artık `needs: [build, mobile-build]` — staging deploy'dan önce
www/ build geçmesi zorunlu.

### 5. `mobile/scripts/setup.js` v51 — CI sağlamlığı

- `client/dist/js/` varsa onu (minified), yoksa `client/js/` kullanır
- Kaynak dizin yoksa açık hata + `exit 1` (artifact indirilmemiş demektir)
- `countFiles()` try/catch ile sarıldı
- Toplam dosya sayısı < 3 ise `exit 1`
- Sonuçta `capacitor-bridge.js` varlığı ✅/❌ olarak loglanır

## CI Akışı (Sprint 90 sonrası)

```
lint-and-typecheck
        ↓
     tests
        ↓
     build  ──────────────────────────────┐
        ↓                                 ↓
  mobile-build                     (diğer job'lar)
  1. artifact indir
  2. setup.js çalıştır
  3. www/ doğrula
  4. mobile testler
  5. www artifact yükle
        ↓
  deploy-staging (develop/staging branch'te)
```

## Artifact Kullanımı

`bridge-mobile-www-$sha` artifact'ını indirip `mobile/www/` dizinine çıkartın,
ardından:

```bash
npx cap sync
npx cap open ios      # veya android
```
