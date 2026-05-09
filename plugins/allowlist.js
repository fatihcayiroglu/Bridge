// plugins/allowlist.js
// Security: validates plugin metadata before loading
// Prevents loading plugins with missing/invalid required fields
// or plugins from untrusted sources (future: signature check)

'use strict';

const REQUIRED_FIELDS = ['id', 'name', 'version'];
const ID_PATTERN      = /^[a-z0-9_-]{2,64}$/;

/**
 * Returns true if the plugin metadata passes security checks
 * @param {object} meta  — parsed plugin.json
 */
function isAllowed(meta) {
  // Required fields must be present
  for (const field of REQUIRED_FIELDS) {
    if (!meta[field]) {
      console.warn(`[Allowlist] Rejected: missing field "${field}"`, meta);
      return false;
    }
  }

  // Plugin ID must match safe pattern (no path traversal etc.)
  if (!ID_PATTERN.test(meta.id)) {
    console.warn(`[Allowlist] Rejected: unsafe plugin id "${meta.id}"`);
    return false;
  }

  // Version must be semver-like
  if (!/^\d+\.\d+\.\d+/.test(meta.version)) {
    console.warn(`[Allowlist] Rejected: invalid version "${meta.version}" for ${meta.id}`);
    return false;
  }

  return true;
}

module.exports = { isAllowed };
