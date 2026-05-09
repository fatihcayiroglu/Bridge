#!/usr/bin/env node
// scripts/generate-turn-config.js
// TURN sunucusu için .env konfigürasyonu oluşturur
// Kullanım: node scripts/generate-turn-config.js

'use strict';

const crypto = require('crypto');

console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Bridge — TURN Sunucu Kurulum Rehberi                ║
╚══════════════════════════════════════════════════════════════╝

NEDEN TURN GEREKLİ?
───────────────────
Şu an yalnızca STUN (Google) var. Kurumsal ağlar, simetrik NAT,
güvenlik duvarları arkasındaki kullanıcılarda WebRTC bağlantısı
kurulamaz. Bu kullanıcılar ses/video/ekran paylaşımı kullanamaz.

SEÇENEK 1 — Ücretsiz: Metered.ca (önerilen başlangıç)
──────────────────────────────────────────────────────
1. https://dashboard.metered.ca/signup adresine gidip ücretsiz hesap aç
2. Dashboard'dan TURN credentials al
3. .env dosyasına ekle:

TURN_URL=turn:eu.relay.metered.ca:80
TURN_USERNAME=<metered_username>
TURN_CREDENTIAL=<metered_password>
TURN_URL_TLS=turns:eu.relay.metered.ca:443

SEÇENEK 2 — Self-hosted: coturn (production için)
──────────────────────────────────────────────────
Ubuntu/Debian:
  sudo apt install coturn
  
/etc/turnserver.conf için minimal config:

  realm=bridge.seninadresi.com
  server-name=bridge.seninadresi.com
  listening-port=3478
  tls-listening-port=5349
  lt-cred-mech
  use-auth-secret
  static-auth-secret=${crypto.randomBytes(32).toString('hex')}
  total-quota=100
  bps-capacity=0
  stale-nonce=600
  cert=/etc/ssl/your-cert.pem
  pkey=/etc/ssl/your-key.pem
  no-loopback-peers
  no-multicast-peers
  cli-password=${crypto.randomBytes(16).toString('hex')}

  Servis başlatma:
  sudo systemctl enable coturn && sudo systemctl start coturn

  .env için:
  TURN_URL=turn:bridge.seninadresi.com:3478
  TURN_USERNAME=bridgeuser
  TURN_CREDENTIAL=<static-auth-secret>
  TURN_URL_TLS=turns:bridge.seninadresi.com:5349

SEÇENEK 3 — Ücretsiz deneme: Xirsys (aylık 500MB ücretsiz)
────────────────────────────────────────────────────────────
  https://xirsys.com → Dashboard → credentials al
  .env için:
  TURN_URL=turn:fr-turn1.xirsys.com:3478
  TURN_USERNAME=<xirsys_ident>
  TURN_CREDENTIAL=<xirsys_secret>

.ENV AYARLARI SONRASI
─────────────────────
Bridge otomatik olarak TURN'ü algılar ve webrtc.js'e ekler.
server/.env.example dosyası güncellenmiştir.

Kontrol için: curl -s https://api.ipify.org ve tarayıcı konsolunda
  rtc.peers değerini inceleyin — bağlantı tipi 'relay' olmalı.
`);

// .env.example'a TURN satırlarını ekle
const fs   = require('fs');
const path = require('path');
const envExamplePath = path.join(__dirname, '../server/.env.example');

if (fs.existsSync(envExamplePath)) {
  let env = fs.readFileSync(envExamplePath, 'utf-8');
  if (!env.includes('TURN_URL')) {
    env += `
# ── TURN Sunucusu (WebRTC NAT traversal — üretim için gerekli) ─────────────
# Kurumsal ağlarda ve NAT arkasında WebRTC çalışabilmesi için TURN şart.
# Ücretsiz başlangıç: https://dashboard.metered.ca
# Self-hosted:        coturn (bkz. scripts/generate-turn-config.js)
TURN_URL=
TURN_USERNAME=
TURN_CREDENTIAL=
TURN_URL_TLS=
# Trusted proxy sayısı (Nginx/Cloudflare arkasındaysanız 1 veya 2)
TRUSTED_PROXY_COUNT=1
`;
    fs.writeFileSync(envExamplePath, env);
    console.log('✅ .env.example güncellendi — TURN değişkenleri eklendi\n');
  }
}
