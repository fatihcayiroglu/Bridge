// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BotApiPanel.svelte
//              client/js/core/bot-api-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bot-marketplace/bot-api.ts

import { getAPI, getCurrentServer } from '../globals.js';
import { apiFetch } from '../api-fetch.js';
import type { PluginEntry } from './types.js';

let _loadedPlugins: Record<string, PluginEntry> = {};

export function getLoadedPlugins(): Record<string, PluginEntry> {
  return _loadedPlugins;
}

export async function fetchLoadedPlugins(): Promise<void> {
  try {
    const res = await apiFetch(`${getAPI() ?? ''}/api/plugins`);
    if (!res.ok) return;
    const list = await res.json() as PluginEntry[];
    _loadedPlugins = {};
    for (const p of list) {
      if (p.id) _loadedPlugins[p.id] = p;
    }
  } catch { /* non-fatal */ }
}

export async function installBotOnServer(botId: string): Promise<void> {
  const server = getCurrentServer();
  if (!server) return;
  try {
    await apiFetch(`${getAPI() ?? ''}/api/servers/${server._id}/bots/${botId}/add`, { method: 'POST' });
  } catch { /* ignore */ }
}

export async function uninstallBotFromServer(botId: string): Promise<void> {
  const server = getCurrentServer();
  if (!server) return;
  try {
    await apiFetch(`${getAPI() ?? ''}/api/servers/${server._id}/bots/${botId}`, { method: 'DELETE' });
  } catch { /* ignore */ }
}
