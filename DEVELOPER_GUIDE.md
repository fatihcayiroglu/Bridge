# Bridge — Geliştirici Rehberi

Hoş geldiniz! Bridge projesi açık kaynak ve katkılara açıktır. Bu rehberde nasıl kurulum yapacağınızı, testlerin nasıl çalıştırılacağını ve kod standartlarını öğreneceksiniz.

## Hızlı Başlangıç

### Gereksinimler
- **Node.js**: 22.x veya üstü
- **npm**: 10.x veya üstü
- **PostgreSQL**: 14+
- **Redis**: 7+

### Kurulum

```bash
# 1. Repository'yi klonla
git clone https://github.com/your-org/bridge.git
cd bridge

# 2. Dependencies'leri yükle
npm install

# 3. Environment dosyasını oluştur
cp .env.example .env
# .env'i düzenle: JWT_SECRET, REFRESH_SECRET, DATABASE_URL, REDIS_URL

# 4. Veritabanını hazırla
cd server
npm run db:migrate:pg

# 5. Geliştirme sunucusunu başlat
npm run dev
```

Server: `http://localhost:3001`

## Komutlar

### Geliştirme
```bash
# Sunucuyu nodemon ile başlat (otomatik reload)
npm run dev

# Client watch mode'ı
npm run build:watch

# Tüm değişiklikleri izle
npm run verify:all
```

### Kalite Kontrol
```bash
# TypeScript type checking
npm run typecheck          # Her ikisi
npm run typecheck:client   # Sadece client
npm run typecheck:server   # Sadece server

# ESLint linting
npm run lint              # Hataları kontrol et
npm run lint:fix          # Otomatik düzelt

# Testleri çalıştır
npm run test              # Tüm testler
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage raporu
npm run test:security     # Güvenlik testleri
npm run test:socket       # Socket.IO testleri
```

### Build
```bash
# Production build
npm run build

# Build analizi (bundle size)
npm run build:analyze

# Bundle budget kontrolü
npm run build:budget
```

## Kod Standartları

### TypeScript
- `strict: false` - Kademeli geçiş için (yeni kod strict yapılmalı)
- `noImplicitAny: false` - Kademeli tip ekleme
- Tüm yeni kod TypeScript'te yazılmalı
- Type annotations'lar kullanılmalı

### ESLint Kuralları
- Unused variables prefix'e `_` ekle: `const _unused = ...`
- max-len: 120 characters
- Semicolon zorunlu
- Single quotes tercih edilir

### Git İş Akışı

```bash
# 1. Kendi branch'ini oluştur
git checkout -b feature/your-feature-name

# 2. Değişiklikleri yap
git add .
git commit -m "feat: clear description of change"

# 3. Push et
git push origin feature/your-feature-name

# 4. GitHub'da PR açıkısını açıkla
```

### Commit Mesajları (Conventional Commits)
```
feat:  Yeni özellik
fix:   Bug düzeltme
docs:  Dokümantasyon
style: Kod formatı
test:  Test ekleme
chore: Build, CI/CD, bağımlılık
```

Örnek:
```
feat: add user authentication with WebAuthn

- Implement FIDO2 registration and authentication
- Add rate limiting for auth attempts
- Store credentials in PostgreSQL with encryption
```

## Test Yazma

### Test Dosyası Oluştur
```javascript
// tests/myfeature.test.js
const { createMockRequest, createMockResponse } = require('./helpers/mocks');

describe('My Feature', () => {
  it('should do something', () => {
    const req = createMockRequest({ body: { name: 'test' } });
    const res = createMockResponse();
    
    // Test logic
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
```

### Test Araçları
- **Jest**: Test runner ve assertion library
- **Supertest**: HTTP assertion library
- **Mock helpers**: `tests/helpers/mocks.js`

## CI/CD Pipeline

Tüm PR'lar için otomatik:
- ✅ TypeScript typecheck
- ✅ ESLint lint
- ✅ Jest testleri (Redis + PostgreSQL)
- ✅ Bundle size check

## Sık Sorulan Sorular

**P: Test ortamı nasıl kurulur?**
A: CI/CD pipeline Docker compose ile test veritabanlarını başlatır. Local'de:
```bash
# Redis
redis-server

# PostgreSQL (ayrı terminal)
createdb bridge_test
```

**P: TypeScript hataları alıyorum?**
A: `npm run typecheck` çalıştır ve hataları düzelt. Veya:
```bash
npm run typecheck -- --pretty
```

**P: ESLint hataları otomatik düzeltilir mi?**
A: Evet:
```bash
npm run lint:fix
```

**P: Deployment nasıl yapılır?**
A: Main branch'e merge olunca otomatik production'a push olur. Develop'e merge olunca staging'e.

## Kaynaklar

- **API Docs**: [Server API Documentation](./server/API_VERSIONING.md)
- **Architecture**: [Modülerlik Dokümantasyonu](./MODULARITY.md)
- **Deployment**: [Deployment Guide](./docs/DEPLOYMENT_GUIDE.md)
- **Database**: [PostgreSQL Migration](./docs/POSTGRES_MIGRATION.md)

## Yardım

- Discord: [Topluluğa katıl](https://bridge.example.com/discord)
- GitHub Issues: [Sorun bildir](https://github.com/your-org/bridge/issues)
- GitHub Discussions: [Soru sor](https://github.com/your-org/bridge/discussions)

---

**Teşekkürler Bridge'e katkıda bulunduğunuz için!** 🌉
