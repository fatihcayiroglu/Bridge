// Durable navigation preferences for WebView/Electron/browser reloads.
//
// Only server/channel IDs are retained. Each key is scoped to the authenticated
// user and cannot make a channel accessible: the caller MUST intersect a
// remembered ID with the current server's authorized API response.
//
// #490 (Android): two API 34 emulator runs showed a WebView localStorage value
// that had been written AND read back being rolled back after force-stop. A
// returned setItem() is not a disk commit. On Android the native
// BridgeNavigationStore plugin (SharedPreferences.commit() on a background
// thread) is the durable copy: every write is mirrored there in request order
// and is "acknowledged" only after the native commit returned. At boot the
// native copy is read once and repairs localStorage before any remembered ID
// is used. Browser and Electron keep the localStorage-only behaviour.
import { isLocalAccountErased } from './local-first/erased-accounts.ts';

const PREFIX = 'bridge:last-navigation:v1';
/** Bounded wait for the boot read; a hung plugin must not block navigation. */
const NATIVE_READ_TIMEOUT_MS = 3000;
const MAX_NATIVE_ENTRIES = 4096;

export function navigationOwner(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const u = user as { _id?: unknown; id?: unknown };
  const id = typeof u._id === 'string' ? u._id : u.id;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : null;
}

function key(kind: string, userId: string, serverId?: string): string {
  return `${PREFIX}:${kind}:${userId}${serverId ? `:${serverId}` : ''}`;
}

function usable(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

// Mirrors NavigationPreferenceStore.java: key segments (user and server IDs)
// have no ':' so a key parses to exactly one owner; values are printable ASCII.
const NATIVE_OWNER = /^[A-Za-z0-9._~@+=-]{1,128}$/;
const NATIVE_SEGMENT = /^[A-Za-z0-9._~@+=-]{1,256}$/;
const NATIVE_ID = /^[\x21-\x7E]{1,256}$/;

function nativeKeyOwner(k: string): string | null {
  const rest = k.startsWith(`${PREFIX}:server:`) ? k.slice(PREFIX.length + 8)
    : k.startsWith(`${PREFIX}:channel:`) ? k.slice(PREFIX.length + 9) : null;
  if (rest === null) return null;
  const sep = rest.indexOf(':');
  const isChannel = k.startsWith(`${PREFIX}:channel:`);
  const owner = isChannel ? (sep > 0 ? rest.slice(0, sep) : '') : rest;
  if (!NATIVE_OWNER.test(owner)) return null;
  if (isChannel && !NATIVE_SEGMENT.test(rest.slice(sep + 1))) return null;
  return owner;
}

// ── Native durable store (Android only) ──────────────────────────────────────
interface NativeNavigationStore {
  write(options: { key: string; value: string | null }): Promise<{ committed?: unknown }>;
  readAll(): Promise<{ entries?: unknown; processFirstRead?: unknown }>;
  forgetOwner(options: { owner: string }): Promise<{ committed?: unknown }>;
}

type CapacitorLike = {
  getPlatform?(): string;
  isPluginAvailable?(name: string): boolean;
  Plugins?: Record<string, unknown>;
};

function nativeStore(): NativeNavigationStore | null {
  try {
    const cap = (globalThis as { Capacitor?: CapacitorLike }).Capacitor;
    if (!cap || cap.getPlatform?.() !== 'android') return null;
    if (cap.isPluginAvailable && !cap.isPluginAvailable('BridgeNavigationStore')) return null;
    const plugin = cap.Plugins?.BridgeNavigationStore as Partial<NativeNavigationStore> | undefined;
    return plugin && typeof plugin.write === 'function' && typeof plugin.readAll === 'function'
      && typeof plugin.forgetOwner === 'function' ? plugin as NativeNavigationStore : null;
  } catch { return null; }
}

/** Per-key durability, exposed only as a coarse state (never the value). */
export type DurabilityState = 'acknowledged' | 'pending' | 'failed' | 'unavailable' | 'none';

type BootState = 'not-started' | 'reading' | 'hydrated' | 'failed' | 'timeout' | 'unavailable';

interface Diagnostics {
  native: 'unknown' | 'available' | 'unavailable';
  requested: number;
  acknowledged: number;
  failed: number;
  rejected: number;
  lastFailureCode: string | null;
  boot: { state: BootState; processFirstRead: boolean | null; entries: number; repaired: number; migrated: number };
  restoration: { channel: RestorationOutcome | null; server: RestorationOutcome | null };
}

export type RestorationOutcome = 'restored' | 'refused' | 'none';

let diagnostics: Diagnostics = freshDiagnostics();

function freshDiagnostics(): Diagnostics {
  return {
    native: 'unknown', requested: 0, acknowledged: 0, failed: 0, rejected: 0, lastFailureCode: null,
    boot: { state: 'not-started', processFirstRead: null, entries: 0, repaired: 0, migrated: 0 },
    restoration: { channel: null, server: null },
  };
}

type QueueItem =
  | { op: 'write'; key: string; value: string | null }
  | { op: 'forget'; owner: string; done: (ok: boolean) => void };

/** Latest desired value per key that has not been sent yet (coalesced). */
const queuedWrites = new Map<string, string | null>();
const queue: QueueItem[] = [];
/** The one native write currently awaiting its commit acknowledgment. */
let inflight: { key: string; value: string | null } | null = null;
/** Last value the native store acknowledged per key in this page. */
const acknowledged = new Map<string, string | null>();
const failedKeys = new Map<string, string | null>();
/** Keys written by this page: the boot read never overwrites them. */
const writtenThisPage = new Set<string>();
/**
 * Authoritative value per key for this page: this page's own selections and
 * the durable boot read. Wins over localStorage, which may hold a rolled-back
 * value, and keeps working when localStorage itself is unavailable.
 */
const memory = new Map<string, string>();
let draining = false;
let bootRead: Promise<void> | null = null;

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z_]{1,32}$/.test(code) ? code : 'unknown';
}

function enqueueNativeWrite(k: string, value: string | null, owner: string): void {
  const store = nativeStore();
  if (!store) { diagnostics.native = 'unavailable'; return; }
  diagnostics.native = 'available';
  // The key must parse back to its real owner: an owner containing ':' would
  // otherwise alias another account's key (and its erasure).
  if (!NATIVE_OWNER.test(owner) || nativeKeyOwner(k) !== owner || (value !== null && !NATIVE_ID.test(value))) {
    // Never sent to native; the selection stays WebView-only and is reported.
    diagnostics.rejected++;
    failedKeys.set(k, value);
    return;
  }
  diagnostics.requested++;
  failedKeys.delete(k);
  if (!queuedWrites.has(k)) queue.push({ op: 'write', key: k, value });
  queuedWrites.set(k, value);
  void drain(store);
}

async function drain(store: NativeNavigationStore): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // One native call at a time keeps request order independent of the
    // plugin dispatcher; coalescing sends only the newest value per key.
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (item.op === 'forget') {
        let ok = false;
        try { ok = (await store.forgetOwner({ owner: item.owner }))?.committed === true; } catch (error) {
          diagnostics.lastFailureCode = failureCode(error);
        }
        if (!ok) diagnostics.failed++;
        item.done(ok);
        continue;
      }
      const value = queuedWrites.get(item.key) ?? null;
      queuedWrites.delete(item.key);
      inflight = { key: item.key, value };
      try {
        const result = await store.write({ key: item.key, value });
        if (result?.committed !== true) throw Object.assign(new Error('not committed'), { code: 'unverified' });
        diagnostics.acknowledged++;
        // A newer value queued meanwhile stays pending until its own ack.
        acknowledged.set(item.key, value);
        if (failedKeys.get(item.key) === value) failedKeys.delete(item.key);
      } catch (error) {
        diagnostics.failed++;
        diagnostics.lastFailureCode = failureCode(error);
        acknowledged.delete(item.key);
        failedKeys.set(item.key, value);
      } finally {
        inflight = null;
      }
    }
  } finally {
    draining = false;
  }
}

function writeLocal(k: string, value: string, owner: string): void {
  try { localStorage.setItem(k, value); } catch { /* storage disabled */ }
  // Browser/Electron: localStorage only, exactly as before #490.
  if (!nativeStore()) { diagnostics.native = 'unavailable'; return; }
  writtenThisPage.add(k);
  memory.set(k, value);
  enqueueNativeWrite(k, value, owner);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

async function hydrateFromNative(store: NativeNavigationStore): Promise<void> {
  diagnostics.boot.state = 'reading';
  let result: Awaited<ReturnType<NativeNavigationStore['readAll']>> | 'timeout';
  try {
    result = await withTimeout(store.readAll(), NATIVE_READ_TIMEOUT_MS);
  } catch (error) {
    diagnostics.boot.state = 'failed';
    diagnostics.lastFailureCode = failureCode(error);
    return;
  }
  if (result === 'timeout') { diagnostics.boot.state = 'timeout'; return; }
  const entries = result?.entries;
  if (!entries || typeof entries !== 'object') { diagnostics.boot.state = 'failed'; return; }
  diagnostics.boot.processFirstRead = result.processFirstRead === true;
  const durable = new Map<string, string>();
  for (const [k, v] of Object.entries(entries as Record<string, unknown>).slice(0, MAX_NATIVE_ENTRIES)) {
    const owner = nativeKeyOwner(k);
    if (owner === null || typeof v !== 'string' || !NATIVE_ID.test(v) || isLocalAccountErased(owner)) continue;
    durable.set(k, v);
  }
  diagnostics.boot.entries = durable.size;
  for (const [k, v] of durable) {
    // A selection made while the read was in flight is newer; keep it.
    if (writtenThisPage.has(k)) continue;
    acknowledged.set(k, v);
    memory.set(k, v);
    try {
      if (localStorage.getItem(k) !== v) {
        diagnostics.boot.repaired++;
        localStorage.setItem(k, v);
      }
    } catch { /* storage disabled: memory still serves the durable value */ }
  }
  // Upgrade path: preferences saved before this store existed become durable.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`${PREFIX}:`) || durable.has(k) || writtenThisPage.has(k)) continue;
      const owner = nativeKeyOwner(k);
      const v = localStorage.getItem(k);
      if (owner === null || isLocalAccountErased(owner) || !usable(v)) continue;
      diagnostics.boot.migrated++;
      enqueueNativeWrite(k, v, owner);
    }
  } catch { /* storage disabled */ }
  diagnostics.boot.state = 'hydrated';
}

/**
 * Resolves once remembered navigation reflects the durable store. Browser and
 * Electron resolve immediately. Never rejects; a failed or slow native read
 * falls back to localStorage and is visible in the diagnostics.
 */
export function navigationPreferencesReady(): Promise<void> {
  if (bootRead) return bootRead;
  const store = nativeStore();
  if (!store) {
    diagnostics.native = 'unavailable';
    diagnostics.boot.state = 'unavailable';
    bootRead = Promise.resolve();
    return bootRead;
  }
  diagnostics.native = 'available';
  bootRead = hydrateFromNative(store).catch(() => { diagnostics.boot.state = 'failed'; });
  return bootRead;
}

function readLocal(k: string): string | null {
  const known = memory.get(k);
  if (known !== undefined) return known;
  try { return localStorage.getItem(k); } catch { return null; }
}

export function rememberServer(userId: string | null, serverId: string): void {
  if (!userId || !usable(serverId)) return;
  writeLocal(key('server', userId), serverId, userId);
}

export function lastServer(userId: string | null): string | null {
  if (!userId) return null;
  const id = readLocal(key('server', userId));
  return usable(id) ? id : null;
}

export function rememberTextChannel(userId: string | null, serverId: string, channelId: string): void {
  if (!userId || !usable(serverId) || !usable(channelId)) return;
  writeLocal(key('channel', userId, serverId), channelId, userId);
}

export function lastTextChannel(userId: string | null, serverId: string): string | null {
  if (!userId || !usable(serverId)) return null;
  const id = readLocal(key('channel', userId, serverId));
  return usable(id) ? id : null;
}

/** Authorized restoration outcome, recorded by the caller after intersecting with the fresh list. */
export function noteNavigationRestoration(kind: 'channel' | 'server', outcome: RestorationOutcome): void {
  diagnostics.restoration[kind] = outcome;
}

/**
 * Account erasure: removes every navigation preference of `userId` from this
 * device. Resolves true only when the native removal (if any) was committed.
 */
export function forgetNavigationOwner(userId: string): Promise<boolean> {
  const server = key('server', userId);
  const channelPrefix = `${PREFIX}:channel:${userId}:`;
  const owned = (k: string) => k === server || k.startsWith(channelPrefix);
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && owned(k)) localStorage.removeItem(k);
    }
  } catch { /* storage disabled */ }
  for (const map of [queuedWrites, acknowledged, failedKeys, memory]) {
    for (const k of [...map.keys()]) if (owned(k)) map.delete(k);
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (item?.op === 'write' && owned(item.key)) queue.splice(i, 1);
  }
  for (const k of [...writtenThisPage]) if (owned(k)) writtenThisPage.delete(k);
  const store = nativeStore();
  if (!store) return Promise.resolve(true);
  if (!NATIVE_OWNER.test(userId)) return Promise.resolve(true); // never stored natively
  return new Promise<boolean>(resolve => {
    queue.push({ op: 'forget', owner: userId, done: resolve });
    void drain(store);
  });
}

function durability(k: string, expected: string): DurabilityState {
  if (!nativeStore()) return 'unavailable';
  if (queuedWrites.get(k) === expected || (inflight?.key === k && inflight.value === expected)) return 'pending';
  if (failedKeys.get(k) === expected) return 'failed';
  // True for the durable copy right now, even if a newer value is queued.
  if (acknowledged.get(k) === expected) return 'acknowledged';
  return 'none';
}

/**
 * Privacy-bounded evidence (counters, states and booleans only). IDs passed
 * to inspect() are compared in place and never returned or logged.
 */
export function navigationDurabilityStatus(): Diagnostics {
  return JSON.parse(JSON.stringify(diagnostics)) as Diagnostics;
}

export function inspectChannelDurability(userId: string, serverId: string, channelId: string): DurabilityState {
  if (!usable(userId) || !usable(serverId) || !usable(channelId)) return 'none';
  return durability(key('channel', userId, serverId), channelId);
}

export function inspectServerDurability(userId: string, serverId: string): DurabilityState {
  if (!usable(userId) || !usable(serverId)) return 'none';
  return durability(key('server', userId), serverId);
}

if (typeof window !== 'undefined' && !Object.prototype.hasOwnProperty.call(window, '__bridgeNavigationDurabilityV1')) {
  Object.defineProperty(window, '__bridgeNavigationDurabilityV1', {
    value: Object.freeze({
      status: navigationDurabilityStatus,
      inspectChannel: inspectChannelDurability,
      inspectServer: inspectServerDurability,
    }),
    enumerable: false, configurable: false, writable: false,
  });
}

/** Test-only reset of module state; never used by production code. */
export function resetNavigationSelectionForTests(): void {
  queuedWrites.clear(); queue.length = 0; acknowledged.clear(); failedKeys.clear();
  writtenThisPage.clear(); memory.clear(); inflight = null;
  draining = false; bootRead = null; diagnostics = freshDiagnostics();
}
