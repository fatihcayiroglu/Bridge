# _legacy/ Bağımlılık Raporu — Sprint 118 Silme Öncesi

**Tarih:** Sprint 117 tamamlanma  
**Amaç:** Sprint 118'de `_legacy/` dizinlerinin güvenle silinebileceğini doğrula

---

## Özet: Sıfır Dış Bağımlılık ✅

Tüm `_legacy/` dizinleri **yalnızca kendi içlerinde çapraz bağımlıdır**.
Aktif kaynak ağacından `_legacy/`'ye sıfır import yapılmaktadır.
Sprint 118'de tüm `_legacy/` dizinleri güvenle silinebilir.

---

## 1. `client/js/core/_legacy/`

| Metrik | Değer |
|--------|-------|
| Toplam `.ts` dosyası | 171 |
| Aktif core'dan gelen import | **0** |
| Svelte bileşenlerinden gelen import | **0** |
| Kendi içinde çapraz bağımlı dosya | 121 |
| Tamamen izole (hiç dış bağımlılığı olmayan) | 50 |

### Durum

Sprint 116 geçişiyle tüm modüller Svelte mimarisine taşındı.
`_legacy/` içindeki dosyalar `./utils.ts`, `./globals.ts`, `./api-fetch.ts`
gibi **yine `_legacy/` içindeki** modüllere import yapmaktadır.
Aktif Svelte şimleri (`globals-svelte.ts`, `utils-svelte.ts` vb.) bu
modüllere artık bağımlı değil; kendi bağımsız bağımlılık grafiğini kullanıyor.

### Sprint 118 Aksiyonu

```bash
rm -rf client/js/core/_legacy/
```

### Dikkat: utils / api-fetch / i18n

Bu üç modül aktif core'da **svelte karşılığıyla** değiştirildi:

| _legacy modülü | Aktif karşılığı |
|---------------|-----------------|
| `_legacy/utils.ts` | `UtilsPanel.svelte` + `utils-svelte.ts` |
| `_legacy/api-fetch.ts` | `ApiFetchManager.svelte` (ADR-0008 Faz 3) |
| `_legacy/i18n.ts` | `I18nProvider.svelte` + `i18n-svelte.ts` |

---

## 2. `electron/_legacy/`

| Dosya | Durum |
|-------|-------|
| `main.js` | ✅ `main.ts` yazıldı |
| `preload.js` | ✅ `preload.ts` yazıldı |
| `jest.electron.config.js` | ✅ `jest.electron.config.ts` yazıldı |

Aktif `electron/` dizininde bu dosyaları import eden sıfır referans.

### Sprint 118 Aksiyonu

```bash
rm -rf electron/_legacy/
```

---

## 3. `electron/tests/_legacy/`

| Dosya | Durum |
|-------|-------|
| `main.test.js` | ✅ `tests/main.test.ts` yazıldı |
| `__mocks__/electron.js` | ✅ `tests/__mocks__/electron.ts` yazıldı |
| `__mocks__/electron-updater.js` | ✅ `tests/__mocks__/electron-updater.ts` yazıldı |

### Sprint 118 Aksiyonu

```bash
rm -rf electron/tests/_legacy/
```

---

## Tam Silme Komutu (Sprint 118)

```bash
# Güvenlik kontrolü — önce çalıştır, çıktı boş olmalı
grep -r "_legacy" \
  client/js/core \
  electron \
  --include="*.ts" \
  --include="*.svelte" \
  --exclude-dir="_legacy" \
  -l

# Yukarıdaki komut boş çıktı verirse sil:
rm -rf client/js/core/_legacy/
rm -rf electron/_legacy/
rm -rf electron/tests/_legacy/
```

---

## Doğrulama Kontrol Listesi

- [x] `client/js/core/_legacy/`'ye sıfır aktif import
- [x] `electron/_legacy/`'ye sıfır aktif import  
- [x] Tüm electron dosyaları TS'e çevrildi
- [x] Tüm electron testleri TS'e çevrildi
- [x] `_legacy/utils.ts` → aktif `utils-svelte.ts` + `UtilsPanel.svelte` ile değiştirildi
- [x] `_legacy/api-fetch.ts` → aktif `ApiFetchManager.svelte` ile değiştirildi
- [x] `_legacy/i18n.ts` → aktif `I18nProvider.svelte` + `i18n-svelte.ts` ile değiştirildi
