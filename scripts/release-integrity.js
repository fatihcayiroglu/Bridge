#!/usr/bin/env node
'use strict';

/**
 * Content-integrity helpers for Bridge release archives.
 *
 * The package script creates the manifest in a staged extraction, then verifies
 * a second, independent extraction.  Keeping this logic in Node makes the
 * verification identical on Linux, macOS, and Windows.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_NAME = 'RELEASE_MANIFEST.sha256';
const EXPECTED_STICKER_COUNT = 242;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Deliberately high-confidence formats only. Generic words such as `secret`
// occur throughout source code and documentation and create a dangerously
// noisy gate. Test fixtures may contain synthetic JWTs/private-key envelopes;
// those two formats are reported separately instead of being promoted to a
// deployable-secret finding.
const SECRET_PATTERNS = [
  { id: 'private-key', expression: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g, fixtureSafe: true },
  { id: 'jwt', expression: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, fixtureSafe: true },
  { id: 'aws-access-key-id', expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'github-token', expression: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{70,255})\b/g },
  { id: 'slack-token', expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: 'google-api-key', expression: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-live-secret', expression: /\bsk_live_[0-9A-Za-z]{16,}\b/g },
  { id: 'openai-api-key', expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'npm-auth-token', expression: /(?:^|\n)\s*(?:\/\/[^\r\n]*:)?_authToken\s*=\s*(?:npm_[A-Za-z0-9]{20,}|[A-Za-z0-9._-]{24,})/g },
];

function fail(message) {
  const error = new Error(message);
  error.code = 'RELEASE_INTEGRITY_ERROR';
  throw error;
}

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function assertSafeRelative(relativePath) {
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\r') || relativePath.includes('\n')) {
    fail(`Unsafe manifest path: ${JSON.stringify(relativePath)}`);
  }
  if (relativePath.includes('\\')) fail(`Manifest paths must use '/': ${relativePath}`);
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:/.test(normalized)) {
    fail(`Manifest path escapes the release root: ${relativePath}`);
  }
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkFiles(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const ignored = new Set((options.ignore || []).map((item) => normalizeRelative(item)));
  const files = [];
  const caseFolded = new Map();

  function visit(directory, prefix) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelative(prefix ? path.join(prefix, entry.name) : entry.name);
      if (ignored.has(relative)) continue;
      assertSafeRelative(relative);
      const folded = relative.toLocaleLowerCase('en-US');
      const collision = caseFolded.get(folded);
      if (collision && collision !== relative) {
        fail(`Case-colliding release paths: ${collision} and ${relative}`);
      }
      caseFolded.set(folded, relative);
      if (entry.isSymbolicLink()) fail(`Release contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push({ absolute, relative, size: fs.statSync(absolute).size });
      else fail(`Release contains an unsupported filesystem entry: ${relative}`);
    }
  }

  if (!fs.existsSync(absoluteRoot)) fail(`Release root is missing: ${absoluteRoot}`);
  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`Release root is not a real directory: ${absoluteRoot}`);
  }
  visit(absoluteRoot, '');
  return files;
}

function describeFiles(root, options = {}) {
  return walkFiles(root, options).map((file) => ({
    ...file,
    sha256: hashFile(file.absolute),
  }));
}

function manifestPathFor(root, suppliedPath) {
  return path.resolve(suppliedPath || path.join(root, MANIFEST_NAME));
}

function createManifest(root, suppliedPath) {
  const absoluteRoot = path.resolve(root);
  const manifestPath = manifestPathFor(absoluteRoot, suppliedPath);
  const relativeManifest = normalizeRelative(path.relative(absoluteRoot, manifestPath));
  assertSafeRelative(relativeManifest);

  const files = describeFiles(absoluteRoot, { ignore: [relativeManifest] });
  const body = files
    .map((file) => `${file.sha256}  ${file.size}  ${file.relative}`)
    .join('\n') + '\n';
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, body, { encoding: 'utf8', flag: 'wx' });
  fs.rmSync(manifestPath, { force: true });
  fs.renameSync(temporary, manifestPath);
  return {
    manifest: manifestPath,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

function parseManifest(manifestPath) {
  const rows = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const entries = new Map();
  for (const [index, row] of rows.entries()) {
    const match = /^([a-f0-9]{64})  ([0-9]+)  (.+)$/.exec(row);
    if (!match) fail(`Malformed manifest row ${index + 1}: ${row}`);
    const [, sha256, sizeText, relative] = match;
    assertSafeRelative(relative);
    if (entries.has(relative)) fail(`Duplicate manifest path: ${relative}`);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) fail(`Invalid manifest size for ${relative}: ${sizeText}`);
    entries.set(relative, { sha256, size });
  }
  return entries;
}

function verifyManifest(root, suppliedPath) {
  const absoluteRoot = path.resolve(root);
  const manifestPath = manifestPathFor(absoluteRoot, suppliedPath);
  const relativeManifest = normalizeRelative(path.relative(absoluteRoot, manifestPath));
  assertSafeRelative(relativeManifest);
  const expected = parseManifest(manifestPath);
  const actualFiles = describeFiles(absoluteRoot, { ignore: [relativeManifest] });
  const actual = new Map(actualFiles.map((file) => [file.relative, file]));

  const missing = [...expected.keys()].filter((relative) => !actual.has(relative));
  const extra = [...actual.keys()].filter((relative) => !expected.has(relative));
  if (missing.length || extra.length) {
    fail(`Manifest file set mismatch (missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'})`);
  }

  for (const [relative, wanted] of expected) {
    const found = actual.get(relative);
    if (found.size !== wanted.size) fail(`Size mismatch for ${relative}: ${found.size} != ${wanted.size}`);
    if (found.sha256 !== wanted.sha256) fail(`SHA-256 mismatch for ${relative}`);
  }

  return {
    manifest: manifestPath,
    files: actualFiles.length,
    bytes: actualFiles.reduce((sum, file) => sum + file.size, 0),
  };
}

function stickerSnapshot(root, expectedCount = EXPECTED_STICKER_COUNT) {
  const stickerRoot = path.join(path.resolve(root), 'server', 'uploads', 'stickers');
  if (!fs.existsSync(stickerRoot)) fail(`Sticker directory is missing: ${stickerRoot}`);
  const files = describeFiles(stickerRoot);
  const invalid = files.filter((file) => path.extname(file.relative).toLowerCase() !== '.png' || file.size <= 0);
  if (invalid.length) fail(`Sticker payload contains non-.png or empty files: ${invalid.map((file) => file.relative).join(',')}`);
  if (expectedCount != null && files.length !== expectedCount) {
    fail(`Sticker count mismatch: ${files.length} != ${expectedCount}`);
  }
  const caseFolded = new Set();
  for (const file of files) {
    const key = file.relative.toLocaleLowerCase('en-US');
    if (caseFolded.has(key)) fail(`Case-colliding sticker path: ${file.relative}`);
    caseFolded.add(key);
  }
  const pngSignatureFiles = files.filter((file) => {
    const handle = fs.openSync(file.absolute, 'r');
    try {
      const signature = Buffer.alloc(PNG_SIGNATURE.length);
      const bytesRead = fs.readSync(handle, signature, 0, signature.length, 0);
      return bytesRead === PNG_SIGNATURE.length && signature.equals(PNG_SIGNATURE);
    } finally {
      fs.closeSync(handle);
    }
  }).length;
  const canonical = files.map((file) => `${file.sha256}  ${file.size}  ${file.relative}`).join('\n') + '\n';
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
    pngSignatureFiles,
    invalidPngSignatureFiles: files.length - pngSignatureFiles,
    entries: files,
  };
}

function verifyStickerReference(root, referenceManifest, expectedCount = EXPECTED_STICKER_COUNT) {
  const prefix = 'server/uploads/stickers/';
  const expected = new Map();
  const rows = fs.readFileSync(path.resolve(referenceManifest), 'utf8').split(/\r?\n/);
  for (const [index, row] of rows.entries()) {
    if (!row || row.startsWith('#')) continue;
    const match = /^([a-fA-F0-9]{64})  (?:(\d+)  )?(.+)$/.exec(row);
    if (!match) continue; // The source manifest may document non-entry lines.
    const manifestPath = match[3].replace(/^\.\//, '').replace(/\\/g, '/');
    if (!manifestPath.startsWith(prefix)) continue;
    const relative = manifestPath.slice(prefix.length);
    assertSafeRelative(relative);
    if (expected.has(relative)) fail(`Duplicate sticker reference at row ${index + 1}: ${relative}`);
    expected.set(relative, {
      sha256: match[1].toLowerCase(),
      size: match[2] == null ? null : Number(match[2]),
    });
  }
  if (expected.size !== expectedCount) {
    fail(`Sticker reference count mismatch: ${expected.size} != ${expectedCount}`);
  }

  const snapshot = stickerSnapshot(root, expectedCount);
  const actual = new Map(snapshot.entries.map((entry) => [entry.relative, entry]));
  const missing = [...expected.keys()].filter((relative) => !actual.has(relative));
  const extra = [...actual.keys()].filter((relative) => !expected.has(relative));
  const mismatched = [];
  for (const [relative, wanted] of expected) {
    const found = actual.get(relative);
    if (found && (found.sha256 !== wanted.sha256 || (wanted.size != null && found.size !== wanted.size))) {
      mismatched.push(relative);
    }
  }
  if (missing.length || extra.length || mismatched.length) {
    fail(
      `Sticker reference mismatch (missing=${missing.length}; extra=${extra.length}; hash/size=${mismatched.length})`,
    );
  }
  return {
    files: snapshot.files,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    pngSignatureFiles: snapshot.pngSignatureFiles,
    invalidPngSignatureFiles: snapshot.invalidPngSignatureFiles,
    missing: 0,
    extra: 0,
    mismatched: 0,
  };
}

function compareStickers(sourceRoot, candidateRoot, expectedCount = EXPECTED_STICKER_COUNT) {
  const source = stickerSnapshot(sourceRoot, expectedCount);
  const candidate = stickerSnapshot(candidateRoot, expectedCount);
  if (source.sha256 !== candidate.sha256 || source.bytes !== candidate.bytes) {
    fail('Sticker payload differs between the source and fresh extraction');
  }
  return {
    files: source.files,
    bytes: source.bytes,
    sha256: source.sha256,
    pngSignatureFiles: source.pngSignatureFiles,
    invalidPngSignatureFiles: source.invalidPngSignatureFiles,
  };
}

function isTestFixturePath(relative) {
  return relative.startsWith('e2e/')
    || /(^|\/)(?:tests?|__tests__|fixtures?)(\/|$)/.test(relative)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative);
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

/**
 * Scan a prepared release tree for high-confidence, deployable credential
 * formats. Findings never include the credential value itself. Synthetic
 * JWT/private-key material under explicit test/fixture paths is counted but
 * allowed, so the gate distinguishes fixtures from production defaults.
 */
function scanReleaseSecrets(root) {
  const files = walkFiles(root);
  const findings = [];
  let scannedBytes = 0;
  let allowedFixtureMatches = 0;
  let allowedPlaceholderMatches = 0;

  for (const file of files) {
    if (/^e2e\/fixtures\/(?:.*state\.json|load-users\.json|tokens\.json)$/.test(file.relative)) {
      findings.push({ type: 'generated-e2e-credential-artifact', path: file.relative, line: 1 });
    }
    const content = fs.readFileSync(file.absolute);
    scannedBytes += content.length;
    // NUL is a reliable signal for the binary assets in this source package.
    // Secret formats above are textual; decoding arbitrary binary adds noise.
    if (content.includes(0)) continue;
    const text = content.toString('utf8');
    for (const pattern of SECRET_PATTERNS) {
      pattern.expression.lastIndex = 0;
      for (let match = pattern.expression.exec(text); match; match = pattern.expression.exec(text)) {
        if (pattern.fixtureSafe && isTestFixturePath(file.relative)) {
          allowedFixtureMatches += 1;
          continue;
        }
        // AWS publishes this exact value as its documentation-only example.
        if (match[0].includes('EXAMPLE')) {
          allowedPlaceholderMatches += 1;
          continue;
        }
        findings.push({
          type: pattern.id,
          path: file.relative,
          line: lineNumberAt(text, match.index),
        });
      }
    }
  }

  if (findings.length) {
    const summary = findings.slice(0, 20)
      .map((finding) => `${finding.type}:${finding.path}:${finding.line}`)
      .join(', ');
    fail(`High-confidence secret material found in release (${findings.length} finding(s)): ${summary}`);
  }
  return {
    files: files.length,
    bytes: scannedBytes,
    findings: 0,
    allowedFixtureMatches,
    allowedPlaceholderMatches,
  };
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function usage() {
  process.stderr.write([
    'Usage:',
    '  node scripts/release-integrity.js manifest <release-root> [manifest-path]',
    '  node scripts/release-integrity.js verify <release-root> [manifest-path]',
    '  node scripts/release-integrity.js stickers <release-root> [expected-count]',
    '  node scripts/release-integrity.js verify-sticker-reference <release-root> <source-manifest> [expected-count]',
    '  node scripts/release-integrity.js compare-stickers <source-root> <candidate-root> [expected-count]',
    '  node scripts/release-integrity.js scan-secrets <release-root>',
    '  node scripts/release-integrity.js hash <file>',
  ].join('\n') + '\n');
}

function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'manifest' && args[0]) return print(createManifest(args[0], args[1]));
  if (command === 'verify' && args[0]) return print(verifyManifest(args[0], args[1]));
  if (command === 'stickers' && args[0]) {
    const result = stickerSnapshot(args[0], args[1] == null ? EXPECTED_STICKER_COUNT : Number(args[1]));
    return print({
      files: result.files,
      bytes: result.bytes,
      sha256: result.sha256,
      pngSignatureFiles: result.pngSignatureFiles,
      invalidPngSignatureFiles: result.invalidPngSignatureFiles,
    });
  }
  if (command === 'verify-sticker-reference' && args[0] && args[1]) {
    const count = args[2] == null ? EXPECTED_STICKER_COUNT : Number(args[2]);
    return print(verifyStickerReference(args[0], args[1], count));
  }
  if (command === 'compare-stickers' && args[0] && args[1]) {
    const count = args[2] == null ? EXPECTED_STICKER_COUNT : Number(args[2]);
    return print(compareStickers(args[0], args[1], count));
  }
  if (command === 'scan-secrets' && args[0]) return print(scanReleaseSecrets(args[0]));
  if (command === 'hash' && args[0]) {
    const absolute = path.resolve(args[0]);
    return print({ file: absolute, bytes: fs.statSync(absolute).size, sha256: hashFile(absolute) });
  }
  usage();
  process.exitCode = 2;
}

module.exports = {
  MANIFEST_NAME,
  EXPECTED_STICKER_COUNT,
  compareStickers,
  createManifest,
  hashFile,
  parseManifest,
  scanReleaseSecrets,
  stickerSnapshot,
  verifyManifest,
  verifyStickerReference,
  walkFiles,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Release integrity check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
