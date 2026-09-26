'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  compareStickers,
  createManifest,
  parseManifest,
  scanReleaseSecrets,
  stickerSnapshot,
  verifyManifest,
  verifyStickerReference,
} = require('./release-integrity');
const {
  assertSingleReleaseRoot,
  compareReleaseTrees,
  copyReleaseTree,
  isExcluded,
} = require('./package-release');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-integrity-'));
  fs.mkdirSync(path.join(root, 'server', 'uploads', 'stickers'), { recursive: true });
  fs.mkdirSync(path.join(root, 'client'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(root, 'server', 'uploads', 'stickers', 'one.png'), 'PNG');
  return root;
}

test('manifest verifies the exact extracted file set and file content', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const made = createManifest(root);
  assert.equal(made.files, 2);
  assert.equal(verifyManifest(root).files, 2);

  fs.writeFileSync(path.join(root, 'client', 'index.html'), 'tampered');
  assert.throws(() => verifyManifest(root), /mismatch/i);
});

test('manifest rejects files added after it was generated', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createManifest(root);
  fs.writeFileSync(path.join(root, 'unexpected.txt'), 'extra');
  assert.throws(() => verifyManifest(root), /extra=unexpected\.txt/);
});

test('sticker comparison covers names, sizes, hashes, count, and non-empty .png files', (t) => {
  const source = fixture();
  const candidate = fixture();
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  t.after(() => fs.rmSync(candidate, { recursive: true, force: true }));

  const snapshot = stickerSnapshot(source, 1);
  assert.equal(snapshot.files, 1);
  assert.equal(snapshot.pngSignatureFiles, 0);
  assert.equal(snapshot.invalidPngSignatureFiles, 1);
  assert.equal(compareStickers(source, candidate, 1).sha256, snapshot.sha256);

  fs.writeFileSync(path.join(candidate, 'server', 'uploads', 'stickers', 'one.png'), 'BAD');
  assert.throws(() => compareStickers(source, candidate, 1), /differs/);
});

test('authoritative source manifest detects an unexpected sticker mutation', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sticker = path.join(root, 'server', 'uploads', 'stickers', 'one.png');
  const reference = path.join(root, 'checkpoint.sha256');
  const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(sticker)).digest('hex');
  fs.writeFileSync(reference, `${hash}  server/uploads/stickers/one.png\n`);

  assert.deepEqual(
    { ...verifyStickerReference(root, reference, 1), sha256: undefined },
    {
      files: 1,
      bytes: 3,
      sha256: undefined,
      pngSignatureFiles: 0,
      invalidPngSignatureFiles: 1,
      missing: 0,
      extra: 0,
      mismatched: 0,
    },
  );
  fs.writeFileSync(sticker, 'changed');
  assert.throws(() => verifyStickerReference(root, reference, 1), /hash\/size=1/);
});

test('release filter omits generated/private data but preserves authoritative stickers', () => {
  for (const excluded of [
    'node_modules/package/index.js',
    'client/coverage/coverage-final.json',
    'client/coverage-soundboard-focused/coverage-final.json',
    'server/coverage_repo_diagnostic/lcov.info',
    'server/dist/index.js',
    'bot-sdk/dist/index.js',
    'server/.tsbuildinfo',
    'server/uploads/private-message.png',
    'server/uploads/_quarantine/untrusted.bin',
    'uploads/runtime.bin',
    'pgdata/base/1',
    'redis-data/dump.rdb',
    'minio-data/.minio.sys/config.json',
    'e2e/fixtures/tokens.json',
    'e2e/screenshots/generated.png',
    'e2e/playwright-results.xml',
    'e2e/_soak-report.json',
    'audit.json',
    'server-jest-results.json',
    'server-pg-integration.json',
    'server/schema-failures.json',
    '.env.production',
    '.env.staging',
    'server/.env.test',
    'debug.log',
    'old-release.zip',
    'electron/package.json.bak',
    'server/routes/auth.ts.orig',
    'client/js/app.ts.rej',
    'temporary.tmp',
  ]) assert.equal(isExcluded(excluded, false), true, excluded);

  assert.equal(isExcluded('.env.production', true), true, '.env.production directory');

  for (const included of [
    'client/js/app.ts',
    '.env.example',
    '.env.docker',
    'server/.env.test.example',
    'server/uploads/.gitkeep',
    'server/uploads/_quarantine/.gitkeep',
    'server/uploads/stickers/one.png',
  ]) assert.equal(isExcluded(included, false), false, included);
});

test('manifest parser rejects traversal, drive-qualified, and duplicate paths', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'unsafe.sha256');
  const hash = 'a'.repeat(64);

  fs.writeFileSync(manifest, `${hash}  1  ../escape\n`);
  assert.throws(() => parseManifest(manifest), /escapes/);
  fs.writeFileSync(manifest, `${hash}  1  C:/escape\n`);
  assert.throws(() => parseManifest(manifest), /escapes/);
  fs.writeFileSync(manifest, `${hash}  1  same.txt\n${hash}  1  same.txt\n`);
  assert.throws(() => parseManifest(manifest), /Duplicate/);
});

test('source/package comparison proves every included byte and rejects drift', (t) => {
  const source = fixture();
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-candidate-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  t.after(() => fs.rmSync(candidate, { recursive: true, force: true }));

  fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(source, 'node_modules', 'excluded.js'), 'private cache');
  copyReleaseTree(source, candidate);
  assert.deepEqual(
    { ...compareReleaseTrees(source, candidate), bytes: undefined },
    { files: 2, bytes: undefined, missing: 0, extra: 0, mismatched: 0 },
  );
  fs.writeFileSync(path.join(candidate, 'client', 'index.html'), 'changed');
  assert.throws(() => compareReleaseTrees(source, candidate), /hash\/size=client\/index\.html/);
});

test('release packager refuses non-portable entry names such as MSYS path-list debris', (t) => {
  // Final21 Faz 10: the Final20 archive shipped an empty `k8s/helm;C/` directory —
  // a Windows path mangled by MSYS path-list conversion (`:` -> `;`). The packager
  // copied it because it copies every non-excluded directory, empty or not.
  const source = fixture();
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-candidate-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  t.after(() => fs.rmSync(candidate, { recursive: true, force: true }));

  fs.mkdirSync(path.join(source, 'k8s', 'helm;C'), { recursive: true });
  assert.throws(() => copyReleaseTree(source, candidate), /non-portable release entry name: k8s\/helm;C/);

  const clean = fixture();
  const cleanCandidate = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-candidate-'));
  t.after(() => fs.rmSync(clean, { recursive: true, force: true }));
  t.after(() => fs.rmSync(cleanCandidate, { recursive: true, force: true }));
  fs.mkdirSync(path.join(clean, 'k8s', 'helm', 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(clean, 'k8s', 'helm', 'bridge', 'Chart.yaml'), 'name: bridge\n');
  assert.equal(copyReleaseTree(clean, cleanCandidate).files, 3);
});

test('fresh extraction must contain exactly one real release root', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-root-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.mkdirSync(path.join(parent, 'Bridge'));
  assert.equal(assertSingleReleaseRoot(parent, 'Bridge'), path.join(parent, 'Bridge'));
  fs.writeFileSync(path.join(parent, 'extra.txt'), 'unexpected');
  assert.throws(() => assertSingleReleaseRoot(parent, 'Bridge'), /exactly one/);
});

test('secret scan blocks deployable tokens while classifying synthetic test fixtures', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'server', 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'server', 'tests', 'token.test.ts'),
    `const token = '${'eyJ' + 'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}';`,
  );
  const clean = scanReleaseSecrets(root);
  assert.equal(clean.findings, 0);
  assert.equal(clean.allowedFixtureMatches, 1);

  fs.mkdirSync(path.join(root, 'e2e', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'e2e', 'fixtures', 'tokens.json'), '{}');
  assert.throws(() => scanReleaseSecrets(root), /generated-e2e-credential-artifact:e2e\/fixtures\/tokens\.json:1/);
  fs.rmSync(path.join(root, 'e2e'), { recursive: true, force: true });

  fs.writeFileSync(path.join(root, 'client', 'runtime-config.js'), `export const token = 'ghp_${'a'.repeat(36)}';`);
  assert.throws(() => scanReleaseSecrets(root), /github-token:client\/runtime-config\.js:1/);
});

test('source tree keeps Discord palette colors out of Bridge product surfaces', () => {
  const root = path.resolve(__dirname, '..');
  const allowedExtensions = new Set(['.ts', '.js', '.css', '.html', '.svelte']);
  const excludedDirs = new Set(['node_modules', 'discord-shim', 'dist', 'www', '.git']);
  const forbidden = [
    '#' + '5865' + 'f2',
    '#' + '7289' + 'da',
    '#' + '4752' + 'c4',
  ];
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excludedDirs.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      const file = path.join(dir, entry.name);
      if (!allowedExtensions.has(path.extname(file))) continue;
      const source = fs.readFileSync(file, 'utf8').toLowerCase();
      if (forbidden.some((color) => source.includes(color))) {
        hits.push(path.relative(root, file));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, [], `forbidden Discord palette remains in source: ${hits.join(', ')}`);
});

test('deploy preflight is strict while CI/local preflight can remain non-strict', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const preflight = fs.readFileSync(path.join(root, 'scripts', 'production-preflight.sh'), 'utf8');
  assert.match(pkg.scripts?.['deploy:preflight'] || '', /PREFLIGHT_STRICT=1/);
  assert.match(preflight, /STRICT="\$\{PREFLIGHT_STRICT:-0\}"/);
  assert.match(preflight, /production preflight için zorunlu/);
  assert.match(preflight, /strict production preflight compose şemasını doğrulayamıyor/);
});

test('TURN readiness never advertises credential-less static relay as healthy', () => {
  const root = path.resolve(__dirname, '..');
  const turn = fs.readFileSync(path.join(root, 'server', 'lib', 'turnConfig.ts'), 'utf8');
  assert.match(
    turn,
    /else if \(process\.env\.TURN_URL && process\.env\.TURN_USERNAME && process\.env\.TURN_CREDENTIAL\)/,
  );
  assert.doesNotMatch(turn, /credential:\s*process\.env\.TURN_CREDENTIAL\s*\|\|\s*['"]{2}/);
  assert.match(turn, /const hasTurn = hasTurnServer\(servers\)/);
});

test('required TURN/SFU policy fails closed in readiness and deploy preflight', () => {
  const root = path.resolve(__dirname, '..');
  const health = fs.readFileSync(path.join(root, 'server', 'routes', 'health.ts'), 'utf8');
  const preflight = fs.readFileSync(path.join(root, 'scripts', 'production-preflight.sh'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const envExample = fs.readFileSync(path.join(root, 'server', '.env.example'), 'utf8');
  assert.match(health, /process\.env\.REQUIRE_TURN === 'true' && !getTurnStatus\(\)\.turn/);
  assert.match(health, /process\.env\.REQUIRE_SFU === 'true'/);
  assert.match(health, /stats\.healthy < 1/);
  assert.match(preflight, /REQUIRE_TURN=true ancak credentialed TURN yapılandırması eksik/);
  assert.match(preflight, /REQUIRE_SFU=true ancak MEDIASOUP_ANNOUNCED_IP eksik/);
  assert.match(compose, /REQUIRE_TURN: "\$\{REQUIRE_TURN:-false\}"/);
  assert.match(compose, /REQUIRE_SFU: "\$\{REQUIRE_SFU:-false\}"/);
  assert.match(envExample, /REQUIRE_TURN=true/);
  assert.match(envExample, /REQUIRE_SFU=true/);
});


test('migration rollback verifier offers dependency-free static integrity without weakening DB proof', () => {
  const root = path.resolve(__dirname, '..');
  const verifier = fs.readFileSync(path.join(root, 'server', 'scripts', 'verify-migration-rollback.js'), 'utf8');
  assert.match(verifier, /process\.argv\.includes\('--static'\)/);
  assert.match(verifier, /if \(!STATIC_ONLY\)/);
  assert.match(verifier, /require\('pg'\)/);
  assert.match(verifier, /orphan rollback \(up migration yok\)/);
  assert.match(verifier, /Gerçek lossless\/ordered kanıt için PostgreSQL DB modu ayrıca zorunludur/);
});

test('production-reachable client surfaces do not retain Discord legacy palette fallbacks', () => {
  const scanner = require('../client/scripts/production-reachable-coverage.js');
  const forbidden = /#(?:43b581|57f287|f04747|ed4245|99aab5|2c2f33|393c40|4f545c|eb459e)\b/i;
  const findings = [];
  for (const file of scanner.reachableSet()) {
    if (!/\.(?:svelte|ts)$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const match = source.match(forbidden);
    if (match) findings.push(`${path.relative(scanner.CLIENT, file)}:${match[0]}`);
  }
  assert.deepEqual(findings, [], `legacy Discord palette leaked into production graph: ${findings.join(', ')}`);
});

test('release source excludes historical, legacy, disabled, and deprecated implementation artifacts', () => {
  const root = path.resolve(__dirname, '..');
  const forbiddenRoot = /^(?:AI_|CHATGPT_|STRICT_REFACTOR_|BRIDGE_REVIEW_|.*HANDOFF)/i;
  const rootHits = fs.readdirSync(root).filter((name) => forbiddenRoot.test(name));
  assert.deepEqual(rootHits, [], `historical root artifacts: ${rootHits.join(', ')}`);

  const forbiddenDirs = new Set(['_legacy', '_archived_legacy', 'tests-legacy', 'workflows.disabled']);
  const forbiddenExact = new Set([
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
  const findings = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (forbiddenDirs.has(entry.name) || relative === '.github/disabled' || forbiddenExact.has(relative)) {
          findings.push(relative);
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        const lower = entry.name.toLocaleLowerCase('en-US');
        if (forbiddenExact.has(relative) || lower.includes('._deprecated.') || /(?:^|[._-])deprecated(?:[._-]|$)/.test(lower)) findings.push(relative);
      }
    }
  };
  walk(root);
  assert.deepEqual(findings, [], `forbidden release artifacts: ${findings.join(', ')}`);

  const guard = fs.readFileSync(path.join(root, 'scripts/check-no-legacy.mjs'), 'utf8');
  const packager = fs.readFileSync(path.join(root, 'scripts/package-release.js'), 'utf8');
  for (const token of ['tests-legacy', 'workflows.disabled', '_archived_legacy', 'client/.storybook', 'client/tests/package.json', 'client/vitest.config.ts', 'server/package.json.presfu', 'fix-registry-calls.sh']) {
    assert.ok(guard.includes(token));
    assert.ok(packager.includes(token));
  }
});

test('server CSP keeps executable style blocks nonce-bound and serves API docs from local package assets', () => {
  const root = path.resolve(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'server/app/createApp.ts'), 'utf8');
  const swagger = fs.readFileSync(path.join(root, 'server/lib/swagger.ts'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'server/app/setupRoutes.ts'), 'utf8');
  const podcast = fs.readFileSync(path.join(root, 'server/routes/podcast.ts'), 'utf8');
  assert.doesNotMatch(app, /styleSrc:\s*\[[^\]]*['"]unsafe-inline['"]/);
  assert.match(app, /styleSrcElem:/);
  assert.match(app, /styleSrcAttr:\s*\[["']'unsafe-inline'["']\]/);
  assert.doesNotMatch(app, /cdn\.jsdelivr\.net/);
  assert.doesNotMatch(app, /const cdnHosts/);
  assert.match(swagger, /swaggerUi\.serve/);
  assert.match(swagger, /swaggerUi\.setup\(getSpec\(\)/);
  assert.match(routes, /mountApi\('\/docs', swaggerRouter\)/);
  assert.equal(fs.existsSync(path.join(root, 'server/routes/apidocs.ts')), false);
  assert.doesNotMatch(podcast, /style-src 'unsafe-inline'/);
  assert.match(podcast, /style-src 'nonce-\$\{cspNonce\}'/);
});

test('production launcher hydrates external secrets before importing the runtime graph and stays in the hardening ratchet', () => {
  const root = path.resolve(__dirname, '..');
  const launcher = fs.readFileSync(path.join(root, 'server/index.ts'), 'utf8');
  const hardening = JSON.parse(fs.readFileSync(path.join(root, 'server/tsconfig.hardening.json'), 'utf8'));
  const hydrateCall = launcher.indexOf('await hydrateRuntimeSecrets()');
  const runtimeImport = launcher.indexOf("await import('./runtime')");
  assert.ok(hydrateCall >= 0, 'launcher must hydrate external secrets');
  assert.ok(runtimeImport > hydrateCall, 'runtime graph must be imported only after secret hydration');
  assert.doesNotMatch(launcher, /^import\s+['"]\.\/runtime['"];?$/m);
  for (const owner of ['index.ts', 'lib/runtimeSecrets.ts', 'lib/vault.ts', 'lib/version.ts']) {
    assert.ok(hardening.include.includes(owner), `${owner} must stay in typecheck:hardening`);
  }
});

// Final21 Phase 12 replaced the bundled-server lifecycle (spawn + 127.0.0.1:3001
// readiness polling) with a client that connects to a verified Bridge server. The
// installed build proved the old path could not start (no server node_modules,
// database or secrets). These invariants keep the replacement honest.
test('Electron desktop is a verified-server client with one deep-link owner and a fail-closed update feed', () => {
  const root = path.resolve(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const main = read('electron/main.ts');
  const pkg = JSON.parse(read('electron/package.json'));
  const nsis = read('electron/assets/installer.nsh');

  assert.equal((main.match(/app\.on\('open-url'/g) || []).length, 1);
  assert.doesNotMatch(main, /\(app as any\)/);
  assert.equal((main.match(/const hasCsp\b/g) || []).length, 1);
  // No bundled server process.
  assert.doesNotMatch(main, /child_process|spawn\(|ELECTRON_RUN_AS_NODE/);
  assert.equal(pkg.build.extraResources, undefined, 'server/client must not be bundled into the desktop app');
  // Connecting requires a Bridge liveness answer, never a redirect.
  assert.match(main, /\/api\/health\/live`, \{\s*redirect: 'error'/);
  assert.match(main, /body\?\.status === 'ok' && body\?\.check === 'liveness'/);
  // Installed builds expose no dev console.
  assert.match(main, /if \(!app\.isPackaged\) \{\s*viewItems\.push\(\{ label: 'DevTools'/);
  // No hard-coded update feed or certificate placeholder in source; signing uses CSC env.
  assert.equal(pkg.build.publish, undefined, 'update feed must be injected by the release workflow');
  assert.doesNotMatch(JSON.stringify(pkg.build), /WIN_CERT_PATH|signtoolOptions/);
  assert.equal(pkg.bridgeDesktop.allowUnsignedUpdates, false);
  // Branding and uninstall ownership checks.
  assert.equal(pkg.build.win.icon, 'assets/icon.ico');
  assert.ok(fs.existsSync(path.join(root, 'electron/assets/icon.ico')));
  assert.match(nsis, /!macro customUnInstall[\s\S]*bridgeRemoveOwnProtocol HKCU[\s\S]*bridgeRemoveOwnStartup/);
  assert.match(nsis, /StrCmp \$1 "\$INSTDIR" 0 \+2\s*DeleteRegKey \$\{ROOT\} "Software\\Classes\\bridge"/);
});

test('auth shell uses delegated actions so CSP needs neither unsafe-hashes nor wasm-unsafe-eval', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
  const auth = fs.readFileSync(path.join(root, 'client/js/core/auth-compat.ts'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'server/app/createApp.ts'), 'utf8');
  assert.doesNotMatch(html, /\son[a-zA-Z]+\s*=/);
  assert.match(html, /data-auth-action="login"/);
  assert.match(html, /data-auth-action="passkey-login"/);
  assert.match(auth, /function bindAuthShellEvents\(\)/);
  assert.match(auth, /closest<HTMLElement>\('\[data-auth-action\],\[data-auth-tab\]'\)/);
  assert.doesNotMatch(app, /unsafe-hashes/);
  assert.doesNotMatch(app, /wasm-unsafe-eval/);
});

test('rollback classification contains no unresolved KNOWN_DEBT and distinguishes expected dependencies', () => {
  const root = path.resolve(__dirname, '..');
  const classification = JSON.parse(fs.readFileSync(path.join(root, 'server/db/migrations_pg/rollback-classification.json'), 'utf8'));
  const entries = Object.entries(classification).filter(([key]) => !key.startsWith('$')).map(([, value]) => value);
  assert.equal(entries.filter((value) => value.classification === 'KNOWN_DEBT').length, 0);
  assert.ok(entries.some((value) => value.classification === 'EXPECTED_DEPENDENCY'));

  // ── SAYIM DEĞİL, ÇIRÇIR (RATCHET) ─────────────────────────────────────────
  // Burada `EXPECTED_IRREVERSIBLE === 2` SABİTLENMİŞTİ. Allowlist'in kendi
  // kuralı ise "düzeltilen bir migration listeden ÇIKARILMALI"dır; yani sayı
  // DÜŞTÜĞÜNDE bu sabit kırılıyor ve iyileşme bir hata gibi görünüyordu.
  // (Ölçüm izolasyonu düzeltilince `009_drop_ap_private_key_plaintext`
  // gerçekten kayıpsız hâle geldi ve listeden çıktı.) Doğru sözleşme: sayı
  // ARTMAZ ve her sınıflandırma geçerli kümeden gelir.
  const VALID = new Set([
    'EXPECTED_IRREVERSIBLE', 'EXPECTED_DEPENDENCY', 'EXPECTED_SHARED_OBJECTS', 'KNOWN_DEBT',
  ]);
  for (const value of entries) assert.ok(VALID.has(value.classification), `geçersiz sınıf: ${value.classification}`);
  assert.ok(entries.filter((value) => value.classification === 'EXPECTED_IRREVERSIBLE').length <= 2);

  // `EXPECTED_SHARED_OBJECTS` ilan edilen artık nesneleri BELGELEMEK zorundadır;
  // aksi hâlde sınıf, tamlık denetimini sessizce kapatan bir kaçış yolu olurdu.
  for (const value of entries) {
    if (value.classification !== 'EXPECTED_SHARED_OBJECTS') continue;
    assert.ok(Array.isArray(value.expectedLeftovers) && value.expectedLeftovers.length > 0);
  }
});

test('release packager binds stickers to the canonical dedicated reference manifest', () => {
  const root = path.resolve(__dirname, '..');
  const packager = fs.readFileSync(path.join(root, 'scripts/package-release.js'), 'utf8');
  const reference = path.join(root, 'STICKER_REFERENCE.sha256');
  assert.ok(fs.existsSync(reference));
  const lines = fs.readFileSync(reference, 'utf8').split(/\r?\n/).filter((line) => !line.startsWith('#') && line.includes('  server/uploads/stickers/'));
  assert.equal(lines.length, 242);
  assert.match(packager, /path\.join\(SOURCE_ROOT, 'STICKER_REFERENCE\.sha256'\)/);
  assert.doesNotMatch(packager, /CHATGPT_CURRENT_SOURCE_SHA256/);
  const verified = verifyStickerReference(root, reference, 242);
  assert.equal(verified.files, 242);
  assert.equal(verified.mismatched, 0);
});

test('release packager preserves COVERAGE_DEBT.json while excluding generated coverage output', () => {
  const { isExcluded } = require('./package-release');
  assert.equal(isExcluded('server/COVERAGE_DEBT.json', false), false);
  assert.equal(isExcluded('server/coverage/lcov.info', false), true);
  assert.equal(isExcluded('coverage-final.json', false), true);
});

test('release packager fail-closes if hardening-critical runtime contracts are absent', () => {
  const root = path.resolve(__dirname, '..');
  const packager = fs.readFileSync(path.join(root, 'scripts/package-release.js'), 'utf8');
  for (const relative of [
    'server/COVERAGE_DEBT.json',
    'server/runtime.ts',
    'server/lib/runtimeSecrets.ts',
    'server/lib/vault.ts',
    'server/lib/version.ts',
    'server/generated/openapi.json',
  ]) {
    assert.ok(fs.existsSync(path.join(root, relative)), `${relative} must exist in source`);
    assert.ok(packager.includes(`'${relative}'`), `${relative} must be required by release packager`);
  }
});

test('client tests have one canonical Vitest toolchain with no nested Jest compatibility package', () => {
  const root = path.resolve(__dirname, '..');
  for (const relative of [
    'client/tests/package.json',
    'client/tests/babel.config.js',
    'client/tests/helpers/setup.ts',
    'client/tests/helpers/canvas-mock.ts',
    'client/vitest.config.ts',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, `${relative} must stay retired`);
  }
  const setup = fs.readFileSync(path.join(root, 'client', 'vitest.setup.ts'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'client', 'vitest.config.mts'), 'utf8');
  const contributing = fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8');
  assert.doesNotMatch(setup, /globalThis[^\n]*\.jest\s*=|\bjest\s*:\s*\{/);
  assert.match(config, /include:\s*\[[^\]]*tests\/\*\*\/\*\.test\.ts/);
  assert.match(contributing, /tek canonical koşucusu Vitest/);
});

test('discord compatibility shim is a first-class workspace package backed by the canonical Bot SDK', () => {
  const root = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const botPackage = JSON.parse(fs.readFileSync(path.join(root, 'bot-sdk/package.json'), 'utf8'));
  const shimPackage = JSON.parse(fs.readFileSync(path.join(root, 'discord-shim/package.json'), 'utf8'));
  const shimSource = fs.readFileSync(path.join(root, 'discord-shim/src/index.ts'), 'utf8');
  const shimTsconfig = JSON.parse(fs.readFileSync(path.join(root, 'discord-shim/tsconfig.json'), 'utf8'));

  assert.ok(packageJson.workspaces.includes('bot-sdk'));
  assert.ok(packageJson.workspaces.includes('discord-shim'));
  assert.match(packageJson.scripts['typecheck:discord-shim'], /discord-shim\/tsconfig\.json/);
  assert.match(packageJson.scripts.typecheck, /typecheck:discord-shim/);
  assert.equal(shimPackage.main, 'dist/index.js');
  assert.equal(shimPackage.types, 'dist/index.d.ts');
  assert.equal(botPackage.name, 'bridge-bot-sdk');
  assert.equal(botPackage.version, packageJson.version);
  assert.equal(shimPackage.dependencies['bridge-bot-sdk'], botPackage.version);
  assert.equal(lockfile.packages['discord-shim'].dependencies['bridge-bot-sdk'], botPackage.version);
  assert.equal(lockfile.packages['node_modules/bridge-bot-sdk'].resolved, 'bot-sdk');
  assert.equal(lockfile.packages['node_modules/bridge-bot-sdk'].link, true);
  assert.equal(lockfile.packages['node_modules/bridge-discord-shim'].resolved, 'discord-shim');
  assert.equal(lockfile.packages['node_modules/bridge-discord-shim'].link, true);
  assert.equal(shimTsconfig.compilerOptions.outDir, 'dist');
  assert.equal(shimTsconfig.compilerOptions.declaration, true);
  assert.match(shimSource, /require\('bridge-bot-sdk'\)/);
  assert.doesNotMatch(shimSource, /require\(['"]\.\.\/bot-sdk\//);
});

test('production server dependencies are explicitly audited and Docker smoke-loads reachable route owners', () => {
  const root = path.resolve(__dirname, '..');
  const serverPkg = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8'));
  assert.equal(serverPkg.scripts?.['check:prod-deps'], 'node scripts/check-production-deps.cjs');
  assert.equal(serverPkg.dependencies?.['express-rate-limit'], '^8.5.2');
  assert.equal(serverPkg.dependencies?.['@xmldom/xmldom'], '^0.8.15');
  assert.equal(serverPkg.dependencies?.['form-data'], undefined, 'native Node FormData must replace legacy form-data package');
  const voice = fs.readFileSync(path.join(root, 'server', 'routes', 'voicemsg.ts'), 'utf8');
  assert.doesNotMatch(voice, /from ['"]form-data['"]/);
  assert.match(voice, /new FormData\(\)/);
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'quality-gate.yml'), 'utf8');
  assert.match(workflow, /Server production dependency contract/);
  assert.match(workflow, /Production image import smoke/);
  assert.match(workflow, /dist\/routes\/channelPerms\/helpers\.js/);
});

test('production API docs use the validated generated OpenAPI snapshot rather than optional swagger-jsdoc', () => {
  const root = path.resolve(__dirname, '..');
  const swagger = fs.readFileSync(path.join(root, 'server', 'lib', 'swagger.ts'), 'utf8');
  assert.match(swagger, /generated\/openapi\.json/);
  assert.doesNotMatch(swagger, /tryRequire<[^>]*>\(['"]swagger-jsdoc['"]\)/);
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'server', 'generated', 'openapi.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.version, pkg.version);
  assert.ok(Object.keys(spec.paths || {}).length > 0);
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /generate-openapi-runtime\.js/);
});

test('release source contains no excluded admin reference route, and the generated Capacitor www build can never be packaged', () => {
  const root = path.resolve(__dirname, '..');
  assert.equal(fs.existsSync(path.join(root, 'server', 'routes', 'admin-ipban-routes.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'mobile', 'index.template.html')), true);
  const setup = fs.readFileSync(path.join(root, 'mobile', 'scripts', 'setup.js'), 'utf8');
  assert.match(setup, /fs\.rmSync\(DEST, \{ recursive: true, force: true \}\)/);
  assert.match(setup, /index\.template\.html/);

  // ── OLCULEN KUSUR ────────────────────────────────────────────────────────
  // Bu sozlesme eskiden `mobile/www` DIZININ DISKTE OLMADIGINI dogruluyordu.
  // Iki ayri sorun uretiyordu:
  //
  //  1. YANLIS SEY OLCULUYORDU. Asil kural "www paketlenmemeli"dir; diskte
  //     bulunmamasi bunun zayif bir vekiliydi. Paketleyicinin dislama listesi
  //     `mobile/www` icermiyordu — yani www diskte varken paketleme yapilsaydi,
  //     istemcinin URETILMIS bir kopyasi surume GIRERDI. Dahasi
  //     `mobile/scripts/setup.js`, `BRIDGE_API_URL` ayarliysa kopyalanan JS
  //     icindeki host adreslerini YENIDEN YAZAR; bu da ozel bir API host'unun
  //     surum arsivine gomulmesi demekti.
  //
  //  2. KALITE KAPISINI KENDI KENDINE BOZUYORDU. `scripts/quality-gate.sh`
  //     once `mobile-build` adimini calistirip `mobile/www`yi URETIYOR, hemen
  //     ardindan bu testi kosuyordu; dolayisiyla kapi yerelde her zaman
  //     kaliyordu.
  //
  // Artik GERCEK sozlesme olculuyor: dizin ister olsun ister olmasin,
  // paketleyici onu DISLAMAK ZORUNDA ve depoya girmemesi icin git-ignore
  // edilmis olmali.
  const packager = fs.readFileSync(path.join(root, 'scripts', 'package-release.js'), 'utf8');
  assert.match(packager, /'mobile\/www'/,
    'package-release.js must list mobile/www in EXCLUDED_RELATIVE_PATHS');

  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.ok(
    gitignore.split(/\r?\n/).some((line) => line.trim() === 'mobile/www/' || line.trim() === 'mobile/www'),
    '.gitignore must keep the generated Capacitor web root out of the repository',
  );

  // Dislama kuralinin GERCEKTEN etkin oldugunu davranissal olarak dogrula:
  // listede adinin gecmesi yetmez, filtre onu ELEMELIDIR.
  const { isExcluded } = require('./package-release.js');
  assert.equal(isExcluded('mobile/www', true), true);
  assert.equal(isExcluded('mobile/www/index.html', false), true);
  assert.equal(isExcluded('mobile/www/js/core/api.js', false), true);
  // ...ve komsu gercek kaynak dosyalar ELENMEMELIDIR.
  assert.equal(isExcluded('mobile/index.template.html', false), false);
  assert.equal(isExcluded('mobile/capacitor.config.ts', false), false);
});

test('generated native build outputs (desktop release dir, Capacitor platform projects) are never packaged, committed or sent to Docker', () => {
  // Final21 Faz 19 (19-31), measured with the packager's own walk: after one desktop build the
  // archive would have carried electron-builder's output (78 files / ~490 MB: unsigned
  // `Bridge.exe`, `win-unpacked/`, the installer); after the documented `mobile:init` it would
  // have carried the root `android/` + `ios/` projects (176 files, incl. `js/bridge-config.js`
  // with the builder's API host).
  const root = path.resolve(__dirname, '..');
  const { isExcluded } = require('./package-release.js');
  // Bound to electron-builder's OWN configuration: moving its output directory must move this rule.
  const electronPkg = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
  const desktopOutput = `electron/${electronPkg.build.directories.output}`;
  assert.equal(isExcluded(desktopOutput, true), true, desktopOutput);
  assert.equal(isExcluded(`${desktopOutput}/Bridge Setup 1.125.0.exe`, false), true);
  assert.equal(isExcluded(`${desktopOutput}/win-unpacked/Bridge.exe`, false), true);
  // Capacitor creates platform projects next to the ROOT config (`capacitor.config.js`).
  assert.ok(fs.existsSync(path.join(root, 'capacitor.config.js')), 'root Capacitor config');
  for (const platform of ['android', 'ios']) {
    assert.equal(isExcluded(platform, true), true, platform);
    assert.equal(isExcluded(`${platform}/app/src/main/assets/public/js/bridge-config.js`, false), true);
  }
  // Curated native SOURCES stay in the release.
  for (const kept of [
    'mobile/android/app/build.gradle',
    'mobile/ios/App/App/Info.plist',
    'electron/assets/installer.nsh',
    'electron/package.json',
    'electron/updater.ts',
  ]) assert.equal(isExcluded(kept, false), false, kept);

  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  for (const line of [`${desktopOutput}/`, '/android/', '/ios/']) assert.ok(gitignore.includes(line), `.gitignore: ${line}`);
  const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  for (const line of [desktopOutput, 'android', 'ios']) assert.ok(dockerignore.includes(line), `.dockerignore: ${line}`);
});

test('coverage exceptions are explicit ratcheted policy instead of being presented as universal 90 percent', () => {
  const root = path.resolve(__dirname, '..');
  const debt = JSON.parse(fs.readFileSync(path.join(root, 'server', 'COVERAGE_DEBT.json'), 'utf8'));
  assert.equal(debt.globalFloor.lines, 90);
  const exceptions = Object.values(debt.exceptions || {});
  assert.ok(exceptions.length > 0);
  assert.ok(exceptions.some((x) => x.belowGlobal === true));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /COVERAGE_DEBT\.json/);
});

// ════════════════════════════════════════════════════════════════════════════
// YENIDEN URETILEBILIR PAKETLEME
// ════════════════════════════════════════════════════════════════════════════
// OLCULEN KUSUR: paketleyici `bsdtar`/`zip`e devrediyordu; ikisi de ZIP
// girdilerine DOSYA DEGISTIRME ZAMANINI yazar ve girdileri dizin gezinme
// sirasina gore dizer. Ayni kaynak iki kez paketlendiginde FARKLI baytlar
// olusuyordu (Final19'da olculdu: df53bfeb... ve c338156b...). Sonuc: iki
// taraf ayni kaynaktan ayni artefakti uretip SHA karsilastiramiyordu.
//
// Bu sozlesme "cikartilan icerik ayni" ile YETINMEZ — ZIP BAYTLARININ ayni
// olmasini sart kosar. Aksi halde surum artefakti bagimsiz olarak
// dogrulanamaz.
test('identical source produces byte-identical archives', (t) => {
  const { writeDeterministicZip } = require('./deterministic-zip');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-det-zip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Iki AYRI agac, ayni icerik — ama farkli mtime'lar (gercek paketlemede
  // `copyReleaseTree` her kosumda yeni mtime uretir; kusurun kaynagi buydu).
  for (const name of ['a', 'b']) {
    const tree = path.join(root, name, 'Bridge-main-reviewed');
    fs.mkdirSync(path.join(tree, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'one.txt'), 'hello release');
    fs.writeFileSync(path.join(tree, 'nested', 'two.txt'), 'second file payload');
    fs.writeFileSync(path.join(tree, 'nested', 'empty.txt'), '');
  }
  // `b` agacinin zaman damgalarini bilerek KAYDIR: normalize edilmezse
  // ciktilar ayrisir.
  const shifted = new Date('2001-02-03T04:05:06Z');
  for (const rel of ['one.txt', 'nested/two.txt', 'nested/empty.txt']) {
    fs.utimesSync(path.join(root, 'b', 'Bridge-main-reviewed', rel), shifted, shifted);
  }

  const zipA = path.join(root, 'a.zip');
  const zipB = path.join(root, 'b.zip');
  writeDeterministicZip(path.join(root, 'a'), 'Bridge-main-reviewed', zipA);
  writeDeterministicZip(path.join(root, 'b'), 'Bridge-main-reviewed', zipB);

  const bytesA = fs.readFileSync(zipA);
  const bytesB = fs.readFileSync(zipB);
  assert.equal(bytesA.length, bytesB.length, 'archive sizes must match');
  assert.ok(bytesA.equals(bytesB),
    'identical source with different mtimes must still produce identical archive bytes');
});

// Bir link olusturur: once dosya symlink'i, olmazsa dizin JUNCTION'i. Windows'ta dosya
// symlink'i yonetici/gelistirici modu ister; junction istemez ve Windows'taki gercekci
// link turudur. Node ikisini de `isSymbolicLink()` olarak bildirir. Final21 Faz 19'a kadar
// bu test Windows'ta ATLANIYORDU (tek atlanan surum-butunlugu testi).
function makeLinkOrJunction(dir, name, targetDir) {
  const link = path.join(dir, name);
  try { fs.symlinkSync(targetDir, link, 'dir'); return link; } catch { /* yetki yok */ }
  try { fs.symlinkSync(targetDir, link, 'junction'); return link; } catch { /* desteklenmiyor */ }
  return null;
}

test('deterministic archive refuses symbolic links instead of following them', (t) => {
  const { writeDeterministicZip } = require('./deterministic-zip');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-det-zip-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tree = path.join(root, 'Bridge-main-reviewed');
  fs.mkdirSync(path.join(tree, 'real'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'real', 'real.txt'), 'payload');
  const link = makeLinkOrJunction(tree, 'link', path.join(tree, 'real'));
  if (!link) { t.skip('neither symlink nor junction can be created here'); return; }
  assert.throws(
    () => writeDeterministicZip(root, 'Bridge-main-reviewed', path.join(root, 'out.zip')),
    /symbolic link is not packable/);
});

test('release copy refuses a link that points OUTSIDE the source tree', (t) => {
  // Bir junction/symlink izlenseydi, deponun disindaki dosyalar (orn. kullanicinin ev
  // dizini) surum paketine girerdi. Kopyalama adimi linki izlemek yerine REDDETMELIDIR.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-copy-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'Bridge-main-reviewed');
  const outside = path.join(root, 'outside-private');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(source, 'README.md'), 'ok');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'must never be packaged');
  const link = makeLinkOrJunction(source, 'docs', outside);
  if (!link) { t.skip('neither symlink nor junction can be created here'); return; }
  const candidate = path.join(root, 'candidate');
  assert.throws(() => copyReleaseTree(source, candidate), /symbolic link: docs/);
  assert.equal(fs.existsSync(path.join(candidate, 'docs', 'secret.txt')), false);
});
