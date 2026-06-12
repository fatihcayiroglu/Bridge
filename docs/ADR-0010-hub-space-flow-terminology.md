# ADR-0010: UI Terminoloji Geçişi — Hub / Space / Flow

**Durum:** Kabul edildi  
**Tarih:** 2026-05-31 (Sprint 110)  
**Karar verenler:** Core ekibi + UX  
**İlgili ADR'ler:** ADR-0008 (Frontend Framework), ADR-0002 (Svelte vs Vue)

---

## Bağlam

Bridge, köprü metaforunu (Hub → Space → Flow) marka kimliğinin merkezi olarak belirledi (README, `docs/DESIGN_DIRECTION.md`). Ancak Sprint 109 itibarıyla:

- UI metinleri hâlâ Discord kökenli terminolojiyi (`server`, `channel`, `thread`) kullanıyordu
- i18n dosyaları (`tr.ts`, `en.ts`, vb.) Hub/Space/Flow anahtarları içermiyordu
- API dokümantasyonu (`/api/servers`, `/api/channels`) eski terminoloji ile yazılmıştı
- Yeni geliştirici onboarding belgeleri kavramsal tutarsızlık içeriyordu

Bu ADR, terminoloji geçişinin **nasıl yapılacağını**, **nelerin değişeceğini**, **nelerin korunacağını** ve **geçiş döneminde geriye dönük uyumluluğun nasıl sağlanacağını** belgeler.

---

## Kapsam ve Sınırlar

### Değişecek (kullanıcıya görünen metinler)
| Eski | Yeni | Konum |
|------|------|-------|
| Server | Hub | UI etiketleri, tooltip'ler, onboarding |
| Channel | Space | UI etiketleri, placeholder'lar |
| Thread | Flow | UI etiketleri |
| "Sunucu oluştur" | "Hub Oluştur" | Buton metinleri (TR) |
| "Kanal oluştur" | "Space Oluştur" | Buton metinleri (TR) |

### Değişmeyecek (teknik/API katmanı)
| Korunan | Neden |
|---------|-------|
| `GET /api/servers` | API geriye dönük uyumluluğu |
| `GET /api/channels` | Bot SDK uyumluluğu |
| DB şeması (`servers`, `channels` tabloları) | Migration maliyeti |
| Socket.IO event adları (`server:join`, `channel:message`) | Client uyumluluğu |
| `serverId`, `channelId` JSON alanları | API kontratı |

---

## Değerlendirilen Seçenekler

### Seçenek A — Tam yeniden adlandırma (API dahil) [Reddedildi]
API endpoint'leri `/api/hubs`, `/api/spaces` olarak değiştirilir.

**Neden reddedildi:**
- Tüm bot geliştiricilerini etkiler (breaking change)
- DB migration gerektirir (`servers` → `hubs` tablo yeniden adlandırma)
- Mevcut federation (ActivityPub) `type: "Group"` semantiğini bozabilir

### Seçenek B — Yalnızca UI katmanı (i18n) [Seçildi]
UI metinleri i18n üzerinden değiştirilir; API ve DB katmanı korunur.

**Artılar:**
- API geriye dönük uyumlu kalır
- Bot SDK değişiklik gerektirmez
- Kademeli geçiş: önce i18n, sonra bileşen isimleri, sonra dosya isimleri

### Seçenek C — Alias katmanı (API düzeyinde)
`/api/hubs` → `/api/servers` yönlendirmesi.

**Neden reddedildi:** Gereksiz karmaşıklık; UI katmanı değişikliği yeterli

---

## Karar

**Seçenek B (yalnızca UI/i18n katmanı)** kabul edildi. Sprint 110'da:

1. 15 dil dosyasına `hub`, `space`, `flow`, `hubs`, `spaces`, `flows` anahtarları eklendi
2. `scripts/check-i18n-parity.js` CI guard'ı eklendi — yeni dil eklendiğinde eksik anahtar hemen yakalanır
3. CI'ya Hub/Space/Flow anahtar varlığını doğrulayan adım eklendi

### Geçiş Takvimi

```
Sprint 110 (✅ Tamamlandı)
  └── i18n anahtarları eklendi (15 dil)
  └── CI parity guard eklendi

Sprint 112 (Planlandı)
  └── Svelte bileşenlerinde UI metinleri güncellenir
  └── onboarding-wizard metinleri Hub/Space/Flow'a geçer
  └── Tooltip ve placeholder'lar güncellenir

Sprint 115 (Planlandı)
  └── Dokümantasyon tam geçiş (DEVELOPER_GUIDE, DEPLOYMENT_GUIDE)
  └── API dokümantasyonunda "Hub (Server)" çift etiket dönemi başlar

Sprint 120+ (Uzun vade)
  └── API alias katmanı değerlendirmesi (/api/hubs → /api/servers)
  └── Bot SDK majör versiyonda terminoloji güncelleme
```

---

## i18n Anahtarları Sözleşmesi

```typescript
// Kullanım — i18n helper ile:
t('hub')      // → "Hub" (EN) / "Hub" (TR) / "Hub" (DE) vb.
t('hubs')     // → "Hubs" / "Hublar" / "Hubs"
t('space')    // → "Space" / "Space" / "Space"
t('spaces')   // → "Spaces" / "Spaceler" / "Spaces"
t('flow')     // → "Flow" / "Flow" / "Flow"
t('flows')    // → "Flows" / "Flowlar" / "Flows"

// Eski anahtarlar korunuyor (API metinleri için):
t('servers')  // Discover, API response'larında kullanılmaya devam eder
t('channels') // API response'larında kullanılmaya devam eder
```

---

## Sonuçlar

- **Olumlu:** Marka tutarlılığı sağlandı; pazarlama materyalleri ile UI eşleşiyor
- **Olumlu:** Bot SDK'yı bozmadan terminoloji geçişi mümkün oldu
- **Nötr:** Kullanıcılar geçiş döneminde "Hub = Server" kavramını öğrenmek zorunda — onboarding bunu açıklayacak
- **Risk:** Terminoloji karışıklığı (API'de `serverId`, UI'da `Hub`) — azaltma: developer docs'ta açık eşleme tablosu eklendi

---

## Referanslar

- `docs/DESIGN_DIRECTION.md`
- `client/js/core/i18n/tr.ts` — tüm dil dosyaları
- `scripts/check-i18n-parity.js`
- `.github/workflows/ci.yml` — Hub/Space/Flow CI guard adımı
- [ADR-0008: Frontend Framework Stratejisi](./ADR-0008-frontend-framework-strategy.md)
