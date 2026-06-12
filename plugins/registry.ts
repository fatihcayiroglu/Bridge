// plugins/registry.ts
// Central event bus + plugin registry
// DÜZELTME #15: .js → .ts geçişi tamamlandı.
//
// Sprint 79: Cross-plugin event izolasyonu
//   - hooks.emit('*') artık tüm worker'lara broadcast YAPMAZ.
//   - Bir plugin'in emit ettiği event yalnızca O plugin'in kendi
//     listener'larına (ve '*' listener'larına) iletilir, başka
//     plugin'lerin dinleyicilerine DEĞİL.
//   - Lifecycle.ts'teki hooks.on('*', forwardToWorker) çağrısı
//     zaten plugin-spesifik hook nesnesi üzerinden yapılıyor —
//     bu zaten izole. Ama registry.emit() global broadcast yapıyordu.
//     Artık emit() kaynaklı pluginId parametresi alıyor; wildcard
//     listener'lar yalnızca kendi pluginId'siyle eşleşirse çağrılır.
//   - Geriye dönük uyumluluk: dışarıdan (server kodu) çağrılan
//     emit(event, data) — pluginId olmadan — tüm listener'lara
//     ulaşır (global sistem olayları: 'message:new', 'user:join' vb.).

'use strict';

interface PluginMeta {
  id:      string;
  name:    string;
  version: string;
  author?: string;
  [key: string]: unknown;
}

interface PluginListener {
  pluginId: string;
  fn:       (...args: any[]) => unknown;
}

interface PluginHooks {
  on:         (event: string, fn: (...args: any[]) => unknown) => void;
  off:        (event: string, fn: (...args: any[]) => unknown) => void;
  emit:       (event: string, ...args: unknown[]) => Promise<void>;
  /**
   * emitToAll — opt-in cross-plugin broadcast.
   *
   * Normalde ctx.hooks.emit() yalnızca kaynakla eşleşen wildcard ('*')
   * listener'larını tetikler (izolasyon). Ancak bir plugin kasıtlı olarak
   * tüm plugin'lere ulaşmak istiyorsa bu metodu kullanır.
   *
   * Kullanım senaryoları:
   *   - Ortak event hub gibi davranan koordinatör plugin'ler
   *   - Plugin ekosistemi genelinde yayın gerektiren sistem benzeri olaylar
   *
   * UYARI: Bu metod izolasyon garantisini kırar. Yalnızca bilinçli
   * cross-plugin broadcast için kullanın.
   */
  emitToAll:  (event: string, ...args: unknown[]) => Promise<void>;
}

interface PluginEntry {
  meta:  PluginMeta;
  hooks: PluginHooks;
}

const _plugins   = new Map<string, PluginEntry>();      // id → { meta, hooks }
const _listeners = new Map<string, PluginListener[]>(); // event → listeners

async function callListener(listenerEvent: string, runtimeEvent: string, fn: (...args: any[]) => unknown, args: unknown[]): Promise<void> {
  if (listenerEvent === '*' && fn.length >= 2) {
    await fn(runtimeEvent, ...args);
    return;
  }
  await fn(...args);
}

/** Register a plugin — returns hook interface */
function register(id: string, meta: PluginMeta): PluginHooks {
  _plugins.set(id, { meta, hooks: _makeHooks(id) });
  return _plugins.get(id)!.hooks;
}

/** Create hook interface for a specific plugin.
 *
 *  emit() called from THIS plugin's hooks object will only dispatch
 *  to listeners registered by THIS same plugin (plus server-side
 *  global listeners that have no pluginId affiliation, i.e. registered
 *  via the top-level emit() below).
 *
 *  This prevents plugin-A from accidentally (or maliciously) triggering
 *  plugin-B's wildcard '*' listener when plugin-A does ctx.hooks.emit('myEvent').
 */
function _makeHooks(pluginId: string): PluginHooks {
  return {
    on(event: string, fn: (...args: any[]) => unknown): void {
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event)!.push({ pluginId, fn });
    },
    off(event: string, fn: (...args: any[]) => unknown): void {
      const list = _listeners.get(event);
      if (!list) return;
      const idx = list.findIndex((l) => l.fn === fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    // Sprint 79: plugin-scoped emit — only fires listeners owned by this plugin
    emit(event: string, ...args: unknown[]): Promise<void> {
      return _emitScoped(event, args, pluginId);
    },
    // Sprint 80: opt-in cross-plugin broadcast
    emitToAll(event: string, ...args: unknown[]): Promise<void> {
      return emit(event, ...args);
    },
  };
}

/**
 * Scoped emit: dispatches to listeners that belong to `sourcePluginId`.
 *
 * Wildcard ('*') listeners for OTHER plugins are NOT triggered.
 * Exact-event listeners for ALL plugins ARE triggered (those are
 * intentional cross-plugin subscriptions, e.g. plugin-B listens for
 * 'message:new' which plugin-A or the server emits).
 *
 * The isolation rule only applies to wildcards ('*') and to the plugin's
 * own custom events — not to well-known global events that multiple
 * plugins are expected to react to.
 */
async function _emitScoped(event: string, args: unknown[], sourcePluginId: string): Promise<void> {
  const exactListeners    = _listeners.get(event) ?? [];
  const wildcardListeners = (_listeners.get('*') ?? []).filter(
    // Only forward wildcard to the plugin that emitted — not to others
    (l) => l.pluginId === sourcePluginId,
  );

  const list: PluginListener[] = [...exactListeners, ...wildcardListeners];
  for (const { pluginId, fn } of list) {
    try {
      const listenerEvent = exactListeners.some(l => l.pluginId === pluginId && l.fn === fn) ? event : '*';
      await callListener(listenerEvent, event, fn, args);
    } catch (e) {
      process.stderr.write(`[Registry] Plugin ${pluginId} error on ${event}: ${(e as Error).message}\n`);
    }
  }
}

/**
 * Global emit (called by server infrastructure, not plugins).
 * Dispatches to ALL listeners for the event, including all plugins.
 * Used for system events: 'message:new', 'user:join', etc.
 */
async function emit(event: string, ...args: unknown[]): Promise<void> {
  const exactListeners    = _listeners.get(event) ?? [];
  const wildcardListeners = _listeners.get('*') ?? [];
  const list: PluginListener[] = [...exactListeners, ...wildcardListeners];
  for (const { pluginId, fn } of list) {
    try {
      const listenerEvent = exactListeners.some(l => l.pluginId === pluginId && l.fn === fn) ? event : '*';
      await callListener(listenerEvent, event, fn, args);
    } catch (e) {
      process.stderr.write(`[Registry] Plugin ${pluginId} error on ${event}: ${(e as Error).message}\n`);
    }
  }
}

/** Unregister all listeners for a plugin */
function unregister(id: string): void {
  _plugins.delete(id);
  for (const [event, list] of _listeners) {
    const filtered = list.filter((l) => l.pluginId !== id);
    if (filtered.length) _listeners.set(event, filtered);
    else _listeners.delete(event);
  }
}

interface PluginListEntry {
  id:      string;
  name:    string;
  version: string;
  author:  string | undefined;
}

function list(): PluginListEntry[] {
  return [..._plugins.values()].map((p) => ({
    id:      p.meta.id,
    name:    p.meta.name,
    version: p.meta.version,
    author:  p.meta.author,
  }));
}

function count(): number { return _plugins.size; }

// Exposed for testing: allows inspection of listener isolation
function _getListeners(): Map<string, PluginListener[]> {
  return _listeners;
}

export { register, unregister, emit, list, count, _getListeners };
