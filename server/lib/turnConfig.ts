// server/lib/turnConfig.ts
// TURN/STUN sunucu konfigürasyonu — istemciye gönderilecek ICE sunucu listesi.
//
// Sorun: Sadece Google STUN var. Kurumsal ağlar, simetrik NAT, güvenlik
// duvarları arkasındaki kullanıcılarda WebRTC bağlantısı kurulamıyor.
//
// Çözüm: TURN credential'larını ENV'den oku, time-limited HMAC token üret,
// istemciye güvenli şekilde ilet.
//
// Desteklenen sağlayıcılar:
//   - Self-hosted coturn (önerilen production)
//   - Metered.ca (ücretsiz başlangıç)
//   - Twilio Network Traversal (kurumsal)
//   - Fallback: sadece STUN


import crypto from 'crypto';
// coturn --use-auth-secret ile uyumlu.
// username = "<unix_timestamp>:<userId>", credential = HMAC-SHA1(secret, username)
// Token 24 saat geçerli — her join'de taze token gönderilir.

function generateTimeLimitedCredential(userId: string, secret: string): { username: string; credential: string; ttl: number } {
  const ttl      = 86400; // 24 saat
  const expiry   = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:${userId}`;
  const credential = crypto
    .createHmac('sha1', secret)
    .update(username)
    .digest('base64');
  return { username, credential, ttl };
}

/**
 * İstemciye gönderilecek ICE sunucu listesini oluşturur.
 * @param {string} userId  — Token kişiselleştirme için (coturn auth)
 * @returns {object[]}     — RTCConfiguration.iceServers formatı
 */
function getIceServers(userId: string = 'anonymous'): object[] {
  const servers = [];

  // ── 1. STUN (her zaman ekle) ───────────────────────────────────────────────
  const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);

  servers.push({ urls: stunUrls });

  // ── 2. Self-hosted coturn (TURN_SECRET ile HMAC auth) ────────────────────
  if (process.env.TURN_SECRET && process.env.TURN_HOST) {
    const { username, credential } = generateTimeLimitedCredential(userId, process.env.TURN_SECRET);
    const host = process.env.TURN_HOST;
    const port = process.env.TURN_PORT || '3478';
    const tlsPort = process.env.TURN_TLS_PORT || '5349';

    servers.push({
      urls: [
        `turn:${host}:${port}`,           // UDP
        `turn:${host}:${port}?transport=tcp`, // TCP (güvenlik duvarı bypass)
        `turns:${host}:${tlsPort}`,       // TLS (HTTPS 443 alternatifi)
      ],
      username,
      credential,
    });

    // 443 üzerinden TURN — kurumsal ağlar yalnızca 443'e izin verir
    if (process.env.TURN_TLS_443 === 'true') {
      servers.push({
        urls: [`turns:${host}:443?transport=tcp`],
        username,
        credential,
      });
    }
  }

  // ── 3. Metered.ca (statik credential — ücretsiz başlangıç) ───────────────
  else if (process.env.METERED_API_KEY && process.env.METERED_APP_NAME) {
    // Metered dynamic credentials API
    // Prod'da bu kısım async yapılabilir (/api/turn endpoint'i ile)
    if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      servers.push({
        urls: [
          process.env.TURN_URL,
          process.env.TURN_URL_TLS || process.env.TURN_URL.replace('turn:', 'turns:'),
        ].filter(Boolean),
        username:   process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
    }
  }

  // ── 4. Manuel statik TURN (TURN_URL + TURN_USERNAME + TURN_CREDENTIAL) ───
  else if (process.env.TURN_URL && process.env.TURN_USERNAME) {
    servers.push({
      urls: [
        process.env.TURN_URL,
        process.env.TURN_URL_TLS,
      ].filter(Boolean),
      username:   process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }

  return servers;
}

/**
 * ICE transport policy — TURN varsa 'all', yoksa 'all' yine de OK.
 * Debug/test için FORCE_RELAY=true ayarlanabilir (sadece TURN üzerinden).
 */
function getIceTransportPolicy() {
  return process.env.FORCE_RELAY === 'true' ? 'relay' : 'all';
}

/**
 * Durum raporu — /api/health veya admin panel için.
 */
function getTurnStatus() {
  const hasCoturn   = !!(process.env.TURN_SECRET && process.env.TURN_HOST);
  const hasMetered  = !!(process.env.METERED_API_KEY);
  const hasStatic   = !!(process.env.TURN_URL && process.env.TURN_USERNAME);

  return {
    stun: true,
    turn: hasCoturn || hasMetered || hasStatic,
    provider: hasCoturn ? 'coturn' : hasMetered ? 'metered' : hasStatic ? 'static' : 'none',
    warning: (!hasCoturn && !hasMetered && !hasStatic)
      ? 'TURN sunucu yapılandırılmamış — NAT arkasındaki kullanıcılar ses bağlantısı kuramayabilir.'
      : null,
  };
}

export { getIceServers, getIceTransportPolicy, getTurnStatus, generateTimeLimitedCredential };
