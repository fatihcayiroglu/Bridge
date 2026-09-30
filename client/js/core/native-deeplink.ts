// client/js/core/native-deeplink.ts
//
// P4 — DEEP LINKS AND NOTIFICATION TAPS IN THE NATIVE (CAPACITOR) APP
//
// MEASURED (Android 14 emulator, real APK): `am start -d bridge://channel/<id>` opened or focused
// the app and then did NOTHING — warm and cold. The Capacitor bridge dispatched `bridge:deeplink`
// and nothing listened; a notification tap dispatched `bridge:navigate`, whose only listener (in the
// mobile HTML template) called `selectServer`/`selectChannel` globals that do not exist.
//
// Every link is untrusted input (any app or web page can open `bridge://…`). This router only ever
// NAVIGATES, and every destination is resolved through the server's own permission-checked APIs:
//   · channel → found only through `/api/servers/:id/channels` of servers the user belongs to
//     (channels the user may not view are not listed), otherwise "not available";
//   · server  → only a server already in the user's list;
//   · invite  → the server validates the code (the same flow as desktop bridge:// invites);
//   · dm      → the DM panel's own open flow (POST /api/dm/:userId enforces privacy and blocks).
// Links that arrive before sign-in wait for it (bounded); a signed-out app never navigates.

import { BridgeRegistry } from './bridge-registry.ts';
import { apiFetch } from './api-fetch.ts';
import { readToken } from './auth-compat.ts';
import { routeDesktopDeepLink, type DeepLinkDeps, CHANNEL_LOOKUP_SERVER_LIMIT } from './desktop-deeplink.ts';
import { t } from './i18n/index.ts';
import { createLogger } from './logger.ts';

const log = createLogger('NativeDeepLink');

export type NativeDeepLink =
  | { kind: 'channel'; channelId: string; serverId?: string; messageId?: string }
  | { kind: 'server'; serverId: string }
  | { kind: 'invite'; code: string }
  | { kind: 'dm'; userId: string };

const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const INVITE = /^[a-zA-Z0-9_-]{1,32}$/;
/** A link that waits for sign-in is dropped after this long (a stale tap must not navigate later). */
export const PENDING_LINK_TTL_MS = 10 * 60_000;
/** How long a routed link waits for the app shell to register its navigation owners. */
export const SHELL_READY_WAIT_MS = 30_000;

const idOrNull = (value: unknown): string | null => (typeof value === 'string' && ID.test(value) ? value : null);

/** Accepts the bridge's payloads (`navigate:*`) and rejects everything else, including tokens. */
export function parseNativeDeepLink(payload: unknown): NativeDeepLink | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  switch (p.type) {
    case 'navigate:channel': {
      const channelId = idOrNull(p.channelId);
      if (!channelId) return null;
      const serverId = idOrNull(p.serverId) ?? undefined;
      const messageId = idOrNull(p.messageId) ?? undefined;
      return { kind: 'channel', channelId, ...(serverId ? { serverId } : {}), ...(messageId ? { messageId } : {}) };
    }
    case 'navigate:server': {
      const serverId = idOrNull(p.serverId);
      return serverId ? { kind: 'server', serverId } : null;
    }
    case 'navigate:invite':
      return typeof p.code === 'string' && INVITE.test(p.code) ? { kind: 'invite', code: p.code } : null;
    case 'navigate:dm': {
      const userId = idOrNull(p.userId);
      return userId ? { kind: 'dm', userId } : null;
    }
    default:
      return null;
  }
}

interface ServerLike { _id?: string }

export interface NativeDeepLinkDeps extends DeepLinkDeps {
  signedIn(): boolean;
  openDm(userId: string): Promise<boolean> | boolean;
}

async function waitFor(check: () => boolean, timeoutMs: number, pollMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

async function serverChannels(deps: DeepLinkDeps, serverId: string): Promise<Array<{ _id?: string }>> {
  const response = await deps.get(`/api/servers/${encodeURIComponent(serverId)}/channels`).catch(() => null);
  if (!response?.ok) return [];
  const list = await response.json().catch(() => []) as unknown;
  return Array.isArray(list) ? list as Array<{ _id?: string }> : [];
}

export async function routeNativeDeepLink(link: NativeDeepLink, deps: NativeDeepLinkDeps, timeoutMs = SHELL_READY_WAIT_MS): Promise<boolean> {
  if (!(await waitFor(() => deps.ready(), timeoutMs))) return false;
  if (deps.servers().length === 0) await deps.loadServers();
  const unavailable = () => { deps.toast(t('gdm_gone', 'Bu konuşma artık kullanılamıyor.'), 'warning'); return false; };

  switch (link.kind) {
    case 'invite':
      return routeDesktopDeepLink({ kind: 'invite', code: link.code }, deps, timeoutMs);
    case 'server':
      return routeDesktopDeepLink({ kind: 'server', id: link.serverId }, deps, timeoutMs);
    case 'dm':
      return Boolean(await deps.openDm(link.userId));
    case 'channel': {
      const servers = deps.servers().filter((s) => typeof s._id === 'string');
      // The hinted server (notification data) is checked first; the rest in list order, bounded.
      const ordered = link.serverId
        ? [...servers.filter((s) => s._id === link.serverId), ...servers.filter((s) => s._id !== link.serverId)]
        : servers;
      for (const server of ordered.slice(0, CHANNEL_LOOKUP_SERVER_LIMIT)) {
        const channels = await serverChannels(deps, server._id as string);
        if (channels.some((channel) => channel?._id === link.channelId)) {
          return Boolean(await deps.navigateToChannel(link.channelId, link.messageId, server));
        }
      }
      return unavailable();
    }
  }
}

const registryDeps: NativeDeepLinkDeps = {
  ready: () => BridgeRegistry.has('selectServer') && BridgeRegistry.has('navigateToChannel') && BridgeRegistry.has('getAvailableServers'),
  servers: () => BridgeRegistry.call<ServerLike[]>('getAvailableServers') ?? [],
  selectServer: (server) => { BridgeRegistry.call('selectServer', server); },
  loadServers: () => BridgeRegistry.call('loadServers'),
  navigateToChannel: (channelId, messageId, server) =>
    BridgeRegistry.call<Promise<boolean> | boolean>('navigateToChannel', channelId, messageId, server) ?? false,
  post: (url) => apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  get: (url) => apiFetch(url),
  toast: (message, level) => { BridgeRegistry.call('toast', message, level); },
  signedIn: () => Boolean(readToken()),
  openDm: async (userId) => {
    if (!(await waitFor(() => BridgeRegistry.has('openDm'), SHELL_READY_WAIT_MS))) return false;
    return Boolean(await BridgeRegistry.call<Promise<boolean> | boolean>('openDm', userId));
  },
};

type PendingQueue = unknown[];
type BridgeWindow = Window & { __bridgePendingDeepLinks?: PendingQueue };

let installed = false;
let waiting: Array<{ link: NativeDeepLink; at: number }> = [];
const listeners: Array<[EventTarget, string, EventListener]> = [];

function listen(target: EventTarget, type: string, handler: EventListener): void {
  target.addEventListener(type, handler);
  listeners.push([target, type, handler]);
}

function dispatch(link: NativeDeepLink, deps: NativeDeepLinkDeps): void {
  if (!deps.signedIn()) { waiting.push({ link, at: Date.now() }); return; }
  void routeNativeDeepLink(link, deps).catch((err) => log.warn('Deep link could not be routed', err));
}

/**
 * Subscribes once. The bridge also parks every link in `window.__bridgePendingDeepLinks`
 * so a link delivered before this module ran (cold start, notification tap) is not lost.
 */
export function initNativeDeepLinks(deps: NativeDeepLinkDeps = registryDeps): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const w = window as BridgeWindow;
  const drain = () => {
    const queue = w.__bridgePendingDeepLinks;
    if (!Array.isArray(queue)) return;
    for (const payload of queue.splice(0)) {
      const link = parseNativeDeepLink(payload);
      if (link) dispatch(link, deps);
      else log.warn('Ignored an unsupported deep link payload');
    }
  };
  listen(window, 'bridge:deeplink', drain);
  listen(document, 'bridge:auth-success', () => {
    const now = Date.now();
    const ready = waiting.filter((item) => now - item.at <= PENDING_LINK_TTL_MS);
    waiting = [];
    for (const item of ready) dispatch(item.link, deps);
  });
  // Signing out forgets links that were waiting for the previous person's session.
  listen(document, 'bridge:auth-logout', () => { waiting = []; });
  drain();
}

/** Test hook: removes this instance's listeners. */
export function _resetNativeDeepLinksForTest(): void {
  for (const [target, type, handler] of listeners.splice(0)) target.removeEventListener(type, handler);
  installed = false;
  waiting = [];
}
