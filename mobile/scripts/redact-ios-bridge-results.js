'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Capacitor 8.4.3 logs the first 256 characters of every native result before
// resolving it. That includes decrypted history/drafts/grants and HTTP bodies.
// Keep the registered plugin/method names; never log the result payload.
const RAW = 'CAPLog.print("⚡️  TO JS", resultJson.prefix(256))';
const SAFE = 'CAPLog.print("⚡️  TO JS [payload redacted]", result.pluginID, result.methodName)';
const REVIEWED_SOURCE_SHA256 = '3e7565c04eb282a1471f59b8df41046ce08229679a79c169f841ff869b84b767';

function redactIosBridgeResults(root) {
  const sdk = path.join(root, 'node_modules', '@capacitor', 'ios');
  if (fs.lstatSync(path.join(root, 'node_modules')).isSymbolicLink() || fs.lstatSync(sdk).isSymbolicLink()) {
    throw new Error('IOS_RESULT_LOG_SHARED_DEPENDENCY_ROOT');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8'));
  if (pkg.version !== '8.4.3') throw new Error('IOS_RESULT_LOG_SDK_REVIEW_REQUIRED');
  const file = path.join(sdk, 'Capacitor', 'Capacitor', 'CapacitorBridge.swift');
  const source = fs.readFileSync(file, 'utf8');
  // Review the complete pinned SDK file, accepting only our exact one-line
  // change on subsequent syncs. Unknown framework edits cannot pass silently.
  const originalShape = source.replace(SAFE, RAW);
  if (createHash('sha256').update(originalShape).digest('hex') !== REVIEWED_SOURCE_SHA256) {
    throw new Error('IOS_RESULT_LOG_SOURCE_REVIEW_REQUIRED');
  }
  const rawCount = source.split(RAW).length - 1;
  const safeCount = source.split(SAFE).length - 1;
  if (rawCount === 0 && safeCount === 1) return { changed: false };
  if (rawCount !== 1 || safeCount !== 0) throw new Error('IOS_RESULT_LOG_SOURCE_REVIEW_REQUIRED');
  // Atomic replacement also avoids changing other worktrees' hard-linked
  // dependency files. Never follow a shared node_modules symlink when applying
  // locally; tests use independent copies of the installed SDK source.
  const temporary = `${file}.bridge-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, source.replace(RAW, SAFE), { flag: 'wx', mode: fs.statSync(file).mode });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { changed: true };
}

module.exports = { redactIosBridgeResults, RAW, SAFE };
