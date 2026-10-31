/**
 * Strict, bounded validation for the server-owned 3D social-room wire format.
 *
 * The server is trusted to authorize membership, not trusted to return a
 * well-formed frame forever (rolling deployments / corrupted Redis are real).
 * Reject the ENTIRE frame on any malformed or duplicate peer.
 */
export interface Social3DPeer {
  readonly socketId: string;
  readonly userId: string;
  readonly x: number;
  readonly z: number;
}
export interface Social3DSnapshot {
  readonly serverId: string;
  readonly peers: readonly Social3DPeer[];
}
const MAX_PEERS = 16;
const MAX_X = 5.6;
const MAX_Z = 5.2;
const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/;
function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function readSocial3DSnapshot(value: unknown, expectedServerId: string): Social3DSnapshot | null {
  if (!VALID_ID.test(expectedServerId) || expectedServerId.length > 64 || !plainObject(value)) return null;
  if (value.serverId !== expectedServerId || !Array.isArray(value.peers) || value.peers.length > MAX_PEERS) return null;
  const seen = new Set<string>();
  const peers: Social3DPeer[] = [];
  for (const item of value.peers) {
    if (!plainObject(item) ||
        typeof item.socketId !== 'string' || !VALID_ID.test(item.socketId) ||
        typeof item.userId !== 'string' || !VALID_ID.test(item.userId) ||
        typeof item.x !== 'number' || !Number.isFinite(item.x) || Math.abs(item.x) > MAX_X ||
        typeof item.z !== 'number' || !Number.isFinite(item.z) || Math.abs(item.z) > MAX_Z ||
        seen.has(item.socketId)) return null;
    seen.add(item.socketId);
    peers.push({ socketId: item.socketId, userId: item.userId, x: item.x, z: item.z });
  }
  return { serverId: expectedServerId, peers };
}
