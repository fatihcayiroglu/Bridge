// plugins/registry.js
// Central event bus + plugin registry
// Replaces inline event handling that was mixed into loader.js

'use strict';

const _plugins   = new Map();  // id -> { meta, hooks }
const _listeners = new Map();  // event -> [{ pluginId, fn }]

/**
 * Register a plugin
 */
function register(id, meta) {
  _plugins.set(id, { meta, hooks: _makeHooks(id) });
  return _plugins.get(id).hooks;
}

/**
 * Create hook interface for a plugin
 */
function _makeHooks(pluginId) {
  return {
    on(event, fn) {
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event).push({ pluginId, fn });
    },
    off(event, fn) {
      const list = _listeners.get(event);
      if (!list) return;
      const idx = list.findIndex(l => l.fn === fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    emit(event, data) {
      emit(event, data);
    },
  };
}

/**
 * Emit an event to all registered listeners
 */
async function emit(event, data) {
  const list = _listeners.get(event) || [];
  for (const { pluginId, fn } of list) {
    try {
      await fn(data);
    } catch (e) {
      console.error(`[Registry] Plugin ${pluginId} error on ${event}:`, e.message);
    }
  }
}

/** Unregister all listeners for a plugin */
function unregister(id) {
  _plugins.delete(id);
  for (const [event, list] of _listeners) {
    const filtered = list.filter(l => l.pluginId !== id);
    if (filtered.length) _listeners.set(event, filtered);
    else _listeners.delete(event);
  }
}

function list() {
  return [..._plugins.values()].map(p => ({
    id:      p.meta.id,
    name:    p.meta.name,
    version: p.meta.version,
    author:  p.meta.author,
  }));
}

function count() { return _plugins.size; }

module.exports = { register, unregister, emit, list, count };
