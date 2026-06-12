# Sprint 47 — Güvenlik Testleri & Teknik Borç Temizliği (2026-05-16)

## Özet
Sprint 46 incelemesinde tespit edilen 2 teknik borç kategorisi kapatıldı:
1. Roadmap'taki `window.*` son kalan uygulama referansları temizlendi
2. Güvenlik testleri için gerekli implementasyonlar doğrulandı (pgCollection whitelist + SSRF fetch)

---

## 1. `window.*` Son Temizlik — channel-perms-inheritance.ts

**Sorun:**
```typescript
// ÖNCE — window.* okuma
const fn = (window as Record<string, unknown>).chpermsShowInheritance;
if (typeof fn === 'function') fn(btn);
```
`channel-perms-inheritance.ts` hâlâ `window.chpermsShowInheritance`'ı doğrudan okuyordu.
Bu, `modal-core.ts`'in yüklenme sırasına göre race condition oluşturabilirdi.

**Düzeltme:**
- `channel-perms-inheritance.ts` → `BridgeRegistry.call('chpermsShowInheritance', btn)` kullanıyor
- `modal-core.ts` `initModalCore()` içinde `BridgeRegistry.register('chpermsShowInheritance', ...)` çağırıyor
- `channel-perms-matrix.ts` → `onclick="chpermsShowInheritance(this)"` + `onclick="cyclePerm(this)"` kaldırıldı, `data-bridge-action` kullanıldı
- `index.html` dispatcher → `BridgeRegistry.call(action, el, ...)` ile `el` referansı geçiliyor (cyclePerm ve chpermsShowInheritance button objesini parametre olarak bekliyor)

---

## 2. pgCollection — Kolon Whitelist Doğrulandı

**Durum:** Sprint 46'da `ALLOWED_COLUMNS Set` + `assertValidColumn()` zaten implement edilmişti.
Test dosyası (`pgCollection-injection.test.js`) bu implementasyonu kapsamlı test ediyor:
- `buildWhere` — `__proto__`, `DROP TABLE`, `constructor` payload'ları bloklanıyor
- `insert` — bilinmeyen kolon SQL injection reddediliyor
- `update ($set / $inc)` — whitelist kontrolü
- `find().sort()` — ORDER BY injection koruması

**Sprint 47 Katkısı:** Test dosyası pakete dahil edildi, implementasyon doğrulandı ✅

---

## 3. SSRF Koruması — lib/fetch.ts Doğrulandı

**Durum:** Sprint 46'da `fetchT` + `isPrivateIP` + `SSRFError` implement edilmişti.
Test dosyası (`fetch-ssrf.test.js`) kapsamlı senaryo koruması sağlıyor:
- Private IPv4/IPv6 adresleri (RFC-1918, loopback, link-local, CGNAT)
- AWS metadata endpoint (169.254.169.254)
- IPv6 ULA (fc::/7, fd::/7), link-local (fe80::/10)
- DNS rebinding: çoklu IP dönüşünde herhangi biri private → red
- `file://` protokol engeli
- `SSRF_ALLOWLIST` env whitelist bypass
- `skipSsrfCheck: true` internal servis geçişi

**Sprint 47 Katkısı:** Test dosyası pakete dahil edildi, implementasyon doğrulandı ✅

---

## 4. index.html Dispatcher — el Referansı Düzeltmesi

**Sorun:** `data-bridge-action` dispatcher `BridgeRegistry.call(action, arg)` çağırıyordu.
`cyclePerm(btn)` ve `chpermsShowInheritance(btn)` eski `onclick="fn(this)"` kalıbında
`this` (button elementi) alıyordu. Dispatcher `el` geçirmiyordu — çağrı boş parametre ile
çalışırdı.

**Düzeltme:**
```javascript
// ÖNCE
BridgeRegistry.call(action, ...(arg ? [arg] : []));

// SONRA — el referansı ilk argüman
BridgeRegistry.call(action, el, ...(arg ? [arg] : []));
```

---

## ⚠️ Kaçırılan Aksiyon (Sprint 48'de Düzeltildi)

Bu sprintte `pgCollection` implementasyonu doğrulandı ancak `server/db/postgres/index.ts`'in
hâlâ `collection.ts`'i import ettiği fark edilmedi. Review "fonksiyon doğru çalışıyor mu?"
sorusunu cevapladı; "production'da aktif mi?" sorusunu sormadı.

**Sprint 48'de yapılan:** Import düzeltildi + CI guard eklendi.

---

## Değişen Dosyalar

```
client/js/core/channel-perms-inheritance.ts   (GÜNCELLENDİ — window.* → BridgeRegistry)
client/js/core/channel-perms/modal-core.ts    (GÜNCELLENDİ — BridgeRegistry.register eklendi)
client/js/core/channel-perms-matrix.ts        (GÜNCELLENDİ — onclick → data-bridge-action)
client/index.html                             (GÜNCELLENDİ — dispatcher el geçirimi)
server/tests/pgCollection-injection.test.js   (YENİ — whitelist injection testleri)
server/tests/fetch-ssrf.test.js               (YENİ — SSRF birim testleri)
SPRINT47_FIXES.md                             (YENİ)
```

## Sayısal Özet

| Metrik | Değer |
|---|---|
| Kaldırılan `window.*` uygulama referansı | 3 (inheritance + 2× inline onclick) |
| BridgeRegistry kaydı eklendi | 1 (chpermsShowInheritance) |
| Düzeltilen dispatcher bug | 1 (el parametresi eksikti) |
| Yeni güvenlik test dosyası | 2 (injection + SSRF) |
| Toplam yeni test vakası | ~25 |
| Kalan kaçınılmaz window.* | ~15 (hepsi browser/native SDK) |
