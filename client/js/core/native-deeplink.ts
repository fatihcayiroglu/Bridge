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
//   · dm      → the DM panel's own open flow (POST /api/dm/:userId enforces privacy and blocks);
//   · gdm     → only a group in the user's own group list (the server lists memberships only).
// Links that arrive before sign-in wait for it (bounded); a signed-out app never navigates.

import { BridgeRegistry } from './bridge-registry.ts';
import { apiFetch } from './api-fetch.ts';
import { readToken } from './auth-compat.ts';
import { routeDesktopDeepLink, type DeepLinkDeps, CHANNEL_LOOKUP_SERVER_LIMIT } from './desktop-deeplink.ts';
import { t } from './i18n/index.ts';
import { createLogger } from './logger.ts';
import { navigationOwner } from './navigation-selection.ts';
import { isLocalOnlySession } from './session-authority.ts';
import { beginIntent, noteIntentStage } from './navigation-intent-diagnostics.ts';

const log = createLogger('NativeDeepLink');

export type NativeDeepLink =
  | { kind: 'channel'; channelId: string; serverId?: string; messageId?: string }
  | { kind: 'server'; serverId: string }
  | { kind: 'invite'; code: string }
  | { kind: 'dm'; userId: string }
  | { kind: 'gdm'; groupId: string };

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
    case 'navigate:gdm': {
      const groupId = idOrNull(p.groupId);
      return groupId ? { kind: 'gdm', groupId } : null;
    }
    default:
      return null;
  }
}

interface ServerLike { _id?: string }

export interface NativeDeepLinkDeps extends DeepLinkDeps {
  signedIn(): boolean;
  sessionOwner(): string | null;
  openDm(userId: string): Promise<boolean> | boolean;
  /** Opens a group DM only if it is in the user's own group list (membership is server-side). */
  openGroupDm(groupId: string): Promise<boolean> | boolean;
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

export async function routeNativeDeepLink(link: NativeDeepLink, deps: NativeDeepLinkDeps, timeoutMs = SHELL_READY_WAIT_MS,
  isCurrent: () => boolean = () => true): Promise<boolean> {
  const channelLink = link.kind === 'channel';
  if (!(await waitFor(() => !isCurrent() || deps.ready(), timeoutMs))) {
    if (channelLink) noteIntentStage('shell-not-ready');
    return false;
  }
  if (!isCurrent()) return false;
  // Cold start: the boot load may still be in flight. `loadServers()` resolves once the list
  // reflects the server (ServerSwitcher queues behind an in-flight load); bounded, never forever.
  if (deps.servers().length === 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.resolve(deps.loadServers()).catch(() => undefined),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }
  if (!isCurrent()) return false;
  const unavailable = () => { deps.toast(t('gdm_gone', 'Bu konuşma artık kullanılamıyor.'), 'warning'); return false; };

  switch (link.kind) {
    case 'invite':
      return routeDesktopDeepLink({ kind: 'invite', code: link.code }, deps, timeoutMs);
    case 'server':
      return routeDesktopDeepLink({ kind: 'server', id: link.serverId }, deps, timeoutMs);
    case 'dm':
      return Boolean(await deps.openDm(link.userId));
    case 'gdm':
      return (await deps.openGroupDm(link.groupId)) ? true : unavailable();
    case 'channel': {
      const servers = deps.servers().filter((s) => typeof s._id === 'string');
      // The hinted server (notification data) is checked first; the rest in list order, bounded.
      const ordered = link.serverId
        ? [...servers.filter((s) => s._id === link.serverId), ...servers.filter((s) => s._id !== link.serverId)]
        : servers;
      noteIntentStage('dispatched', servers.length);
      for (const server of ordered.slice(0, CHANNEL_LOOKUP_SERVER_LIMIT)) {
        const channels = await serverChannels(deps, server._id as string);
        // apiFetch deliberately cancels old authentication contexts. A canceled
        // lookup is not evidence that the destination is unavailable, and must
        // never navigate or change the next session's UI.
        if (!isCurrent()) return false;
        if (channels.some((channel) => channel?._id === link.channelId)) {
          noteIntentStage('lookup-found');
          const navigated = Boolean(await deps.navigateToChannel(link.channelId, link.messageId, server));
          if (!isCurrent()) return false;
          noteIntentStage(navigated ? 'navigated' : 'not-navigated');
          return navigated;
        }
      }
      noteIntentStage('lookup-missing');
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
  // A cold app already has a stored JWT while /api/me is still restoring.
  // Starting a lookup then loses the intent when startApp invalidates that
  // pre-restoration HTTP context. Wait in the existing bounded sign-in queue.
  signedIn: () => !isLocalOnlySession() && Boolean(readToken()) && navigationOwner(BridgeRegistry.call('getMe')) !== null,
  sessionOwner: () => navigationOwner(BridgeRegistry.call('getMe')),
  openDm: async (userId) => {
    if (!(await waitFor(() => BridgeRegistry.has('openDm'), SHELL_READY_WAIT_MS))) return false;
    return Boolean(await BridgeRegistry.call<Promise<boolean> | boolean>('openDm', userId));
  },
  openGroupDm: async (groupId) => {
    const ready = () => BridgeRegistry.has('groupDmPanel:openGroupDm') && BridgeRegistry.has('groupDmPanel:getGroups');
    if (!(await waitFor(ready, SHELL_READY_WAIT_MS))) return false;
    await BridgeRegistry.call('groupDmPanel:loadList');
    const groups = BridgeRegistry.call<Array<{ _id?: string }>>('groupDmPanel:getGroups') ?? [];
    const group = groups.find((g) => g?._id === groupId);
    if (!group) return false;
    return Boolean(await BridgeRegistry.call<Promise<boolean> | boolean>('groupDmPanel:openGroupDm', group));
  },
};

type PendingQueue = unknown[];
type BridgeWindow = Window & { __bridgePendingDeepLinks?: PendingQueue };

let installed = false;
interface PendingLink { link: NativeDeepLink; at: number; owner: string | null }
let waiting: PendingLink[] = [];
const active = new Set<{ item: PendingLink }>();
let authEpoch = 0;
let transitioning = false;
const listeners: Array<[EventTarget, string, EventListener]> = [];

function listen(target: EventTarget, type: string, handler: EventListener): void {
  target.addEventListener(type, handler);
  listeners.push([target, type, handler]);
}

function dispatch(item: PendingLink, deps: NativeDeepLinkDeps): void {
  const { link } = item;
  const owner = deps.sessionOwner();
  if (Date.now() - item.at > PENDING_LINK_TTL_MS || (item.owner !== null && item.owner !== owner)) return;
  if (transitioning || !deps.signedIn()) {
    if (link.kind === 'channel') noteIntentStage('queued-for-sign-in');
    waiting.push(item);
    return;
  }
  item.owner = owner;
  const epoch = authEpoch;
  const attempt = { item };
  active.add(attempt);
  const isCurrent = () => installed && epoch === authEpoch && !transitioning && deps.signedIn()
    && deps.sessionOwner() === owner && Date.now() - item.at <= PENDING_LINK_TTL_MS;
  void routeNativeDeepLink(link, deps, SHELL_READY_WAIT_MS, isCurrent).catch((err) => {
    if (!isCurrent()) return;
    if (link.kind === 'channel') noteIntentStage('route-error');
    log.warn('Deep link could not be routed', err);
  }).finally(() => { active.delete(attempt); });
}

function invalidateRoutes(): void {
  authEpoch++;
  // Only read-only channel navigation is replayable. Never replay invite/DM
  // mutations whose server-side outcome may already have committed.
  for (const { item } of active) if (item.link.kind === 'channel') waiting.push(item);
  active.clear();
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
      if (link?.kind === 'channel') beginIntent();
      if (link) dispatch({ link, at: Date.now(), owner: deps.sessionOwner() }, deps);
      else log.warn('Ignored an unsupported deep link payload');
    }
  };
  listen(window, 'bridge:deeplink', drain);
  listen(document, 'bridge:auth-transition', () => {
    transitioning = true;
    invalidateRoutes();
  });
  listen(document, 'bridge:auth-success', () => {
    // The HTTP fence also changes on auth-success, including a repeated event
    // without a preceding transition. Reconcile through fresh authorized GETs.
    invalidateRoutes();
    transitioning = false;
    const ready = waiting;
    waiting = [];
    for (const item of ready) dispatch(item, deps);
  });
  // Signing out forgets links that were waiting for the previous person's session.
  listen(document, 'bridge:auth-logout', () => {
    authEpoch++;
    active.clear();
    waiting = [];
    transitioning = false;
  });
  drain();
}

/** Test hook: removes this instance's listeners. */
export function _resetNativeDeepLinksForTest(): void {
  for (const [target, type, handler] of listeners.splice(0)) target.removeEventListener(type, handler);
  installed = false;
  authEpoch++;
  transitioning = false;
  active.clear();
  waiting = [];
}
