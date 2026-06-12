// plugins/loader.ts
// Entry point: plugin discovery + bootstrap
// SPRINT65: lifecycle.js → lifecycle.ts geçişi tamamlandı — require() kaldırıldı

import path from 'path';
import fs   from 'fs';
import type { Application } from 'express';
import type { Server as IOServer } from 'socket.io';
import { register, unregister, emit, list, count } from './registry';
import { isAllowed } from './allowlist';
import { load as lifecycleLoad, unload as lifecycleUnload, loadedList } from './lifecycle';
import type { PluginMeta, PluginRegistry } from './lifecycle';

interface DiscoveredPlugin {
  base: string;
  meta: string;
  main: string;
}

const PLUGINS_DIR = path.join(__dirname);

const _registry: PluginRegistry = {
  register,
  unregister,
  emit,
  list: () => list().map((entry) => ({ ...entry } as PluginMeta)),
  count,
};

/** Discover all plugin directories (have plugin.json + index entry) */
function discoverPlugins(): DiscoveredPlugin[] {
  const dirs: DiscoveredPlugin[] = [];
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base     = path.join(PLUGINS_DIR, entry.name);
    const metaPath = path.join(base, 'plugin.json');
    if (!fs.existsSync(metaPath)) continue;

    // plugin.json'daki "main" alanını oku; yoksa index.ts → index.js fallback
    let rawMeta: Record<string, unknown>;
    try { rawMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>; }
    catch { continue; }

    const declared = typeof rawMeta['main'] === 'string'
      ? path.join(base, rawMeta['main'] as string)
      : null;
    const mainTs = path.join(base, 'index.ts');
    // mainJs kaldırıldı — canonical kaynak .ts (Sprint 117)
    // Canonical kaynak .ts — _legacy/ altındaki .js artık kaynak değil
    const main   = (declared && fs.existsSync(declared))
      ? declared
      : fs.existsSync(mainTs) ? mainTs : null;  // .js fallback kaldırıldı (Sprint 117)

    if (main && fs.existsSync(main)) {
      dirs.push({ base, meta: metaPath, main });
    }
  }
  return dirs;
}

interface LoadAllOpts {
  app:    Application;
  db:     unknown;
  io:     IOServer;
  logger: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
}

async function loadAll({ app, db, io, logger }: LoadAllOpts): Promise<void> {
  const plugins = discoverPlugins();
  logger.info?.(`[Loader] ${plugins.length} plugin keşfedildi`);

  for (const { base, meta: metaPath, main } of plugins) {
    let meta: PluginMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as PluginMeta;
    } catch (e) {
      logger.warn?.(`[Loader] plugin.json okunamadı: ${metaPath} — ${(e as Error).message}`);
      continue;
    }

    if (!isAllowed(meta, logger)) {
      logger.warn?.(`[Loader] Reddedildi: ${meta.id ?? metaPath}`);
      continue;
    }

    if (meta.disabled) {
      logger.info?.(`[Loader] Devre dışı: ${meta.id}`);
      continue;
    }

    await lifecycleLoad({ base, meta, main, app, db, io, registry: _registry, logger });
  }
}

async function unloadAll(): Promise<void> {
  for (const meta of loadedList()) {
    await lifecycleUnload(meta.id, _registry);
  }
}

export { loadAll, unloadAll, discoverPlugins, loadedList };
