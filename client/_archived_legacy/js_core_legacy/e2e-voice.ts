// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/E2eVoicePanel.svelte
//              client/js/core/e2e-voice-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/e2e-voice.ts
// Ses Kanalı Uçtan Uca Şifreleme — Voice Channel Encrypted Key Exchange
//
// Nasıl çalışır:
//   1. Ses kanalına katılırken tarayıcıda bir "session key" (AES-GCM 256bit) üretilir
//   2. Kanalda bulunan her peer'ın public key'i ile bu session key şifrelenir
//   3. Şifreli session key'ler signalling kanalı üzerinden gönderilir
//   4. Peer kendi private key'i ile session key'i çözer
//   5. Ses stream metadata'sı (kullanıcı adı, kanal bilgisi) bu key ile şifrelenir
//
// Bu modül e2e.ts'ten Sprint 42'de ayrıldı.
// Bağımlılık: BridgeE2E (e2e.ts) üzerinden public key erişimi sağlanır.

'use strict';
import { BridgeRegistry } from './bridge-registry.js';

import { createLogger } from './logger.js';
const log = createLogger('E2EVoice');



// ══════════════════════════════════════════════════
// SES KANALI E2E — Voice Channel Encrypted Key Exchange
// ══════════════════════════════════════════════════
//
// Nasıl çalışır:
//   1. Ses kanalına katılırken tarayıcıda bir "session key" (AES-GCM 256bit) üretilir
//   2. Kanalda bulunan her peer'ın public key'i ile bu session key şifrelenir
//   3. Åifreli session key'ler signalling kanalı üzerinden gönderilir
//   4. Peer kendi private key'i ile session key'i çözer
//   5. Ses stream metadata'sı (kullanıcı adı, kanal bilgisi) bu key ile şifrelenir
//   6. WebRTC DTLS zaten ses verisini şifreler — bu katman ekstra metadata güvenliği sağlar
//
// NOT: WebRTC'nin DTLS şifrelemesi ses verisini zaten korur.
// Bu katman sunucunun bile göremeyeceği kanal metadata şifrelemesidir.

const _BridgeVoiceE2E = (() => {
  let _sessionKey = null;       // CryptoKey (AES-GCM)
  let _sessionKeyB64 = null;    // Base64 export
  let _enabled = false;

  // ── Session key üret ──────────────────────────────────────
  async function generateSessionKey() {
    _sessionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const raw = await crypto.subtle.exportKey('raw', _sessionKey);
    _sessionKeyB64 = bufToB64(raw);
    return _sessionKeyB64;
  }

  // ── Session key'i peer'ın E2E public key'i ile şifrele ───
  async function encryptSessionKeyForPeer(peerPublicKeyB64) {
    if (!_sessionKeyB64) throw new Error('Session key üretilmemiş');
    // BridgeE2E'nin encryptMessage fonksiyonunu kullan
    const _e2e = BridgeRegistry.get('BridgeE2E') as typeof _BridgeE2E | null;
    if (!_e2e?.getStatus().enabled) return null;
    return await _e2e.encryptMessage(_sessionKeyB64, peerPublicKeyB64);
  }

  // ── Peer'dan gelen şifreli session key'i çöz ─────────────
  async function decryptSessionKey(encryptedKeyData, myUserId) {
    const _e2eD = BridgeRegistry.get('BridgeE2E') as typeof _BridgeE2E | null;
    if (!_e2eD?.getStatus().enabled) return false;
    try {
      const keyB64 = await _e2eD.decryptMessage(encryptedKeyData, myUserId);
      const raw = b64ToBuf(keyB64);
      _sessionKey = await crypto.subtle.importKey(
        'raw', raw,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      _sessionKeyB64 = keyB64;
      return true;
    } catch (e) {
      log.warn('[VoiceE2E] Session key çözülemedi:', e.message);
      return false;
    }
  }

  // ── Metadata şifrele (kullanıcı adı, kanal bilgisi vb.) ──
  async function encryptMetadata(data) {
    if (!_sessionKey) return null;
    try {
      const iv  = crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder().encode(JSON.stringify(data));
      const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        _sessionKey,
        enc
      );
      return bufToB64(iv) + '.' + bufToB64(cipher);
    } catch { return null; }
  }

  // ── Metadata çöz ─────────────────────────────────────────
  async function decryptMetadata(encrypted) {
    if (!_sessionKey || !encrypted) return null;
    try {
      const [ivB64, dataB64] = encrypted.split('.');
      const iv     = b64ToBuf(ivB64);
      const cipher = b64ToBuf(dataB64);
      const plain  = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        _sessionKey,
        cipher
      );
      return JSON.parse(new TextDecoder().decode(plain));
    } catch { return null; }
  }

  // ── Ses kanalına katılırken key exchange başlat ───────────
  async function initVoiceE2E(channelId, peers) {
    const _e2eI = BridgeRegistry.get('BridgeE2E') as typeof _BridgeE2E | null;
    if (!_e2eI?.getStatus().enabled) {
      _enabled = false;
      return false;
    }

    await generateSessionKey();
    _enabled = true;
    log.log('[VoiceE2E] ✅ Session key üretildi — kanal:', channelId);

    // Her peer için session key'i şifrele ve gönder
    for (const peer of peers) {
      try {
        const r = await _apiFetch(`${API}/api/e2e/keys/${peer.userId}`);
        const data = await r.json();
        if (!data.hasKey) continue;

        const encrypted = await encryptSessionKeyForPeer(data.publicKey);
        if (!encrypted) continue;

        // Socket üzerinden gönder
        if (socket) {
          (socket as { emit(e: string, d: unknown): void }).emit('voice:e2e-key', {
            channelId,
            targetUserId: peer.userId,
            encryptedKey: encrypted,
          });
        }
      } catch (e) {
        log.warn('[VoiceE2E] Peer key exchange hatası:', peer.userId, e.message);
      }
    }

    return true;
  }

  // ── Socket event: Peer bizim için key gönderdi ───────────
  function registerSocketEvents(socket, myUserId) {
    socket.on('voice:e2e-key', async ({ fromUserId, encryptedKey }) => {
      if (_sessionKey) return; // zaten key var, ilk geleni kullan
      const ok = await decryptSessionKey(encryptedKey, myUserId);
      if (ok) {
        _enabled = true;
        log.log('[VoiceE2E] ✅ Session key alındı:', fromUserId);
        if (typeof toast === 'function') toast('ğŸ”’ Ses kanalı şifrelendi', 'success');
      }
    });
  }

  function isEnabled() { return _enabled; }
  function clearSession() { _sessionKey = null; _sessionKeyB64 = null; _enabled = false; }

  // ── UI helper: ses kanalındaki E2E durumunu göster ───────
  function renderVoiceE2EBadge() {
    let badge = document.getElementById('voice-e2e-badge');
    if (!_enabled) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'voice-e2e-badge';
      badge.style.cssText = 'position:absolute;top:8px;right:8px;background:var(--green);color:#fff;border-radius:12px;padding:3px 8px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:4px;z-index:10;';
      badge.innerHTML = 'ğŸ”’ E2E Åifreli';
      document.getElementById('voice-view')?.style && document.getElementById('voice-view').appendChild(badge);
    }
  }

  return {
    initVoiceE2E,
    encryptMetadata,
    decryptMetadata,
    registerSocketEvents,
    isEnabled,
    clearSession,
    renderVoiceE2EBadge,
  };
})();

// Sprint 33: BridgeRegistry kayıtları
BridgeRegistry.register('BridgeVoiceE2E', _BridgeVoiceE2E as unknown as (...a: unknown[]) => unknown);
// data-bridge-action: delegated event dispatch via BridgeRegistry (see index.html dispatcher)
(window as Window & { BridgeE2E: typeof _BridgeE2E }).BridgeE2E = _BridgeE2E;

// ── yardımcı fonksiyonlar (e2e.js scope'undan erişim için) ──
function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer)));
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

