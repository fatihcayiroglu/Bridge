// plugins/loader.js
// Entry point: plugin discovery + bootstrap
// Delegates to: registry.js (event bus), lifecycle.js (load/unload), allowlist.js (security)

'use strict';

const path      = require('path');
const fs        = require('fs');
const registry  = require('./registry');
const lifecycle = require('./lifecycle');
const allowlist = require('./allowlist');

const PLUGINS_DIR = path.join(__dirname);

/**
 * Discover all plugin directories (have plugin.json + index.js)
 */
function discoverPlugins() {
  const dirs = [];
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base    = path.join(PLUGINS_DIR, entry.name);
    const meta    = path.join(base, 'plugin.json');
    const main    = path.join(base, 'index.js');
    if (fs.existsSync(meta) && fs.existsSync(main)) {
      dirs.push({ base, meta, main });
    }
  }
  return dirs;
}

/**
 * Load all plugins into the registry
 * @param {import('express').Application} app
 * @param {object} db
 * @param {import('socket.io').Server} io
 */
async function loadPlugins(app, db, io) {
  const plugins = discoverPlugins();
  const logger  = require('../server/logger') || console;

  for (const { base, meta, main } of plugins) {
    let pluginMeta;
    try {
      pluginMeta = JSON.parse(fs.readFileSync(meta, 'utf8'));
    } catch (e) {
      logger.warn?.(`[Plugins] Skipping ${base}: invalid plugin.json — ${e.message}`);
      continue;
    }

    if (pluginMeta.disabled) {
      logger.info?.(`[Plugins] ${pluginMeta.id} disabled, skipping`);
      continue;
    }

    if (!allowlist.isAllowed(pluginMeta)) {
      logger.warn?.(`[Plugins] ${pluginMeta.id} blocked by allowlist`);
      continue;
    }

    await lifecycle.load({ base, meta: pluginMeta, main, app, db, io, registry, logger });
  }

  logger.info?.(`[Plugins] ${registry.count()} plugin(s) loaded`);
}

/**
 * Express route: GET /api/plugins — list loaded plugins
 */
function registerPluginListRoute(app) {
  app.get('/api/plugins', (req, res) => {
    res.json(registry.list());
  });
}

module.exports = { loadPlugins, registerPluginListRoute };
