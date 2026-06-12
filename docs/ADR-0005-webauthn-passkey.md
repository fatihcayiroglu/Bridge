# ADR-0004: WebAuthn / Passkey Kimlik Doğrulama

## Status
Accepted

## Context

Bridge, kullanıcı kimlik doğrulaması için kullanıcı adı + şifre + isteğe bağlı TOTP 2FA kullanıyordu. Şifresiz giriş (passkey) desteği eklenmesi için üç seçenek değerlendirildi:

1. **Magic link (e-posta tabanlı)** — şifre gerektirmez, ancak e-posta altyapısına bağımlılık yaratır ve kurumsal ortamlarda e-posta gecikmeleri UX sorununa yol açar.
2. **OAuth2 / SSO'ya tam geçiş** — mevcut SSO entegrasyonunu genişletir, ancak self-hosted kurulumlar için harici provider zorunluluğu bağımsızlığı kısıtlar.
3. **FIDO2 / WebAuthn (W3C standardı)** — cihaz tabanlı kimlik doğrulama, server-side şifre depolamaz, phishing direnci yüksek, modern tarayıcılarda yerleşik destek.

## Decision

WebAuthn (FIDO2) entegrasyonu `server/routes/webauthn.ts` olarak uygulandı. Mevcut şifre + TOTP akışı korundu; WebAuthn ek bir giriş yöntemi olarak sunuldu.

**Akış:**
- Kayıt: `POST /api/webauthn/register/begin` → challenge al → `POST /api/webauthn/register/complete` → credential kaydet
- Giriş: `POST /api/webauthn/login/begin` → challenge al → `POST /api/webauthn/login/complete` → doğrula + JWT ver
- Yönetim: `GET /api/webauthn/credentials` (liste) / `DELETE /api/webauthn/credentials/:id` (sil)

Credential'lar kullanıcı belgesinde `webauthnCredentials[]` dizisi olarak saklanır; her kayıt `credentialId`, `publicKey`, `counter` ve `deviceName` içerir.

Challenge'lar kısa süreli (5 dakika) ve tek kullanımlık olarak session store'da tutulur.

## Uygulama Detayları

| Bileşen | Dosya |
|---------|-------|
| Server route'ları | `server/routes/webauthn.ts` |
| Client UI | `client/js/webauthn.ts` |
| Tip tanımları | `WebAuthnUser` interface (`server/routes/webauthn.ts` üstü) |
| Test | `server/tests/webauthn.test.ts` |

## Consequences

**Olumlu:**
- Şifre ihlallerine karşı phishing direnci; credential hiçbir zaman sunucuya iletilmez.
- Mevcut kimlik doğrulama akışlarına dokunulmadı; WebAuthn opt-in.
- W3C standardı — tüm modern tarayıcılarda (Chrome 67+, Safari 14+, Firefox 60+) desteklenir.
- Self-hosted kurulumlar için dış provider bağımlılığı yok.

**Olumsuz / Dikkat Edilecekler:**
- Credential, cihaza bağlıdır; kullanıcı cihazını kaybederse hesap kurtarma akışı şifre tabanlı girişe geri düşer.
- Eski tarayıcılarda (IE, eski Safari) destek yoktur; bu kullanıcılar şifre ile giriş yapmaya devam eder.
- `counter` değeri Authenticator'ün clone tespitinde kullanılır; sunucunun counter'ı her başarılı girişten sonra güncellemesi zorunludur — atlanmamalıdır.
- Çoklu cihaz / platform authenticator (iCloud Keychain, Google Password Manager) senaryolarında aynı kullanıcıya birden fazla credential kaydedilmesi normaldir; bu yönetim UI'ında net gösterilmelidir.
