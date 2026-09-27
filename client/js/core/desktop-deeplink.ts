// client/js/core/desktop-deeplink.ts
//
// Receives bridge:// links from the desktop shell (electron/preload.ts
// `electronBridge.onDeepLink`) and routes them through the app's canonical
// navigation owners.
//
// Final21 Phase 12: the shell dispatched a `bridge:deeplink` window event, but
// NOTHING listened for it — opening bridge://invite/<code> launched or focused the
// app and then did nothing. The allow-list below mirrors electron/main.ts.

import { BridgeRegistry } from './bridge-registry.ts';
import { apiFetch } from './api-fetch.ts';
import { getAPI } from './globals.ts';
import { t } from './i18n/index.ts';

export type DesktopDeepLink =
  | { kind: 'invite'; code: string }
  | { kind: 'server'; id: string }
  | { kind: 'channel'; id: string };

interface ServerLike { _id?: string }

export interface DeepLinkDeps {
  ready(): boolean;
  servers(): ServerLike[];
  selectServer(server: ServerLike): void;
  loadServers(): Promise<unknown> | unknown;
  navigateToChannel(channelId: string, messageId?: string, server?: ServerLike): Promise<boolean> | boolean;
  post(url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  get(url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  toast(message: string, level: 'warning' | 'error'): void;
}

/** Channel lookups across servers are sequential; bound them so a stray link cannot fan out. */
export const CHANNEL_LOOKUP_SERVER_LIMIT = 25;
/** How long an early link waits for the app shell to register its navigation owners. */
export const READY_WAIT_MS = 30_000;

export function parseDesktopDeepLink(value: unknown): DesktopDeepLink | null {
  const url = typeof value === 'string' ? value : '';
  let match = /^bridge:\/\/invite\/([a-zA-Z0-9_-]{1,32})$/.exec(url);
  if (match) return { kind: 'invite', code: match[1] };
  match = /^bridge:\/\/servers\/([a-zA-Z0-9_-]{1,64})$/.exec(url);
  if (match) return { kind: 'server', id: match[1] };
  match = /^bridge:\/\/channels\/([a-zA-Z0-9_-]{1,64})$/.exec(url);
  if (match) return { kind: 'channel', id: match[1] };
  return null;
}

async function waitForReady(deps: DeepLinkDeps, timeoutMs: number, pollMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!deps.ready()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

export async function routeDesktopDeepLink(link: DesktopDeepLink, deps: DeepLinkDeps, timeoutMs = READY_WAIT_MS): Promise<boolean> {
  if (!(await waitForReady(deps, timeoutMs))) return false;
  const unavailable = () => { deps.toast(t('gdm_gone', 'Bu konuşma artık kullanılamıyor.'), 'warning'); return false; };

  if (link.kind === 'invite') {
    const response = await deps.post(`/api/servers/invites/${encodeURIComponent(link.code)}/use`).catch(() => null);
    if (!response?.ok) {
      deps.toast(t('esr_join_failed', 'Sunucuya katılınamadı. Davet kodunu kontrol edip tekrar dene.'), 'error');
      return false;
    }
    const joined = await response.json().catch(() => null) as ServerLike | null;
    await deps.loadServers();
    const server = deps.servers().find((s) => s._id === joined?._id) ?? joined;
    if (server?._id) deps.selectServer(server);
    return Boolean(server?._id);
  }

  if (link.kind === 'server') {
    const server = deps.servers().find((s) => s._id === link.id);
    if (!server) return unavailable();
    deps.selectServer(server);
    return true;
  }

  if (await deps.navigateToChannel(link.id)) return true;
  for (const server of deps.servers().slice(0, CHANNEL_LOOKUP_SERVER_LIMIT)) {
    if (!server._id) continue;
    const response = await deps.get(`/api/servers/${encodeURIComponent(server._id)}/channels`).catch(() => null);
    if (!response?.ok) continue;
    const channels = await response.json().catch(() => []) as Array<{ _id?: string }>;
    if (Array.isArray(channels) && channels.some((channel) => channel?._id === link.id)) {
      return Boolean(await deps.navigateToChannel(link.id, undefined, server));
    }
  }
  return unavailable();
}

const registryDeps: DeepLinkDeps = {
  ready: () => BridgeRegistry.has('selectServer') && BridgeRegistry.has('navigateToChannel') && BridgeRegistry.has('getAvailableServers'),
  servers: () => BridgeRegistry.call<ServerLike[]>('getAvailableServers') ?? [],
  selectServer: (server) => { BridgeRegistry.call('selectServer', server); },
  loadServers: () => BridgeRegistry.call('loadServers'),
  navigateToChannel: (channelId, messageId, server) =>
    BridgeRegistry.call<Promise<boolean> | boolean>('navigateToChannel', channelId, messageId, server) ?? false,
  post: (url) => apiFetch(`${getAPI()}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  get: (url) => apiFetch(`${getAPI()}${url}`),
  toast: (message, level) => { BridgeRegistry.call('toast', message, level); },
};

let installed = false;

interface DeepLinkBridge {
  onDeepLink?(cb: (url: string) => void): (() => void) | void;
}

/** Subscribes once; the preload replays links that arrived before the app booted. */
export function initDesktopDeepLinks(deps: DeepLinkDeps = registryDeps): void {
  const bridge = (window as Window & { electronBridge?: DeepLinkBridge }).electronBridge;
  if (installed || typeof bridge?.onDeepLink !== 'function') return;
  installed = true;
  bridge.onDeepLink((url) => {
    const link = parseDesktopDeepLink(url);
    if (link) void routeDesktopDeepLink(link, deps);
  });
}

/** Test hook. */
export function _resetDesktopDeepLinksForTest(): void {
  installed = false;
}
