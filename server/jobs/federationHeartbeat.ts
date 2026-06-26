// server/jobs/federationHeartbeat.ts
// Kayıtlı federation peer'larını periyodik olarak pingler, lastSeen günceller
import logger from '../lib/logger';
import { fetchT } from '../lib/fetch';
import { buildFederationAuthHeaders } from '../lib/httpSignature';

// ── SECRET VALIDATION ────────────────────────────────────────────────────────
// auth.ts ile aynı disiplin: hardcoded fallback yok.
// FEDERATION_SECRET eksikse production başlamaz; dev'de uyarı basar.
function _getFederationSecret(): string {
  const secret = process.env.FEDERATION_SECRET;
  if (!secret) {
    const msg =
      '[Federation] FEDERATION_SECRET ortam değişkeni tanımlı değil.\n' +
      '             .env dosyasına ekle: FEDERATION_SECRET=<uzun-rastgele-string>\n' +
       
      '             Üretmek için: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"';
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ event: 'federation.secret.missing' }, msg);
      process.exit(1);
    }
    logger.warn({ event: 'federation.secret.missing' }, msg);
    // Dev-only deterministic fallback — production'da asla ulaşılmaz
    return 'bridge-federation-dev-only-NOT-FOR-PRODUCTION';
  }
  return secret;
}

interface FederationPeer {
  _id: string;
  url: string;
  verified: boolean;
  lastSeen?: number;
}

interface DbHandle {
  federation_peers: {
    find(query: object): Promise<FederationPeer[]>;
    update(query: object, update: object): Promise<void>;
  };
}

// Test enjeksiyonu için opsiyonel; production'da FederationRepository kullanılır.
let _db: DbHandle | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;

let _startupTimer: ReturnType<typeof setTimeout> | null = null;
const INTERVAL_MS = 5 * 60 * 1000; // 5 dakika
const TIMEOUT_MS  = 8000;

function _sign(body: object): Promise<Record<string, string>> {
  return buildFederationAuthHeaders(body);
}

export async function pingPeer(peer: FederationPeer): Promise<boolean> {
  const db = _db;
  const body = { url: process.env.INSTANCE_URL || 'http://localhost:3001' };
  const authHeaders = await _sign(body);

  try {
    const resp = await fetchT(`${peer.url.replace(/\/$/, '')}/api/federation/ping`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body:      JSON.stringify(body),
      timeoutMs: TIMEOUT_MS,
    });

    const online = resp.ok;
    if (db) {
      await db.federation_peers.update(
        { _id: peer._id },
        { $set: { lastSeen: Date.now(), verified: online } },
      );
    } else {
      // Production path — FederationRepository kullan
      const { Federation } = await import('../db/repositories');
      await Federation.updatePeer(peer._id, { $set: { lastSeen: Date.now(), verified: online } });
    }
    return online;
  } catch {
    try {
      if (db) {
        await db.federation_peers.update(
          { _id: peer._id },
          { $set: { verified: false } },
        );
      } else {
        const { Federation } = await import('../db/repositories');
        await Federation.updatePeer(peer._id, { $set: { verified: false } });
      }
    } catch { /* ignore secondary error */ }
    return false;
  }
}

async function runHeartbeat(): Promise<void> {
  try {
    let peers: FederationPeer[];
    if (_db) {
      // Test enjeksiyonu
      peers = await _db.federation_peers.find({}) || [];
    } else {
      // Production — FederationRepository üzerinden çalış
      const { Federation } = await import('../db/repositories');
      peers = (await Federation.findPeers() as FederationPeer[]) || [];
    }

    if (!peers.length) return;

    const results = await Promise.allSettled(peers.map(p => pingPeer(p)));
    const online  = results.filter(r => r.status === 'fulfilled' && r.value).length;
    logger.info({ online, total: peers.length }, '[Federation] Heartbeat completed.');
  } catch (e) {
    const err = e as Error;
    logger.warn({ err }, '[Federation] Heartbeat error.');
  }
}

export function startFederationHeartbeat(db?: DbHandle): void {
  if (_timer || _startupTimer) return; // zaten çalışıyor
  if (db) _db = db;  // test enjeksiyonu

  _startupTimer = setTimeout(() => {

    _startupTimer = null;
    void runHeartbeat();
    _timer = setInterval(() => void runHeartbeat(), INTERVAL_MS);
    _timer.unref?.();
  }, 30 * 1000);
  _startupTimer.unref?.();

  logger.info('[Federation] Heartbeat job başlatıldı (her 5 dakika).');
}

export function stopFederationHeartbeat(): void {
  if (_startupTimer) clearTimeout(_startupTimer);
  _startupTimer = null;
  if (_timer) { clearInterval(_timer); _timer = null; }
  _db = null; // reset for test isolation
}

