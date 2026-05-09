# Bridge'e Katkıda Bulunma

Bridge açık kaynak bir projedir. Her türlü katkıya açığız!

## Başlamak

```bash
git clone https://github.com/your-org/bridge.git
cd bridge/server
npm install
cp .env.example .env   # JWT_SECRET ve REFRESH_SECRET doldur
npm start
```

## Pull Request Süreci

1. Repo'yu fork'la
2. Feature branch oluştur: `git checkout -b feature/ozellik-adi`
3. Testlerin geçtiğinden emin ol: `npm test`
4. Değişikliklerini commit'le: `git commit -m 'feat: kısa açıklama'`
5. Branch'i push'la: `git push origin feature/ozellik-adi`
6. Pull Request aç

## Commit Mesaj Formatı

[Conventional Commits](https://www.conventionalcommits.org/) standardını kullanıyoruz:

```
feat: yeni özellik
fix: hata düzeltmesi
docs: dokümantasyon güncellemesi
refactor: kod yeniden düzenleme (özellik/hata yok)
test: test ekleme/düzenleme
chore: build, bağımlılık güncellemeleri
```

## Testler

```bash
cd server
npm test              # Tüm testler
npm run test:coverage # Coverage raporu (%70 eşik)
```

Yeni özellikler için test yazılması beklenir.

## Kod Stili

- ESLint kurallarına uy: `npm run lint`
- `'use strict'` direktifi kullan
- Async/await tercih et, callback zinciri kullanma
- Türkçe yorum yazabilirsin — proje Türkçe topluluğa odaklanıyor

## Sorun Bildirimi

[Issues](https://github.com/your-org/bridge/issues) sayfasını kullan.  
Güvenlik açıkları için lütfen önce özel mesaj at.

## Lisans

Katkılarınız MIT lisansı altında yayınlanacaktır.
