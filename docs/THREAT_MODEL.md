# Bridge — Tehdit Modeli

**Versiyon:** 1.119.0 | **Metodoloji:** STRIDE | **Sprint 119**

Bu belge, bağımsız güvenlik denetimi yapılmana kadar iç tehdit değerlendirmesini belgeler. OWASP Top 10 ve STRIDE üzerine kurulmuştur.

---

## 1. Sistem Sınırları ve Varlık Haritası

```
┌─────────────────────────────────────────────────────────────────┐
│                        İnternet (Güvenilmez)                    │
│                                                                 │
│   Tarayıcı / PWA / Electron / iOS / Android                    │
│         │                                                       │
│   ┌─────▼──────────────────────────────────────────────┐       │
│   │  nginx / HAProxy (TLS Termination)                 │       │
│   │  Reverse Proxy + Rate Limiting                     │       │
│   └─────┬──────────────────────────────────────────────┘       │
│         │                                                       │
│   ┌─────▼──────────────────────────────────────────────┐       │
│   │  Node.js / Express 5 (server/)                     │       │
│   │  REST API + Socket.IO + ActivityPub                │       │
│   │  JWT Auth + Refresh Token Rotation                 │       │
│   └─────┬─────────────┬──────────────┬─────────────────┘       │
│         │             │              │                          │
│   ┌─────▼──┐   ┌──────▼──────┐ ┌────▼────────────┐            │
│   │  PgSQL │   │    Redis    │ │  Mediasoup SFU  │            │
│   │  16+   │   │  Cache+PubS │ │  WebRTC Cluster │            │
│   └────────┘   └─────────────┘ └─────────────────┘            │
│                                                                 │
│   Dış Sistemler: Mastodon/AP Peer | SMTP | S3/R2 | AI API      │
└─────────────────────────────────────────────────────────────────┘
```

### Güven Seviyeleri

| Seviye | Aktörler |
|--------|----------|
| **Güvenilmez** | Anonim internet trafiği, Fediverse peer sunucuları |
| **Kısmen Güvenilir** | Kayıtlı kullanıcılar, bot token sahipleri |
| **Güvenilir** | Sunucu yöneticileri (server owner), operatörler |
| **Tam Güvenilir** | Admin hesabı (ilk kayıt), sistem süreçleri |

---

## 2. STRIDE Tehdit Analizi

### 2.1 Kimlik Sahteciliği (Spoofing)

| # | Tehdit | Etki | Olasılık | Mevcut Kontrol | Durum |
|---|--------|------|----------|----------------|-------|
| S1 | JWT token çalınması + replay | Kritik | Orta | Refresh token rotation, `tokenVersion` revoke | ✅ Önlenmiş |
| S2 | Federation peer kimlik taklit | Yüksek | Düşük | RSA-2048 HTTP Signature (httpSignatureV3) | ✅ Önlenmiş |
| S3 | ActivityPub actor taklit | Yüksek | Orta | RSA key per-actor, WebFinger doğrulama | ✅ Önlenmiş |
| S4 | Bot token çalınması | Yüksek | Orta | `brg_bot_` prefix, DB'de hash saklama | ✅ Önlenmiş |
| S5 | WebAuthn credential phishing | Yüksek | Düşük | Origin binding (FIDO2) | ✅ Önlenmiş |
| S6 | Refresh token reuse detect. eksikliği | Yüksek | Düşük | DB'de family invalidation | ✅ Önlenmiş |
| **S7** | **Admin session hijacking** | **Kritik** | **Düşük** | httpOnly cookie + SameSite; pentest eksik | ⚠️ Doğrulanmamış |

### 2.2 Veri Kurcalama (Tampering)

| # | Tehdit | Etki | Olasılık | Mevcut Kontrol | Durum |
|---|--------|------|----------|----------------|-------|
| T1 | SQL injection (mesaj içeriği) | Kritik | Düşük | Parametreli sorgular (pg), input validation | ✅ Önlenmiş |
| T2 | NoSQL injection (Redis komutları) | Yüksek | Düşük | Sabit komut pattern'ları, input sanitize | ✅ Önlenmiş |
| T3 | Path traversal (dosya yükleme) | Kritik | Düşük | multer + sanitize-filename + UUID rename | ✅ Önlenmiş |
| T4 | Plugin manifest manipulation | Yüksek | Orta | allowlist.ts, WORKER_RESOURCE_LIMITS | ✅ Önlenmiş |
| **T5** | **Mesaj içeriğinde Markdown injection** | **Orta** | **Orta** | DOMPurify (client); server-side eksik | ⚠️ Kısmi |
| **T6** | **ActivityPub payload injection** | **Yüksek** | **Orta** | Şema doğrulama var; fuzz testi eksik | ⚠️ Doğrulanmamış |
| T7 | E2EE anahtar değiştirme (MITM) | Kritik | Düşük | Key fingerprint UI'da gösteriliyor | ✅ Önlenmiş |

### 2.3 İnkar (Repudiation)

| # | Tehdit | Etki | Olasılık | Mevcut Kontrol | Durum |
|---|--------|------|----------|----------------|-------|
| R1 | Admin işlem inkârı | Yüksek | Düşük | `audit_logs` tablosu, değiştirilemez log | ✅ Önlenmiş |
| R2 | Bot işlem inkârı | Orta | Düşük | Bot token + `admin_logs` | ✅ Önlenmiş |
| **R3** | **Federation aktivite inkârı** | **Orta** | **Orta** | `ap_activities` log; dış doğrulama yok | ⚠️ Kısmi |

### 2.4 Bilgi İfşası (Information Disclosure)

| # | Tehdit | Etki | Olasılık | Mevcut Kontrol | Durum |
|---|--------|------|----------|----------------|-------|
| I1 | DM içeriği sızıntısı | Kritik | Düşük | E2EE varsayılan açık (Sprint 115) | ✅ Önlenmiş |
| I2 | JWT secret loglara düşme | Kritik | Düşük | Secrets logger'a geçmez, pino redact | ✅ Önlenmiş |
| I3 | Stack trace production'a yansıma | Orta | Orta | `NODE_ENV=production` hata formatı | ✅ Önlenmiş |
| **I4** | **Rate limit header'ı üzerinden kullanıcı profilleme** | **Orta** | **Düşük** | Standart header'lar dışa açık | ⚠️ Kabul edildi |
| **I5** | **GraphQL/REST endpoint sızıntısı (IDOR)** | **Yüksek** | **Orta** | Yetki kontrolleri var; pentest eksik | ⚠️ Doğrulanmamış |
| I6 | AP private key sızıntısı | Kritik | Düşük | AES-256-GCM ile şifreli, ayrı tablo | ✅ Önlenmiş |
| **I7** | **WebRTC STUN/TURN IP sızıntısı** | **Orta** | **Orta** | TURN sunucusu zorunlu yapılmamış | ⚠️ Kısmi |

### 2.5 Hizmet Engeli (Denial of Service)

| # | Tehdit | Etki | Olasılık | Mevcut Kontrol | Durum |
|---|--------|------|----------|----------------|-------|
| D1 | Login kaba kuvvet | Yüksek | Orta | Rate limiting (10/dk), IP ban | ✅ Önlenmiş |
| D2 | Mesaj spam | Yüksek | Orta | Socket rate limiting + IP ban | ✅ Önlenmiş |
| D3 | Dosya yükleme DDoS | Yüksek | Düşük | Rate limit + MAX_FILE_SIZE_MB | ✅ Önlenmiş |
| D4 | Regex ReDoS (validate.ts) | Orta | Düşük | Regex karmaşıklık kontrolü yapıldı | ✅ Önlenmiş |
| **D5** | **WebSocket bağlantı tükenmesi** | **Yüksek** | **Orta** | Socket.IO limit yok; max-conn eksik | ⚠️ Açık |
| **D6** | **ActivityPub inbox flood** | **Yüksek** | **Orta** | Signature doğrulama var; rate limit yok | ⚠️ Açık |
| **D7** | **pgvector embedding kaynak tükenmesi** | **Orta** | **Düşük** | Batch boyut sınırı var; concurrent limit yok | ⚠️ Kısmi |

### 2.6 Yetki Yükseltme (Elevation of Privilege)

| # | Tehdit | Etki | Olasılık | Mevcut Kontrol | Durum |
|---|--------|------|----------|----------------|-------|
| E1 | Kanal izin bypass | Kritik | Düşük | permCache.ts + DB doğrulama | ✅ Önlenmiş |
| E2 | Bot admin flag atama | Kritik | Düşük | `isAdmin` sadece human hesaplara | ✅ Önlenmiş |
| **E3** | **Plugin sandbox escape** | **Kritik** | **Düşük** | vm.Script izolasyonu; fuzzing eksik | ⚠️ Doğrulanmamış |
| **E4** | **Federation peer'ı admin yapma** | **Kritik** | **Çok Düşük** | Federation endpoint'leri auth'lu; test yok | ⚠️ Doğrulanmamış |
| E5 | Role kademeli yetki bypass | Yüksek | Düşük | Granüler kanal izinleri + `channel_overrides` | ✅ Önlenmiş |

---

## 3. Kritik Açık Riskler (Öncelik Sırası)

### 🔴 Yüksek Öncelikli

**D5 — WebSocket bağlantı limitsizliği**
```
Risk: Tek IP'den yüzlerce WS bağlantısı açılabilir → bellek tükenmesi
Düzeltme önerisi:
  // server/socket/index.ts
  const MAX_WS_PER_IP = parseInt(process.env.MAX_WS_PER_IP || '10');
  io.use((socket, next) => {
    const ip = socket.handshake.address;
    const count = [...io.sockets.sockets.values()]
      .filter(s => s.handshake.address === ip).length;
    if (count >= MAX_WS_PER_IP) {
      return next(new Error('Too many connections from this IP'));
    }
    next();
  });
```

**D6 — ActivityPub inbox flood**
```
Risk: Kötü niyetli Fediverse sunucusu saniyede binlerce aktivite gönderebilir
Düzeltme önerisi: /api/federation/inbox rotasına ayrı rate limiter:
  rateLimiter('federation-inbox', { max: 100, windowMs: 60_000 })
  // Peer bazlı rate limit için federation_peers.last_activity güncellenmeli
```

### 🟡 Orta Öncelikli

**T5 — Server-side markdown sanitization eksikliği**
```
Mevcut: DOMPurify yalnızca client'ta
Düzeltme: server/lib/contentScanner.ts'e sanitize adımı ekle
  import createDOMPurify from 'isomorphic-dompurify';
  export function sanitizeMarkdown(input: string): string {
    return createDOMPurify.sanitize(input, { ALLOWED_TAGS: [] });
  }
```

**I7 — WebRTC IP sızıntısı**
```
Risk: ICE candidate müzakeresinde gerçek IP açığa çıkabilir
Düzeltme: TURN sunucusunu zorunlu kıl veya kullanıcıya uyar:
  // server/.env.example'a ekle:
  FORCE_TURN=false  # true yapınca STUN devre dışı
```

---

## 4. XSS Yüzey Analizi

Bridge'in XSS saldırı yüzeyi iki katmanda incelenmelidir:

### Client-side (Svelte)
Svelte 5 Runes template'lerde otomatik escape uygular — `{user.displayName}` ifadeleri güvenlidir. Risk yalnızca `@html` direktifinde doğar.

```bash
# @html kullanımlarını say
grep -rn "@html" client/js --include="*.svelte" | grep -v "test\|story"
```

Mevcut `@html` kullanımları incelenmeli: her biri DOMPurify geçmeli.

### Server-side (link preview, embed)
`routes/linkPreview.ts` dış URL'den içerik çeker — bu içerik client'a gönderilir. Çekilen içerik sanitize edilmeli.

---

## 5. Güvenlik Konfigürasyon Kontrol Listesi

Production'a geçmeden önce her madde doğrulanmalıdır:

- [ ] `JWT_SECRET` ≥ 64 char random — `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
- [ ] `REFRESH_SECRET` farklı ve ≥ 64 char
- [ ] `FEDERATION_SECRET` belirlendi veya per-peer RSA kullanılıyor
- [ ] `NODE_ENV=production` — stack trace gizlenir
- [ ] `CORS_ORIGIN` yalnızca kendi domain'in
- [ ] `MAX_FILE_SIZE_MB` makul bir değer (varsayılan 2048 çok yüksek olabilir)
- [ ] Redis `requirepass` yapılandırıldı
- [ ] PostgreSQL dış erişim kapalı (yalnızca localhost/container)
- [ ] nginx/HAProxy'de TLS 1.2+ zorunlu, SSLv3/TLS1.0 devre dışı
- [ ] `HSTS` header aktif (`Strict-Transport-Security: max-age=31536000`)
- [ ] `X-Frame-Options: DENY` veya `Content-Security-Policy: frame-ancestors 'none'`
- [ ] Uploads dizini web root dışında veya `Content-Disposition: attachment` ile servis ediliyor
- [ ] `SMTP_PASS` vault'dan çekiliyor (env'de plaintext değil)
- [ ] ActivityPub private key rotasyon planı belgelenmiş (`AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md`)
- [ ] Admin hesabı 2FA aktif
- [ ] Audit log saklama süresi belirlendi (GDPR/KVKK için ≤ 90 gün önerilir)

---

## 6. Bağımlılık Risk Matrisi

```bash
# Düzenli çalıştır:
cd server && npm audit --audit-level=moderate --production

# Otomatik güncelleme önerisi:
npx npm-check-updates -u --target minor
```

Kritik bağımlılıklar ve güvenlik notları:

| Paket | Versiyon | Risk | Not |
|-------|----------|------|-----|
| `jsonwebtoken` | ^9 | Orta | Algorithm confusion saldırısına karşı `algorithms: ['HS256']` sabitleniyor |
| `socket.io` | ^4.6 | Düşük | Engine.IO DoS CVE'leri v4.6+ ile kapatıldı |
| `multer` | ^1.4.5-lts | Orta | lts versiyonu kullanılıyor; ReDoS fix içeriyor |
| `express` | ^5 | Düşük | v5 RC — major güvenlik iyileştirmeleri |
| `helmet` | ^7 | Düşük | CSP, HSTS, X-Frame-Options varsayılan aktif |
| `mediasoup` | latest | Orta | WebRTC bileşeni — native addon, CVE takibi kritik |

---

## 7. Fuzz Test Hedefleri

Bağımsız güvenlik denetiminden önce şu girişler için fuzz test önerilir:

```bash
# 1. ActivityPub inbox payload fuzz
# Araç: ffuf veya Burp Intruder
# Hedef: POST /ap/users/:username/inbox
# Payload: activity type'ları, actor field'ları, object varyasyonları

# 2. Mesaj içeriği XSS fuzz
# Hedef: POST /api/channels/:id/messages
# Payload: XSS vector sözlükleri (SecLists/XSS)

# 3. Dosya yükleme MIME bypass
# Hedef: POST /api/upload
# Payload: SVG/polyglot dosyalar, PHP-in-JPEG

# 4. Plugin manifest fuzz
# Hedef: Plugin allowlist.ts validateManifest()
# Payload: Uzun string'ler, özel karakterler, unicode normalizasyon saldırıları

# 5. JWT algorithm confusion
# araç: jwt_tool
# jwt_tool <token> -X a  # Algorithm confusion (none/RS256→HS256)
```

---

## 8. Güvenlik Test Takvimi (Önerilen)

| Zaman | Eylem |
|-------|-------|
| Şimdi (Sprint 119) | Bu tehdit modelini gözden geçir, D5/D6 düzelt |
| Sprint 120 | T5 server-side sanitization ekle, I7 TURN konfigürasyonu belgele |
| Sprint 121 | Bağımsız güvenlik araştırmacısı veya hata ödülü programı başlat |
| Production öncesi | Kapsamlı pentest (OWASP WSTG metodolojisi) |
| 6 ayda bir | `npm audit` + bağımlılık güncelleme + bu belgeyi gözden geçir |

---

## 9. Referanslar

- [OWASP Top 10 2021](https://owasp.org/www-project-top-ten/)
- [OWASP Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
- [ActivityPub Güvenlik Notları — W3C](https://www.w3.org/TR/activitypub/#security-considerations)
- [WebRTC Güvenlik Mimarisi — RFC 8826](https://www.rfc-editor.org/rfc/rfc8826)
- [JWT Güvenlik En İyi Pratikleri — RFC 8725](https://www.rfc-editor.org/rfc/rfc8725)
- [STRIDE Metodolojisi — Microsoft](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)

---

*Son güncelleme: Sprint 119 — Bu belge canlı bir belgedir. Her sprint sonunda tehdit tabloları gözden geçirilmeli ve ⚠️ durumundaki maddeler takip edilmelidir.*
