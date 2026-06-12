# Bridge Desktop otomatik güncelleme sistemi

Bridge Desktop artık Discord benzeri bir güncelleme akışı kullanır.

## Akış

1. Paketlenmiş Electron uygulaması açıldıktan kısa süre sonra güncelleme kontrolü yapılır.
2. Kontrol her 30 dakikada bir arka planda tekrar edilir.
3. Yeni sürüm bulunursa otomatik olarak indirilir.
4. İndirme tamamlandığında uygulama içinde küçük bir panel ve işletim sistemi bildirimi gösterilir.
5. Kullanıcı **Yeniden başlat ve kur** dediğinde `electron-updater.quitAndInstall(false, true)` çağrılır.

Geliştirme ortamında otomatik güncelleme varsayılan olarak kapalıdır. Test etmek için:

```bash
BRIDGE_UPDATER_FORCE=true cd electron && npm start
```

## Yayın gereksinimleri

Auto-update'in çalışması için GitHub Release içinde installer dosyalarıyla birlikte update metadata dosyaları da bulunmalıdır:

- Windows: `latest.yml`
- macOS: `latest-mac.yml`
- Linux: `latest-linux.yml`

Bu dosyalar `electron-builder` tarafından üretilir ve `.github/workflows/electron-release.yml` workflow'u bunları release'e yükler.

## Release çıkarma

```bash
git tag v1.123.0
git push origin v1.123.0
```

Tag push sonrası workflow Windows, macOS ve Linux paketlerini üretir. Release draft olarak oluşturulursa otomatik güncelleme istemcileri tarafından görünmesi için release'i GitHub'da publish etmek gerekir.

## Manuel kontrol

Kullanıcı tarafında iki manuel yol var:

- Uygulama menüsü: **Bridge → Güncellemeleri Kontrol Et**
- Tray menüsü: **Güncellemeleri Kontrol Et**

Güncelleme indirildikten sonra hem menüden hem uygulama içi panelden yeniden başlatma kurulumu tetiklenebilir.

## Ortam değişkenleri

| Değişken | Açıklama |
| --- | --- |
| `BRIDGE_UPDATE_INTERVAL_MS` | Periyodik kontrol aralığı. Minimum 5 dakika. Varsayılan 30 dakika. |
| `BRIDGE_UPDATE_CHANNEL=beta` | Pre-release/beta güncellemeleri almak için. |
| `BRIDGE_UPDATER_FORCE=true` | Dev ortamında updater akışını zorla açmak için. |

## İlgili dosyalar

- `electron/updater.ts`
- `electron/main.ts`
- `electron/preload.ts`
- `client/js/core/desktop-updater.ts`
- `.github/workflows/electron-release.yml`
