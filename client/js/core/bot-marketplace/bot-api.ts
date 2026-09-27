import { apiFetch } from '../api-fetch.ts';
import { getAPI } from '../globals.ts';
import type { BotEntry } from './types.js';

const loaded: BotEntry[] = [];

function normalizePlugin(raw: unknown): BotEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : '';
  const name = typeof row.name === 'string' ? row.name : '';
  if (!id && !name) return null;
  return {
    id: id || name,
    name: name || id,
    description: typeof row.description === 'string' ? row.description : '',
    category: 'plugin', tags: [], rating: 0,
    author: typeof row.author === 'string' ? row.author : '',
    avatar: '🔌',
  };
}

export async function fetchLoadedPlugins(): Promise<BotEntry[]> {
  const response = await apiFetch(`${getAPI()}/api/plugins`);
  if (!response.ok) throw new Error(`Plugin list HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  const next = Array.isArray(payload) ? payload.map(normalizePlugin).filter((p): p is BotEntry => p !== null) : [];
  loaded.splice(0, loaded.length, ...next);
  return loaded;
}
export function getLoadedPlugins(): BotEntry[] { return loaded; }

export interface BotInstallState {
  installed: Set<string>;
  /** Scopes each installed listing currently holds in this server. */
  grants: Map<string, string[]>;
}

export async function fetchInstallState(serverId: string): Promise<BotInstallState> {
  const response = await apiFetch(`${getAPI()}/api/bots/marketplace/installed?serverId=${encodeURIComponent(serverId)}`);
  if (!response.ok) throw response;
  const payload = await response.json() as { installed?: unknown; grants?: unknown };
  const ids = Array.isArray(payload.installed) ? payload.installed.filter((id): id is string => typeof id === 'string') : [];
  const grants = new Map<string, string[]>();
  if (payload.grants && typeof payload.grants === 'object' && !Array.isArray(payload.grants)) {
    for (const [id, scopes] of Object.entries(payload.grants as Record<string, unknown>)) {
      if (Array.isArray(scopes)) grants.set(id, scopes.filter((scope): scope is string => typeof scope === 'string'));
    }
  }
  return { installed: new Set(ids), grants };
}

/** The listing asks for something other than what was shown; the admin must review it again. */
export class BotConsentOutdatedError extends Error {
  constructor() {
    super('consent_required');
    this.name = 'BotConsentOutdatedError';
  }
}

export async function installBotOnServer(botId: string, serverId: string, acceptedPermissions: readonly string[]): Promise<void> {
  const response = await apiFetch(`${getAPI()}/api/bots/marketplace/${encodeURIComponent(botId)}/install`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverId, acceptedPermissions }),
  });
  if (response.ok) return;
  if (response.status === 400) {
    const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
    if (body?.error === 'consent_required') throw new BotConsentOutdatedError();
  }
  throw response;
}
export async function uninstallBotFromServer(botId: string, serverId: string): Promise<void> {
  const response = await apiFetch(`${getAPI()}/api/bots/marketplace/${encodeURIComponent(botId)}/install/${encodeURIComponent(serverId)}`, { method: 'DELETE' });
  if (!response.ok) throw response;
}
