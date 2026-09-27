// server/jobs/federationHeartbeat.ts
// Kayıtlı federation peer'larını periyodik olarak pingler, lastSeen günceller
import logger from '../lib/logger';
import { fetchT } from '../lib/fetch';
import { buildFederationAuthHeaders } from '../lib/httpSignature';
import { envSafeInt } from '../lib/envNumbers';
import { cache } from '../lib/redisAdapter';

export interface FederationPeer {
  _id: string;
  url: string;
  verified: boolean;
  lastSeen?: number;
}

export interface DbHandle {
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
const HEARTBEAT_CONCURRENCY = envSafeInt('FEDERATION_HEARTBEAT_CONCURRENCY', 20, { min: 1, max: 100 });
const HEARTBEAT_CLAIM_TTL_S = Math.ceil(INTERVAL_MS / 1000);

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
    } catch (persistErr) {
      logger.error(
        { err: persistErr, peerId: peer._id, event: 'federation.heartbeat.persist_offline_failed' },
        '[Federation] Peer offline state could not be persisted.',
      );
    }
    return false;
  }
}

async function runHeartbeat(requireClusterClaim = false): Promise<void> {
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

    let online = 0;
    let rejected = 0;
    for (let i = 0; i < peers.length; i += HEARTBEAT_CONCURRENCY) {
      const batch = peers.slice(i, i + HEARTBEAT_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (p) => {
        if (requireClusterClaim) {
          try {
            const claimed = await cache.setIfAbsentAuthoritative(
              `jobs:federation-heartbeat:peer:${p._id}`,
              { claimedAt: Date.now() },
              HEARTBEAT_CLAIM_TTL_S,
            );
            if (!claimed) return null;
          } catch (err) {
            logger.warn(
              { err, peerId: p._id, event: 'federation.heartbeat.claim_failed' },
              '[Federation] Shared heartbeat coordination unavailable; peer tick skipped.',
            );
            return null;
          }
        }
        return pingPeer(p);
      }));
      // `results[j]` indeksli erisimdir; `noUncheckedIndexedAccess` altinda
      // `... | undefined` doner ve ayrimli birlik (discriminated union)
      // daraltmasi CALISMAZ — bu yuzden `.value` / `.reason` okunamiyordu.
      // `entries()` hem indeksi hem de KESIN tanimli ogeyi verir.
      for (const [j, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          if (result.value) online++;
          continue;
        }
        rejected++;
        logger.warn(
          { err: result.reason, peerId: batch[j]?._id, event: 'federation.heartbeat.peer_rejected' },
          '[Federation] Heartbeat peer task rejected.',
        );
      }
    }
    logger.info({ online, rejected, total: peers.length }, '[Federation] Heartbeat completed.');
  } catch (e) {
    const err = e as Error;
    logger.warn({ err }, '[Federation] Heartbeat error.');
  }
}

// Explicit test hook; production scheduling still owns invocation.
export const _runHeartbeatForTest = () => runHeartbeat(false);
export const _runClaimedHeartbeatForTest = () => runHeartbeat(true);

export function startFederationHeartbeat(db?: DbHandle): void {
  if (_timer || _startupTimer) return; // zaten çalışıyor
  if (db) _db = db;  // test enjeksiyonu

  _startupTimer = setTimeout(() => {

    _startupTimer = null;
    void runHeartbeat(true);
    _timer = setInterval(() => void runHeartbeat(true), INTERVAL_MS);
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

