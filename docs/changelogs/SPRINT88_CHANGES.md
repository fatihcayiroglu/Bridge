# Sprint 88 — Küçük Açık Noktaların Kapatılması

> **Hedef:** Sprint 87 incelemesinde tespit edilen 4 küçük açık maddeyi kapatmak.

---

## 1. 🔒 csrf.ts — `_verifyBotToken` 60s In-Memory Cache

**Dosya:** `server/middleware/csrf.ts`

### Problem
Her CSRF kontrolünde `_verifyBotToken` DB'ye sorgu atıyordu. Yoğun bot trafiğinde
(yüzlerce req/s) bu darboğaz olabilirdi.

### Değişiklik
- `_botTokenCache: Map<hash, { valid, expiresAt }>` eklendi (max 10 000 entry, 60s TTL).
- Cache hit → DB atlanır.
- Cache miss → DB sorgusu yapılır, sonuç cache'e yazılır.
- DB hatası → cache'e **yazılmaz** (geçici hata kalıcı negatif cache'e dönüşmesin).
- Bot token revoke edildiğinde en geç 60s içinde etkili olur — güvenlik / performans dengesi.

```
_verifyBotToken("tok")
  ├── _getBotTokenCached(hash) → hit  → return cached.valid   (no DB)
  └── miss → db.bots.findOne(hash) → _setBotTokenCached → return valid
```

---

## 2. 🧪 rtl.spec.ts — CI Screenshot Baseline Talimatı

**Dosyalar:**
- `e2e/tests/rtl.spec.ts` (header genişletildi)
- `docs/DEPLOYMENT_GUIDE.md` (yeni bölüm)

### Problem
RTL görsel regresyon testleri (`toMatchSnapshot`) baseline PNG olmadan CI'da hata veriyordu.
Nasıl oluşturulacağı dokümante edilmemişti.

### Değişiklik
`rtl.spec.ts` dosyasının başına adım adım talimatlar eklendi:

| Durum | Komut |
|-------|-------|
| İlk baseline oluşturma | `SKIP_VISUAL_REGRESSION= playwright test --update-snapshots` |
| Baseline yokken CI | `SKIP_VISUAL_REGRESSION=1 playwright test` |
| UI değişikliği sonrası | `--update-snapshots` + commit |

`DEPLOYMENT_GUIDE.md`'e **"RTL Screenshot Baseline Kurulumu"** bölümü eklendi.

---

## 3. 📦 package.json — Sürüm `1.85.0` → `1.87.0`

**Dosya:** `package.json`

Sprint 86 ve 87 teslim edildiğinde sürüm artırılmamıştı.
Tek adımda iki sprint'i kapatacak şekilde `1.87.0`'a güncellendi.

---

## 4. 📚 README.md — İbranice & Farsça RTL Eklendi

**Dosya:** `README.md`

### Değişiklikler
- **Özellik tablosuna** yeni satır: `| RTL dil desteği | ❌ | ✅ Arapça, İbranice, Farsça |`
- **"Uluslararasılaştırma (i18n)"** başlığı altında yeni bölüm:
  - 15 dil listesi (he ve fa vurgulandı)
  - RTL dilleri ve `<html dir="rtl">` davranışı
  - Lazy-load mimarisi notu

---

## Dosya Özeti

| Dosya | Değişiklik |
|-------|-----------|
| `server/middleware/csrf.ts` | `_verifyBotToken` 60s cache + eviction |
| `e2e/tests/rtl.spec.ts` | CI baseline talimatı (header) |
| `docs/DEPLOYMENT_GUIDE.md` | RTL Baseline Kurulumu bölümü |
| `package.json` | `1.85.0` → `1.87.0` |
| `README.md` | i18n bölümü + RTL tablo satırı |
| `SPRINT88_CHANGES.md` | Bu dosya |

---

## Sonuç

| Alan | Sprint 87 | Sprint 88 |
|------|-----------|-----------|
| _verifyBotToken performansı | ⚠️ Her istek DB | ✅ 60s cache |
| RTL baseline CI dokümantasyonu | ⚠️ Eksik | ✅ Talimat + DEPLOYMENT_GUIDE |
| package.json sürümü | ⚠️ 1.85.0 (stale) | ✅ 1.87.0 |
| README i18n/RTL | ⚠️ he/fa yok | ✅ Tablo + bölüm |
