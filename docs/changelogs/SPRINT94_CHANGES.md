# Sprint 94 — Topluluk Analitiği + Announcement Crosspost + Temizlik

## 1. 📊 Topluluk Analitiği (4 Yeni Endpoint)

**`server/routes/stats.ts`** — 57 satırdan 239 satıra, PostgreSQL native SQL.

| Endpoint | Açıklama |
|---|---|
| `GET /servers/:sid/stats` | Özet: üye, mesaj, aktif kullanıcı, top 10, kanal dağılımı |
| `GET /servers/:sid/stats/growth?days=30` | Günlük join + kümülatif büyüme + mesaj serisi |
| `GET /servers/:sid/stats/activity` | Saatlik heatmap + haftanın günü dağılımı + peak time |
| `GET /servers/:sid/stats/retention` | DAU/WAU/MAU + DAU:MAU oranı + sağlık göstergesi |

**Client:** `client/js/core/analytics-dashboard.ts` — Chart.js entegrasyonu, heatmap, retention grid, top users bar chart.

---

## 2. 📢 Announcement Kanalı Crosspost/Follow

**`server/routes/announcement.ts`** (234 satır)

- `POST   /channels/:cid/follow` — Başka sunucudan kanalı takip et
- `DELETE /channels/:cid/follow` — Takibi bırak
- `GET    /channels/:cid/followers` — Takipçi listesi
- `POST   /channels/:cid/messages/:mid/crosspost` — Publish: tüm takipçilere socket + DB

**Client:** `client/js/core/announcement-ui.ts`
- Kanal başlığına `📢 Announcement` badge + "Takip Et" + "Takipçiler" butonları
- Mesaj hover'ına "📢 Publish" butonu (announcement kanallarında)
- Follow modal (kanal ID ile)

**DB:** `channel_follows` tablosu — migration `012_sprint94_channel_follows.sql`

---

## 3. 🧹 Teknik Borç Temizliği

| Dosya | Değişiklik |
|---|---|
| `SettingsModal.svelte:123` | Asla tetiklenmeyen `{:else}` ghost fallback kaldırıldı |
| `server/routes/stats.ts` | MongoDB `$gt` syntax → saf PostgreSQL SQL |

---

## Parité Durumu (Sprint 94 Sonrası)

| Özellik | Öncesi | Sonrası |
|---|---|---|
| Topluluk analitiği | 1/10 | 8/10 |
| Announcement crosspost | 0/10 | 9/10 |
| Genel Discord parité | ~8.5/10 | **~9.1/10** |

## Kalan

- **Rol Aboneliği / Creator Monetizasyon** — bilinçli ertelendi (Stripe)
