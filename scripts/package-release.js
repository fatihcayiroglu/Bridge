#!/usr/bin/env node
'use strict';

/**
 * Cross-platform Bridge release packager.
 *
 * It copies a policy-filtered source snapshot into a disposable staging tree,
 * writes a content manifest, creates a ZIP, extracts that ZIP into a second
 * disposable tree, and verifies both the exact manifest and sticker payload
 * before replacing the requested output file.
 */

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeDeterministicZip } = require('./deterministic-zip');
const {
  MANIFEST_NAME,
  compareStickers,
  createManifest,
  hashFile,
  scanReleaseSecrets,
  verifyManifest,
  verifyStickerReference,
  walkFiles,
} = require('./release-integrity');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const SOURCE_NAME = path.basename(SOURCE_ROOT);
const PACKAGE = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8'));
const SAFE_ENV_EXAMPLES = new Set(['.env.example', '.env.docker', '.env.test.example']);
const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.minio.sys',
  '.nyc_output',
  '.quality-logs',
  '.turbo',
  '.vite',
  '__macosx',
  '_archived_legacy',
  '_legacy',
  'tests-legacy',
  'workflows.disabled',
  'build',
  'coverage',
  'dist',
  'logs',
  'node_modules',
  'playwright-report',
  'pgdata',
  'postgres-data',
  'redis-data',
  'minio-data',
  'test-results',
  'temp',
  'tmp',
]);
const EXCLUDED_RELATIVE_PATHS = new Set([
  // `mobile/www` is the GENERATED Capacitor web root. `mobile/scripts/setup.js`
  // recreates it from `client/` on every build and, when `BRIDGE_API_URL` is
  // set, REWRITES the copied JavaScript to bake that host in. Packaging it
  // would therefore ship a stale duplicate of the client — potentially with a
  // private API hostname embedded. It is git-ignored, so it never reaches the
  // repository; it must not reach a release archive either.
  'mobile/www',
  // The other GENERATED native trees (Final21 Faz 19, measured with this file's own
  // `isExcluded` walk): `electron/release` is electron-builder's `directories.output`
  // (unsigned `Bridge.exe`, `win-unpacked/`, the installer — 78 files / ~490 MB after one
  // desktop build); `android/` and `ios/` are the Capacitor platform projects that
  // `npm run mobile:init` creates at the repository root (176 files, including a copy of the
  // web root with `js/bridge-config.js`, i.e. the builder's API host — the `mobile/www`
  // hazard above). The curated native sources live in `mobile/android` and `mobile/ios`.
  'electron/release',
  'android',
  'ios',
  'client/.storybook',
  'ui',
  'client/stories',
  'client/tsconfig.strict-gate.json',
  'client/tests/package.json',
  'client/tests/babel.config.js',
  'client/tests/helpers/setup.ts',
  'client/tests/helpers/canvas-mock.ts',
  'client/vitest.config.ts',
  'server/package.json.presfu',
  'fix-all-imports.sh',
  'fix-imports.sh',
  'fix-registry-calls.sh',
]);

const REQUIRED_RELEASE_FILES = [
  'package.json',
  'package-lock.json',
  'server/package.json',
  'server/package-lock.json',
  'server/index.ts',
  'server/runtime.ts',
  'server/COVERAGE_DEBT.json',
  'server/TYPE_DEBT.json',
  'server/scripts/check-typescript-debt.cjs',
  'server/lib/runtimeSecrets.ts',
  'server/lib/vault.ts',
  'server/lib/version.ts',
  'server/generated/openapi.json',
  'server/db/postgres/schema.ts',
  'client/index.html',
  'client/js/app.ts',
  'scripts/package-release.js',
  'scripts/release-integrity.js',
  'STICKER_REFERENCE.sha256',
];

function fail(message) {
  throw new Error(message);
}

function portable(relativePath) {
  return relativePath.split(path.sep).join('/');
}

// Names that do not survive every supported platform, plus `;`: MSYS path-list
// conversion turns `C:` into `;C`, which is how an empty `k8s/helm;C/` directory
// reached the Final20 archive. Reserved Windows device names are included too.
const NON_PORTABLE_NAME = /[<>:"|?*;\\\u0000-\u001f]|[ .]$|^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

function assertPortableEntryName(name, relative) {
  if (NON_PORTABLE_NAME.test(name)) fail(`Refusing non-portable release entry name: ${portable(relative)}`);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isExcluded(relativePath, isDirectory) {
  const relative = portable(relativePath);
  const lowerRelative = relative.toLocaleLowerCase('en-US');
  const parts = relative.split('/');
  const lowerParts = lowerRelative.split('/');
  const name = parts[parts.length - 1];
  const lowerName = lowerParts[lowerParts.length - 1];

  if (EXCLUDED_RELATIVE_PATHS.has(relative)) return true;
  if ([...EXCLUDED_RELATIVE_PATHS].some((prefix) => relative.startsWith(`${prefix}/`))) return true;
  // Directory policies must only inspect directory path components.  The old
  // implementation also tested the final file name, so the first-class
  // `server/COVERAGE_DEBT.json` contract was silently treated as generated
  // coverage output and removed from every release ZIP.
  const directoryParts = isDirectory ? lowerParts : lowerParts.slice(0, -1);
  if (directoryParts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part)
    || /^coverage(?:[-_.].+)?$/.test(part))) {
    return true;
  }
  // Keep generated top-level coverage report files out, without matching the
  // explicit coverage debt policy artifact above.
  if (!isDirectory && lowerName !== 'coverage_debt.json'
    && /^coverage(?:[-_.].+)?\.(?:json|xml|lcov|txt|html)$/.test(lowerName)) return true;
  if (lowerRelative === 'e2e/fixtures' || lowerRelative.startsWith('e2e/fixtures/')
    || lowerRelative === 'e2e/screenshots' || lowerRelative.startsWith('e2e/screenshots/')) {
    return true;
  }
  if (lowerRelative === 'uploads' || lowerRelative.startsWith('uploads/')) return true;

  if (lowerRelative === 'server/uploads') return false;
  if (lowerRelative.startsWith('server/uploads/')) {
    if (lowerRelative === 'server/uploads/.gitkeep') return false;
    if (lowerRelative === 'server/uploads/stickers' || lowerRelative.startsWith('server/uploads/stickers/')) return false;
    if (lowerRelative === 'server/uploads/_quarantine') return false;
    if (lowerRelative === 'server/uploads/_quarantine/.gitkeep') return false;
    return true;
  }

  if (lowerName.startsWith('.env') && (isDirectory || !SAFE_ENV_EXAMPLES.has(lowerName))) return true;
  if (isDirectory) return false;
  if (lowerName.includes('._deprecated.') || /(?:^|[._-])deprecated(?:[._-]|$)/.test(lowerName)) return true;
  if (lowerName === MANIFEST_NAME.toLocaleLowerCase('en-US')) return true;
  if (lowerName === '.ds_store' || name.startsWith('._')) return true;
  if (lowerName === 'audit.json'
    || lowerName === 'jest-results.json'
    || lowerName === 'eslint-errors.json'
    || lowerName === 'playwright-results.xml'
    || /(?:^|[-_.])(?:failures?|results?)\.json$/.test(lowerName)
    || /^server-(?:jest|pg)[^/]*\.json$/.test(lowerRelative)
    || /^e2e\/_[^/]*-report\.json$/.test(lowerRelative)) return true;
  if (/^(npm-debug|yarn-error)\.log/.test(lowerName)
    || lowerName.endsWith('.log')
    || lowerName.endsWith('.zip')
    || lowerName.endsWith('.tsbuildinfo')
    || lowerName.endsWith('.rc')
    || /^core(?:\.\d+)?$/.test(lowerName)
    || /\.(?:aof|bak|core|crash|db|dmp|dump|orig|pid|rdb|rej|seed|sqlite\d*|tmp)$/.test(lowerName)) return true;
  return false;
}

function copyReleaseTree(source, destination) {
  let files = 0;
  let bytes = 0;

  function visit(sourceDirectory, destinationDirectory, prefix) {
    fs.mkdirSync(destinationDirectory, { recursive: true });
    const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (isExcluded(relative, entry.isDirectory())) continue;
      assertPortableEntryName(entry.name, relative);
      const from = path.join(sourceDirectory, entry.name);
      const to = path.join(destinationDirectory, entry.name);
      if (entry.isSymbolicLink()) fail(`Release source contains a symbolic link: ${portable(relative)}`);
      if (entry.isDirectory()) visit(from, to, relative);
      else if (entry.isFile()) {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        const size = fs.statSync(to).size;
        files += 1;
        bytes += size;
      } else fail(`Unsupported release source entry: ${portable(relative)}`);
    }
  }

  visit(source, destination, '');
  return { files, bytes };
}

function compareReleaseTrees(source, candidate) {
  const sourceFiles = [];

  function visit(directory, prefix) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
      if (isExcluded(relativePath, entry.isDirectory())) continue;
      const absolute = path.join(directory, entry.name);
      const relative = portable(relativePath);
      if (entry.isSymbolicLink()) fail(`Release source contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) visit(absolute, relativePath);
      else if (entry.isFile()) {
        sourceFiles.push({ relative, size: fs.statSync(absolute).size, sha256: hashFile(absolute) });
      } else fail(`Unsupported release source entry: ${relative}`);
    }
  }

  visit(path.resolve(source), '');
  const candidateFiles = walkFiles(candidate, { ignore: [MANIFEST_NAME] })
    .map((file) => ({ ...file, sha256: hashFile(file.absolute) }));
  const sourceMap = new Map(sourceFiles.map((file) => [file.relative, file]));
  const candidateMap = new Map(candidateFiles.map((file) => [file.relative, file]));
  const missing = [...sourceMap.keys()].filter((relative) => !candidateMap.has(relative));
  const extra = [...candidateMap.keys()].filter((relative) => !sourceMap.has(relative));
  const mismatched = [...sourceMap].filter(([relative, wanted]) => {
    const found = candidateMap.get(relative);
    return found && (found.size !== wanted.size || found.sha256 !== wanted.sha256);
  }).map(([relative]) => relative);
  if (missing.length || extra.length || mismatched.length) {
    fail(
      `Source/package mismatch (missing=${missing.slice(0, 10).join(',') || 'none'}; `
      + `extra=${extra.slice(0, 10).join(',') || 'none'}; `
      + `hash/size=${mismatched.slice(0, 10).join(',') || 'none'})`,
    );
  }
  return {
    files: sourceFiles.length,
    bytes: sourceFiles.reduce((sum, file) => sum + file.size, 0),
    missing: 0,
    extra: 0,
    mismatched: 0,
  };
}

function assertRequiredReleaseFiles(root) {
  const missing = REQUIRED_RELEASE_FILES.filter((relative) => {
    const absolute = path.join(root, ...relative.split('/'));
    return !fs.existsSync(absolute) || !fs.statSync(absolute).isFile();
  });
  if (missing.length) fail(`Release is missing required source files: ${missing.join(',')}`);
  return { files: REQUIRED_RELEASE_FILES.length };
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
}

/**
 * Windows'ta KULLANILACAK tar ACIKCA secilir.
 *
 * -- OLCULEN KUSUR --------------------------------------------------------
 * Bu dosya `tar.exe` derken Windows'un birlikte geldigi **bsdtar**'i
 * kastediyordu. Ama PATH'te once baska bir tar bulunabilir: Git for Windows
 * kendi GNU tar'ini kurar ve cogu gelistirici kabugunda o ONCE gelir.
 *
 * GNU tar, surucu harfi tasiyan bir `-f` hedefini `host:path` bicimli bir
 * UZAK hedef sanar ve paketleme su hatayla duser:
 *
 *     tar: Cannot connect to C: resolve failed
 *
 * Yani surum paketi, tamamen PATH SIRASINA bagli olarak uretilebiliyor ya da
 * uretilemiyordu. Bu, "makinemde calisiyor" sinifinin ta kendisidir.
 *
 * Cozum, hangi ikilinin kastedildigini ACIKCA yazmaktir. Sistem yolundaki
 * bsdtar varsa o kullanilir; yoksa PATH'teki `tar.exe`ye duselir (ortamin
 * kendi bsdtar'i olabilir).
 */
function windowsTarCommand() {
  const systemRoot = process.env.SystemRoot || process.env.windir
    || path.join('C:' + '\\', 'Windows');
  const systemTar = path.join(systemRoot, 'System32', 'tar.exe');
  return fs.existsSync(systemTar) ? systemTar : 'tar.exe';
}

function hasCommand(command, versionArgs = ['--version']) {
  // Tool CLIs do not agree on a GNU-style --version flag. Info-ZIP `unzip`
  // exits non-zero for `--version` even when it is installed, which made the
  // release packager falsely report that no integrity checker existed. Probe
  // each tool with the version/listing switch it actually supports.
  const probe = childProcess.spawnSync(command, versionArgs, { stdio: 'ignore', windowsHide: true });
  return !probe.error && probe.status === 0;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * ARSIV YENIDEN URETILEBILIR OLMAK ZORUNDADIR
 * ══════════════════════════════════════════════════════════════════════════
 * Onceden `bsdtar`/`zip`e devrediliyordu. Ikisi de ZIP girdilerine DOSYA
 * DEGISTIRME ZAMANINI yazar ve girdileri dizin gezinme sirasina gore dizer.
 * `copyReleaseTree` her kosumda dosyalari yeniden kopyaladigi icin mtime'lar
 * degisir ve AYNI KAYNAK FARKLI BAYTLAR uretir.
 *
 * OLCULDU (Final19) — ayni agactan iki paketleme:
 *     df53bfebea697e090da6cf66ed77ab1a9052702dad59eaa31b9da011c64054c8
 *     c338156bf00f4dbe566fb15562aa76163756e8dc1bf55572e8d575ab16dc4c4d
 *
 * Bu, surum butunlugu icin gercek bir eksikti: iki taraf ayni kaynaktan ayni
 * ZIP'i uretip SHA karsilastiramiyordu; yani "bu artefakt bu kaynaktan geldi"
 * bagimsiz olarak DOGRULANAMIYORDU.
 *
 * `scripts/deterministic-zip.js` girdi sirasini, zaman damgalarini,
 * sikistirmayi, dis oznitelikleri ve yol kodlamasini normalize eder. Uretilen
 * arsiv ayni dogrulama hattindan (listeleme + TAM cikartma + manifest +
 * sticker + gizli tarama) gecmeye devam eder; yani yazicinin dogrulugu bu
 * betigin kendi kanitlariyla olculur.
 */
function createArchive(stagedParent, archivePath) {
  const entries = writeDeterministicZip(stagedParent, SOURCE_NAME, archivePath);
  if (entries < 1) fail('Deterministic archive contained no entries');
  return 'deterministic-zip';
}

function verifyArchiveIntegrity(archivePath) {
  if (process.platform === 'win32') {
    // libarchive reads the complete central directory here; the independent
    // extraction below reads every payload and therefore validates entry CRCs.
    run(windowsTarCommand(), ['-t', '-f', archivePath]);
    return 'bsdtar-list+extract';
  }
  if (hasCommand('unzip', ['-v'])) {
    run('unzip', ['-tq', archivePath]);
    return 'unzip-test';
  }
  fail("No ZIP integrity checker is available (install the 'unzip' command)");
}

function extractArchive(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === 'win32') {
    run(windowsTarCommand(), ['-x', '-f', archivePath, '-C', destination]);
    return;
  }
  if (hasCommand('unzip', ['-v'])) {
    run('unzip', ['-q', archivePath, '-d', destination]);
    return;
  }
  fail("No ZIP extractor is available (install the 'unzip' command)");
}

function assertSingleReleaseRoot(parent, expectedName) {
  const entries = fs.readdirSync(parent, { withFileTypes: true });
  if (entries.length !== 1
    || entries[0].name !== expectedName
    || entries[0].isSymbolicLink()
    || !entries[0].isDirectory()) {
    fail(`Archive must contain exactly one real top-level directory named ${expectedName}`);
  }
  return path.join(parent, expectedName);
}

function publishVerifiedArchive(temporaryArchive, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
    fail(`Output path is a directory: ${outputPath}`);
  }
  const transfer = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(temporaryArchive, transfer, fs.constants.COPYFILE_EXCL);
  try {
    fs.rmSync(outputPath, { force: true });
    fs.renameSync(transfer, outputPath);
  } finally {
    fs.rmSync(transfer, { force: true });
  }
}

function packageRelease(suppliedOutput) {
  const outputPath = path.resolve(suppliedOutput || path.join(path.dirname(SOURCE_ROOT), `bridge-v${PACKAGE.version}.zip`));
  if (isInside(SOURCE_ROOT, outputPath)) fail(`Output ZIP must be outside the source tree: ${outputPath}`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-'));
  const stagedParent = path.join(temporaryRoot, 'staged');
  const stagedRoot = path.join(stagedParent, SOURCE_NAME);
  const freshParent = path.join(temporaryRoot, 'fresh');
  const freshRoot = path.join(freshParent, SOURCE_NAME);
  const temporaryArchive = path.join(temporaryRoot, 'bridge-release.zip');

  try {
    const stickerReference = verifyStickerReference(
      SOURCE_ROOT,
      path.join(SOURCE_ROOT, 'STICKER_REFERENCE.sha256'),
      242,
    );
    const copied = copyReleaseTree(SOURCE_ROOT, stagedRoot);
    const stagedSource = compareReleaseTrees(SOURCE_ROOT, stagedRoot);
    const required = assertRequiredReleaseFiles(stagedRoot);
    const manifest = createManifest(stagedRoot);
    const archiveTool = createArchive(stagedParent, temporaryArchive);
    const archiveIntegrityTool = verifyArchiveIntegrity(temporaryArchive);
    extractArchive(temporaryArchive, freshParent);
    assertSingleReleaseRoot(freshParent, SOURCE_NAME);
    const verified = verifyManifest(freshRoot);
    const freshSource = compareReleaseTrees(SOURCE_ROOT, freshRoot);
    assertRequiredReleaseFiles(freshRoot);
    const stickers = compareStickers(SOURCE_ROOT, freshRoot, 242);
    const secrets = scanReleaseSecrets(freshRoot);
    publishVerifiedArchive(temporaryArchive, outputPath);
    return {
      path: outputPath,
      bytes: fs.statSync(outputPath).size,
      sha256: hashFile(outputPath),
      archiveTool,
      archiveIntegrityTool,
      copiedFiles: copied.files,
      sourceFiles: stagedSource.files,
      sourceBytes: stagedSource.bytes,
      sourceMissing: freshSource.missing,
      sourceExtra: freshSource.extra,
      sourceMismatched: freshSource.mismatched,
      requiredSourceFiles: required.files,
      manifestFiles: manifest.files,
      verifiedFiles: verified.files,
      stickerFiles: stickers.files,
      stickerBytes: stickers.bytes,
      stickerSha256: stickers.sha256,
      stickerPngSignatureFiles: stickers.pngSignatureFiles,
      stickerInvalidPngSignatureFiles: stickers.invalidPngSignatureFiles,
      stickerReferenceMissing: stickerReference.missing,
      stickerReferenceExtra: stickerReference.extra,
      stickerReferenceMismatched: stickerReference.mismatched,
      secretScanFiles: secrets.files,
      secretScanBytes: secrets.bytes,
      secretScanFindings: secrets.findings,
      secretScanAllowedFixtureMatches: secrets.allowedFixtureMatches,
      secretScanAllowedPlaceholderMatches: secrets.allowedPlaceholderMatches,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

module.exports = {
  assertSingleReleaseRoot,
  compareReleaseTrees,
  copyReleaseTree,
  isExcluded,
  packageRelease,
};

if (require.main === module) {
  try {
    const report = packageRelease(process.argv[2]);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`Release packaging failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
