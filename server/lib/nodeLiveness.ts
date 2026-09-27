// server/lib/nodeLiveness.ts
//
// A short Redis lease per Bridge process (`node:alive:<INSTANCE_ID>`), renewed
// every 10 s with a 30 s TTL. Other nodes use it to tell "state held by a LIVE
// peer" from "state held by a node that is gone" — measured in the multi-node
// harness (scripts/multinode, uploads): chunk sessions staged on a SIGKILLed
// node kept holding the user's upload-session quota for the full session TTL,
// and every later chunk was refused as "staged elsewhere" with no way forward.
//
// Only meaningful with a configured Redis; a single-node deployment reports
// every node (itself) alive.

import { cache } from './redisAdapter';
import logger from './logger';

export const NODE_ID = process.env.INSTANCE_ID || `node-${process.pid}`;
const LEASE_SECONDS = 30;
const HEARTBEAT_MS = 10_000;
const key = (id: string): string => `node:alive:${id}`;

let timer: ReturnType<typeof setInterval> | null = null;

async function beat(): Promise<void> {
  try {
    await cache.setAuthoritative(key(NODE_ID), Date.now(), LEASE_SECONDS);
  } catch (err) {
    logger.warn({ err, event: 'node_liveness.heartbeat_failed' }, 'Node liveness lease could not be renewed');
  }
}

export function startNodeLiveness(): void {
  if (!process.env.REDIS_URL || timer) return;
  void beat();
  timer = setInterval(() => { void beat(); }, HEARTBEAT_MS);
  timer.unref?.();
}

export function stopNodeLiveness(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** `true` while the node renews its lease. Throws when the authority is unreachable. */
export async function isNodeAlive(id: string): Promise<boolean> {
  if (!process.env.REDIS_URL || id === NODE_ID) return true;
  return (await cache.getAuthoritative(key(id))) !== null;
}
