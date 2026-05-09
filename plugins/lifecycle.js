// plugins/lifecycle.js
// Plugin load / unload lifecycle management

'use strict';

const _loaded = new Map(); // id -> { meta, teardown }

/**
 * Load a single plugin
 */
async function load({ base, meta, main, app, db, io, registry, logger }) {
  if (_loaded.has(meta.id)) {
    logger.warn?.(`[Lifecycle] ${meta.id} already loaded, skipping`);
    return;
  }

  const hooks = registry.register(meta.id, meta);

  // Plugin context — what we expose to plugin code
  const ctx = {
    meta,
    hooks,
    db,
    io,
    app,
    logger: {
      log:   (...a) => logger.info?.(`[Plugin:${meta.id}]`, ...a),
      warn:  (...a) => logger.warn?.(`[Plugin:${meta.id}]`, ...a),
      error: (...a) => logger.error?.(`[Plugin:${meta.id}]`, ...a),
    },
  };

  let teardown = null;
  try {
    // eslint-disable-next-line import/no-dynamic-require
    const pluginModule = require(main);
    const result = await pluginModule.setup(ctx);
    teardown = result?.teardown ?? null;
    _loaded.set(meta.id, { meta, teardown });
    logger.info?.(`[Lifecycle] Loaded: ${meta.id} v${meta.version}`);
  } catch (e) {
    registry.unregister(meta.id);
    logger.error?.(`[Lifecycle] Failed to load ${meta.id}: ${e.message}`);
  }
}

/**
 * Unload a plugin (calls teardown if provided)
 */
async function unload(id, registry) {
  const entry = _loaded.get(id);
  if (!entry) return;
  try {
    await entry.teardown?.();
  } catch (e) {
    console.error(`[Lifecycle] Teardown error for ${id}:`, e.message);
  }
  registry.unregister(id);
  _loaded.delete(id);
}

function loadedList() {
  return [..._loaded.values()].map(e => e.meta);
}

module.exports = { load, unload, loadedList };
