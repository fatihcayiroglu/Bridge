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
    .split(/[,\s]+/)
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
  // ONCELIK TUZAGI DUZELTILDI: bu dal eskiden yalnizca METERED_API_KEY +
  // METERED_APP_NAME ile SECILIYOR, ama iceride TURN_URL/USERNAME/CREDENTIAL
  // yoksa HICBIR SEY push etmiyordu. `else if` zinciri yuzunden 4. dal
  // (manuel statik TURN) da ATLANIYOR ve sonuc SIFIR TURN sunucusu oluyordu —
  // operator TURN yapilandirdigini sanarken.
  //
  // Kapiya gercek gereksinimler eklendi: metered yayin yapamiyorsa akis
  // dogal olarak statik dala DUSER. Daha once TURN ureten hicbir yapilandirma
  // bundan etkilenmez (ayni kosullar hala metered dalini secer).
  else if (
    process.env.METERED_API_KEY && process.env.METERED_APP_NAME &&
    process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL
  ) {
    // Metered dynamic credentials API
    // Prod'da bu kısım async yapılabilir (/api/turn endpoint'i ile)
    // (Kosul artik dal kapisinda da var; burada savunma amacli birakildi.)
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
  else if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: [
        process.env.TURN_URL,
        process.env.TURN_URL_TLS,
      ].filter(Boolean),
      username:   process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  return servers;
}

/**
 * ICE transport policy — TURN varsa 'all', yoksa 'all' yine de OK.
 * Ürün bayrağı FORCE_TURN=true; FORCE_RELAY eski teşhis/uyumluluk alias'ıdır.
 */
function getIceTransportPolicy() {
  // FORCE_TURN is the documented product flag. FORCE_RELAY is retained as a
  // backwards-compatible diagnostic alias so older self-hosted deployments do
  // not silently change behavior during upgrade.
  return process.env.FORCE_TURN === 'true' || process.env.FORCE_RELAY === 'true' ? 'relay' : 'all';
}

function hasTurnServer(servers: object[]): boolean {
  return servers.some(entry => {
    const raw = (entry as { urls?: string | string[] }).urls;
    const urls = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return urls.some(u => typeof u === 'string' && /^turns?:/i.test(u));
  });
}

/**
 * Canonical RTC ICE response used by P2P, GDM voice and SFU joins.
 * A relay-only flag without an actual TURN server must never black-hole all
 * media: fall back to `all` and expose an operator/user diagnostic warning.
 */
function getRtcIceConfig(userId: string = 'anonymous'): {
  iceServers: object[];
  iceTransportPolicy: 'all' | 'relay';
  warning?: string;
} {
  const iceServers = getIceServers(userId);
  const requested = getIceTransportPolicy() === 'relay';
  const hasTurn = hasTurnServer(iceServers);
  if (requested && !hasTurn) {
    return {
      iceServers,
      iceTransportPolicy: 'all',
      warning: 'FORCE_TURN/FORCE_RELAY etkin ancak kullanılabilir TURN sunucusu yok; relay-only modu devre dışı bırakıldı.',
    };
  }
  return { iceServers, iceTransportPolicy: requested ? 'relay' : 'all' };
}

/**
 * Durum raporu — /api/health veya admin panel için.
 */
function getTurnStatus() {
  // ══════════════════════════════════════════════════════════════════════════
  // DUZELTILEN GERCEK KUSUR — DURUM RAPORU YALAN SOYLUYORDU
  // ══════════════════════════════════════════════════════════════════════════
  // Eskiden:  const hasMetered = !!(process.env.METERED_API_KEY);
  // Ama `getIceServers` metered dali icin METERED_APP_NAME *ve*
  // TURN_URL/TURN_USERNAME/TURN_CREDENTIAL de istiyordu.
  //
  // Sonuc: yalnizca METERED_API_KEY ayarlanmis bir kurulumda
  //   getTurnStatus()  -> { turn: true,  provider: 'metered', warning: null }
  //   getIceServers()  -> SIFIR turn girdisi
  // Yani /api/health "TURN hazir" derken NAT arkasindaki kullanicilar hicbir
  // zaman baglanamiyordu ve uyari da BASTIRILIYORDU.
  //
  // DUZELTME: durum artik iddiadan degil, GERCEKTEN YAYILAN listeden turetilir.
  // Boylece raporun ciktiyla celismesi YAPISAL OLARAK imkansizdir.
  const servers = getIceServers('turn-status-probe');
  const hasTurn = hasTurnServer(servers);

  // Saglayici etiketi yalnizca GERCEKTEN turn yayildiginda anlamlidir.
  const isCoturn  = !!(process.env.TURN_SECRET && process.env.TURN_HOST);
  const isMetered = !!(process.env.METERED_API_KEY && process.env.METERED_APP_NAME);

  return {
    stun: true,
    turn: hasTurn,
    provider: !hasTurn ? 'none' : isCoturn ? 'coturn' : isMetered ? 'metered' : 'static',
    warning: !hasTurn
      ? 'TURN sunucu yapılandırılmamış — NAT arkasındaki kullanıcılar ses bağlantısı kuramayabilir.'
      : null,
  };
}

export { getIceServers, getIceTransportPolicy, getRtcIceConfig, getTurnStatus, generateTimeLimitedCredential };
