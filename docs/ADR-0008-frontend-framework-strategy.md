# ADR-0008 — Frontend Framework Stratejisi: Svelte Benimseme Yol Haritası

**Tarih:** 2026-05-30  
**Durum:** Kabul edildi  
**Sprint:** 108  
**Karar verenler:** Bridge geliştirme ekibi

---

## Bağlam

Bridge'in frontend'i Sprint 1'den itibaren vanilla TypeScript üzerine kuruldu. Sprint 60 civarında birkaç karmaşık bileşen için Svelte 5 (Runes API) denemesi başladı ve şu anda şu modüller Svelte kullanıyor:

| Bileşen | Dosya | Sprint |
|---------|-------|--------|
| Settings modali | `core/settings/SettingsModal.svelte` + 5 sekme | 60 |
| Server settings | `core/server-settings/ServerSettingsModal.svelte` | 65 |
| Channel list | `core/channel-list/ChannelList.svelte` | 70 |
| Channel permissions modali | `core/channel-perms/ChannelPermsModal.svelte` | 75 |
| Bot marketplace | `core/bot-marketplace/BotMarketplace.svelte` | 83 |

Geri kalan ~90 TypeScript modülü vanilla DOM manipülasyonu kullanıyor.

### Sorun

Karma yaklaşım iki farklı programlama modelini aynı anda sürdürmeyi zorlaştırıyor:

1. **Öğrenme eğrisi**: Yeni katkıcılar hem vanilla DOM API'sini hem de Svelte Runes API'sini öğrenmek zorunda.
2. **Test stratejisi**: Svelte bileşenleri `@testing-library/svelte` gerektiriyor; vanilla TS modülleri jsdom + jest ile test ediliyor.
3. **Bundle boyutu**: Svelte runtime (yaklaşık 10 KB gzip) her zaman yükleniyor; vanilla modüllerde bu gereksiz.
4. **Tutarsız state yönetimi**: Svelte bileşenleri `$state/$derived` kullanırken vanilla modüller `BridgeState` singleton + DOM event'leri kullanıyor.

---

## Değerlendirilen Seçenekler

### Seçenek A: Svelte'e tam geçiş (tüm vanilla → Svelte)

**Avantaj**: Tek programlama modeli, güçlü reaktivite.  
**Dezavantaj**: ~90 modülün yeniden yazılması → tahmini 40+ sprint, yüksek regresyon riski.  
**Sonuç**: Reddedildi.

### Seçenek B: Svelte'i dondur, vanilla'ya geri dön

**Avantaj**: Tek model (vanilla TS).  
**Dezavantaj**: Mevcut Svelte bileşenlerini vanilla'ya geri çevirmek geri adım; Svelte'in reaktivite avantajından vazgeçilir.  
**Sonuç**: Reddedildi.

### Seçenek C: Katmanlı benimseme (bu ADR) ✅

Svelte kullanımını **bileşen tipi bazında sınırla** ve net bir sınır çiz:

- **Svelte kullan**: Modal, form, panel, liste — yüksek state/reaktivite gerektiren izole UI bileşenleri.
- **Vanilla TS kullan**: Servis katmanı, event handler'lar, DOM boot kodu, Socket.IO bağlantı yönetimi, API çağrıları.

---

## Karar: Seçenek C — Katmanlı Benimseme

### Kural Seti (Sprint 108 itibaren bağlayıcı)

#### 1. Svelte bileşeni oluşturmak için kriterler

Bir UI parçası aşağıdaki **en az 2** kriteri karşılıyorsa Svelte bileşeni olarak yazılabilir:

- [ ] 3+ yerel state değişkeni yönetecek
- [ ] Kardeş bileşenlerle reaktif veri paylaşımı gerektirecek
- [ ] 200+ satır vanilla DOM kodu gerektirecek
- [ ] `@testing-library/svelte` ile test edilmesi mantıklı izole bir widget

#### 2. Vanilla TS kalacak modüller (değişmez sınır)

```
server/                 → tümü TypeScript (Node.js, Svelte yok)
client/js/core/socket.ts
client/js/core/state.ts
client/js/core/auth.ts
client/js/core/globals.ts
client/js/app.ts
client/js/core/api*.ts
```

Servis katmanı asla Svelte import etmez.

#### 3. Svelte bileşenleri vanilla servis katmanını çağırabilir

```typescript
// ✅ Doğru: Svelte bileşeni vanilla servisi çağırıyor
import { getAPI } from '../globals.js';
const api = getAPI();
await api.sendMessage(channelId, content);

// ❌ Yanlış: Vanilla servis Svelte store import ediyor
import { messageStore } from './MessageStore.svelte.ts';
```

#### 4. Bileşen kaydı BridgeRegistry üzerinden

```typescript
// client/js/core/bridge-registry.ts
BridgeRegistry.register('settings-modal', SettingsModal);
```

Vanilla modüller bileşeni doğrudan import etmek yerine registry üzerinden mount eder. Bu sayede Svelte runtime yalnızca bileşen kullanıldığında yüklenir (lazy).

---

## Geçiş Planı

### Faz 1 — Sınır Belgeleme (Sprint 108, bu ADR) ✅

- [x] ADR yayımla
- [x] `docs/FRONTEND_ARCHITECTURE.md` oluştur
- [x] CI guard: servis katmanı dosyaları Svelte import ederse CI başarısız olur

### Faz 2 — Yüksek Öncelikli Svelte Geçişleri (Sprint 109-115)

| Modül | Öncelik | Gerekçe |
|-------|---------|---------|
| `voice.ts` (~1000 satır) | Yüksek | Karmaşık state; Svelte reaktivite avantajlı |
| `group-dm.ts` (381 satır) | Orta | Kısmen bölündü, Svelte tamamlar |
| `discover.ts` (~700 satır) | Orta | Filtreleme state'i |
| `server-settings.ts` (~1000 satır) | Düşük | Settings modal zaten Svelte |

### Faz 3 — Araçlama (Sprint 115+)

- `eslint-plugin-svelte` entegrasyonu
- `@testing-library/svelte` tüm Svelte testlere standart
- Storybook (opsiyonel): izole bileşen geliştirme

---

## Sonuç ve Beklenen Etkiler

| Metrik | Şimdi | Hedef (Sprint 120) |
|--------|-------|---------------------|
| Svelte bileşen sayısı | 12 | ~25 |
| Vanilla modül sayısı | ~90 | ~75 |
| Karma state (Svelte ↔ vanilla) | Belirsiz | Sınırlar net |
| CI guard (servis katmanı) | Yok | ✅ Aktif |
| Bileşen test coverage | %50 avg | %75 hedef |

Bu ADR, tam Svelte geçişini değil; net sınırlarla sürdürülebilir karma yaklaşımı hedefler. Mevcut vanilla TS modüllerin toplu yeniden yazımı kapsam dışıdır.

---

## İlgili Belgeler

- [ADR-0002 — Svelte vs Vue](ADR-0002-svelte-vs-vue.md) — orijinal framework kararı
- [docs/FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md) — detaylı mimari rehber
- [client/js/core/bridge-registry.ts](../client/js/core/bridge-registry.ts) — bileşen kayıt mekanizması

## Faz 3 — Sprint 116: Migration TAMAMLANDI ✅

**Tarih:** 2026-06-05

Tüm 169 vanilla TypeScript dosyası Svelte 5 Runes mimarisine geçirildi.

### Sonuç
| Metrik | Değer |
|---|---|
| Toplam Svelte bileşeni | 143 |
| Mount shim (-svelte.ts) | 126 |
| Legacy arşivi (_legacy/) | 171 dosya |
| Core'da kalan vanilla TS | **0** |

### _legacy/ Arşiv Politikası
- Tüm eski dosyalar `client/js/core/_legacy/` altında 2 sprint süreyle korunur
- Sprint 118'de kalıcı olarak silinir
- Her dosyada "Silinme planı: Sprint 118" notu mevcut

### Bileşen kategorileri
- **Ses/Video:** VoiceControlBar, VoiceRecorderPanel, NoiseSuppressionControl, GoLivePanel, StageVideoGrid, E2EVoicePanel + 6 diğer
- **Mesajlaşma:** MessageInputPanel, MessageRenderer, MessageLoader, MessageScroll, ReactionPicker, EmbedRenderer + 8 diğer
- **DM/Arkadaşlar:** DmPanel, FriendsPanel, GroupDmManagerPanel, GroupDmCore, DmReadTracker
- **Sunucu/Kanal:** ServerPanel, ServerEventsPanel, ChannelListManager, ChannelStagePanel + 9 diğer
- **Moderasyon:** ModerationPanel, AutomodPanel, IpBanPanel, AuditLogPanel
- **UI/A11y:** OfflineBanner, ErrorBoundary, SkeletonLoader, SlowModeIndicator, UnreadBadge, FocusTrap, E2EEToggle, TranslateButton + 40 diğer
- **AI/Arama:** AiPanel, SemanticSearchPanel, AnalyticsDashboard + 4 diğer

### ADR-0008 Durumu: **KAPALI** ✅
Frontend framework migration hedefi tam olarak gerçekleştirildi.
