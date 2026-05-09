// @ts-nocheck
// server/jobs/federationHeartbeat.js
// Kayıtlı federation peer'larını periyodik olarak pingler, lastSeen günceller

'use strict';

const crypto = require('crypto');

let _db   = null;
let _timer = null;

const INTERVAL_MS = 5 * 60 * 1000; // 5 dakika
const TIMEOUT_MS  = 8000;

function _sign(body) {
  const ts      = String(Date.now());
  const payload = ts + JSON.stringify(body);
  const secret  = process.env.FEDERATION_SECRET || 'bridge-federation-default';
  const sig     = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { ts, sig };
}

async function pingPeer(peer) {
  const body = { url: process.env.INSTANCE_URL || 'http://localhost:3001' };
  const { ts, sig } = _sign(body);

  try {
    const resp = await fetch(`${peer.url.replace(/\/$/, '')}/api/federation/ping`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'User-Agent':    'Bridge/28',
        'x-bridge-sig':  sig,
        'x-bridge-ts':   ts,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const online = resp.ok;
    await _db.federation_peers.update(
      { _id: peer._id },
      { $set: { lastSeen: Date.now(), verified: online } }
    );
    return online;
  } catch {
    // Peer'a ulaşılamadı — lastSeen güncelleme, verified=false
    await _db.federation_peers.update(
      { _id: peer._id },
      { $set: { verified: false } }
    ).catch(() => {});
    return false;
  }
}

async function runHeartbeat() {
  if (!_db) return;
  try {
    const peers = await _db.federation_peers.find({}) || [];
    if (!peers.length) return;

    const results = await Promise.allSettled(peers.map(pingPeer));
    const online  = results.filter(r => r.status === 'fulfilled' && r.value).length;
    console.log(`[Federation] Heartbeat: ${online}/${peers.length} peer online`);
  } catch (e) {
    console.warn('[Federation] Heartbeat error:', e.message);
  }
}

function startFederationHeartbeat(db) {
  if (_timer) return; // zaten çalışıyor
  _db = db;

  // İlk çalıştırma 30 saniye sonra (sunucu boot sırasında yük olmasın)
  setTimeout(() => {
    runHeartbeat();
    _timer = setInterval(runHeartbeat, INTERVAL_MS);
  }, 30 * 1000);

  console.log('[Federation] Heartbeat job başlatıldı (her 5 dakika)');
}

function stopFederationHeartbeat() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startFederationHeartbeat, stopFederationHeartbeat, pingPeer };
export {};
