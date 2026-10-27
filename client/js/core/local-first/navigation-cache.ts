// P7 A4/A7 — encrypted snapshot of the last authorized server rail and channel
// lists, so an offline reload (offline-session.ts) can reach the cached
// history. Written only after an authorized server response; read only when
// the server is unreachable. A snapshot never authorizes anything: the next
// authorized list replaces it, and channel reconciliation runs only on server
// truth (ChannelListManager).

import { createBrowserLocalFirstStore, openExistingBrowserLocalFirstStore } from './indexeddb.ts';
import { isLocalAccountErased } from './erased-accounts.ts';

const NAMESPACE = 'navigation';
const SERVERS_RECORD = 'servers';
const MAX_ITEMS = 500;

export interface CachedChannelList {
  channels: unknown[];
  categories: unknown[];
}

function ok(userId: string): boolean {
  return typeof userId === 'string' && userId.trim().length > 0 && !isLocalAccountErased(userId);
}

function channelsRecord(serverId: string): string {
  return `channels:${serverId}`;
}

async function write(userId: string, recordId: string, value: unknown): Promise<void> {
  if (!ok(userId)) return;
  const { store, durable } = await createBrowserLocalFirstStore(userId);
  try {
    if (durable) await store.putJson(NAMESPACE, recordId, value);
  } finally {
    store.close();
  }
}

async function read<T>(userId: string, recordId: string): Promise<T | null> {
  if (!ok(userId)) return null;
  const store = await openExistingBrowserLocalFirstStore(userId);
  if (!store) return null;
  try {
    return await store.getJson<T>(NAMESPACE, recordId);
  } catch {
    return null; // corrupt or foreign: fail closed, show nothing
  } finally {
    store.close();
  }
}

export function saveCachedServerList(userId: string, servers: unknown[]): Promise<void> {
  return write(userId, SERVERS_RECORD, { servers: servers.slice(0, MAX_ITEMS) });
}

export async function readCachedServerList(userId: string): Promise<unknown[] | null> {
  const value = await read<{ servers?: unknown }>(userId, SERVERS_RECORD);
  return Array.isArray(value?.servers) ? value.servers : null;
}

export function saveCachedChannelList(userId: string, serverId: string, list: CachedChannelList): Promise<void> {
  if (!serverId) return Promise.resolve();
  return write(userId, channelsRecord(serverId), {
    channels: list.channels.slice(0, MAX_ITEMS), categories: list.categories.slice(0, MAX_ITEMS),
  });
}

export async function readCachedChannelList(userId: string, serverId: string): Promise<CachedChannelList | null> {
  if (!serverId) return null;
  const value = await read<Partial<CachedChannelList>>(userId, channelsRecord(serverId));
  if (!Array.isArray(value?.channels)) return null;
  return { channels: value.channels, categories: Array.isArray(value.categories) ? value.categories : [] };
}

/** A server the authorized rail no longer contains loses its cached channel list. */
export async function forgetCachedServer(userId: string, serverId: string): Promise<void> {
  if (!ok(userId) || !serverId) return;
  const store = await openExistingBrowserLocalFirstStore(userId);
  if (!store) return;
  try {
    await store.delete(NAMESPACE, channelsRecord(serverId));
  } finally {
    store.close();
  }
}
