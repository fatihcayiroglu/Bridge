// server/lib/federationPeerAnnounce.ts
//
// P5 FED-03: tell every registered Bridge peer about a rotated instance key.
//
// `POST /api/federation/key-update` existed on the receiving side, but nothing
// ever called it: after an admin rotated the key, every peer kept the old one
// and refused this installation from then on. The announcement is signed with
// the PREVIOUS private key — the only key the peer can still verify — and
// carries the new public key; the receiver binds it to the registered peer.

import { fetchT } from './fetch';
import logger from './logger';
import { Federation } from '../db/repositories';
import { getInstanceUrl } from './federationKeys';
import { signPeerRequest } from './httpSignatureV3';

export interface KeyAnnouncementResult {
  peerId: string;
  url:    string;
  ok:     boolean;
  status?: number;
  error?:  string;
}

const KEY_UPDATE_PATH = '/api/federation/key-update';
const TIMEOUT_MS = 8000;

export async function announceKeyRotation(
  previousPrivateKeyPem: string,
  publicKey: { id?: string; owner?: string; publicKeyPem: string },
): Promise<KeyAnnouncementResult[]> {
  const peers = (await Federation.findPeers()) as Array<{ _id: string; url?: string }>;
  const body = JSON.stringify({ url: getInstanceUrl(), publicKey });

  const settled = await Promise.allSettled(peers.map(async (peer): Promise<KeyAnnouncementResult> => {
    const url = String(peer.url ?? '');
    if (!url) return { peerId: String(peer._id), url, ok: false, error: 'peer has no url' };
    const headers = await signPeerRequest({ method: 'POST', path: KEY_UPDATE_PATH, target: url }, body, previousPrivateKeyPem);
    const resp = await fetchT(`${url.replace(/\/$/, '')}${KEY_UPDATE_PATH}`, {
      method: 'POST', headers, body, timeoutMs: TIMEOUT_MS,
    });
    return { peerId: String(peer._id), url, ok: resp.ok, status: resp.status };
  }));

  const results = settled.map((r, i): KeyAnnouncementResult => (r.status === 'fulfilled'
    ? r.value
    : { peerId: String(peers[i]?._id), url: String(peers[i]?.url ?? ''), ok: false, error: (r.reason as Error)?.message ?? 'failed' }));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    // A peer that missed the announcement will refuse this installation until
    // its admin re-adds the peer — say so where an operator will look.
    logger.warn(
      { event: 'federation.key_rotation.announce_failed', failed: failed.map((f) => ({ url: f.url, status: f.status, error: f.error })) },
      '[Federation] Some peers did not accept the rotated key; they will refuse this instance until re-added.',
    );
  }
  return results;
}
