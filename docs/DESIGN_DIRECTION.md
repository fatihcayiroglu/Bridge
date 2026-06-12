# Bridge — Tasarım Yönü (Kimlik v2)

## Vizyon

Bridge, **Discord kopyası değil**. Self-host, federasyon destekli, gizlilik odaklı **iletişim altyapısıdır**.

| Discord | Bridge |
|---------|--------|
| Kapalı platform | Açık kaynak + senin sunucun |
| Sunucu metaforu | **Hub → Space → Flow** (köprü metaforu) |
| Mor (#5865f2) kimlik | **Köprü mavisi** (teal-indigo) + **amber** vurgu |
| Nitro ile özellik kilidi | Tüm özellikler ücretsiz |

## Renk sistemi

Kaynak: `client/css/tokens.css`

| Token | Değer | Kullanım |
|-------|-------|----------|
| `--brand` | `hsl(210, 88%, 58%)` ≈ `#2d9cdb` | Birincil aksiyon, linkler |
| `--accent` | amber `hsl(38, 95%, 58%)` | Bildirim, vurgu, CTA ikincil |
| `--brand-hex` | `#2d9cdb` | Canvas, meta theme-color, QR |
| `--teal` | `#1bc8a8` | Gradyan ikinci ton |

**Yasak:** `#5865f2`, `#7289da` (Discord paleti) — kod taramasında kaldırıldı.

TypeScript sabitleri: `server/lib/brandDefaults.ts`

## Layout modları

| Mod | Açıklama | CSS |
|-----|----------|-----|
| `classic` | Üç sütun (geçiş dönemi) | varsayılan |
| `focus` | Hub rail gizli, sohbet odaklı | `body[data-layout="focus"]` |
| `compact` | Dar topic listesi | `body[data-layout="compact"]` |

Kullanıcı ayarı: Ayarlar → Görünüm → Düzen.  
API: `localStorage.bridgeLayout`

## Terminoloji (UI metinleri)

| Eski (Discord) | Bridge |
|----------------|--------|
| Sunucu | Hub |
| Kanal | Space |
| #genel | ◆ genel (veya sembolsüz) |
| Sunucular | Köprüler / Hub'lar |

Kodda CSS sınıf adları geçiş sürecinde `server-*` / `channel-*` kalabilir; kullanıcıya görünen metinler güncellenir.

## Pazarlama dili

- ✅ “Self-host iletişim platformu”
- ✅ “Federasyon ve E2EE ile birlikte çalış”
- ⚠️ “Discord alternatifi” yalnızca karşılaştırma tablosunda
- ❌ “Daha iyi Discord” ana başlık olarak

## discord-shim

`discord-shim/` yalnızca **bot uyumluluk katmanıdır**; ana ürün kimliği Bridge'dir.

## Yol haritası

Bkz. [ROADMAP.md](../ROADMAP.md) → “UI Kimlik v2”
