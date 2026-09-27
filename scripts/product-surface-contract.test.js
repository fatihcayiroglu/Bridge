'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const scanner = require(path.join(ROOT, 'client/scripts/production-reachable-coverage.js'));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function reachableHits(pattern) {
  const hits = [];
  for (const file of scanner.reachableSet()) {
    const source = scanner.stripComments(fs.readFileSync(file, 'utf8'));
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      hits.push(`${path.relative(ROOT, file)}: ${match[0]}`);
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return hits;
}

test('production-reachable client code does not use native alert/confirm/prompt dialogs', () => {
  const hits = reachableHits(/\b(?:alert|confirm|prompt)\s*\(/g);
  assert.deepEqual(hits, [], `native browser dialog calls remain:\n${hits.join('\n')}`);
});

test('production-reachable client code does not directly render backend error/message fields', () => {
  // api-fetch may inspect a body.error value for CSRF classification, but a
  // production user sink must not directly receive an arbitrary backend body.
  const hits = reachableHits(
    /(?:toast\s*\(|textContent\s*=|innerText\s*=)[^\n;]{0,180}\b(?:body|data|payload|d)\.(?:error|message)\b/g,
  );
  assert.deepEqual(hits, [], `raw backend error display sinks remain:\n${hits.join('\n')}`);
});

test('top-level shell surfaces share one mutually-exclusive lifecycle coordinator', () => {
  const coordinator = read('client/js/core/exclusive-surface.ts');
  const expected = {
    inbox: 'closeInbox',
    saved: 'closeSaved',
    search: 'closeGlobalSearch',
    'server-search': 'closeSearch',
    pins: 'closePinnedMessages',
    command: 'closeCommandPalette',
    dm: 'closeDmPanel',
    friends: 'hideFriendsPanel',
    gdm: 'closeGroupDmPanel',
    discover: 'hideDiscoverPanel',
    marketplace: 'closeBotMarketplace',
  };
  for (const [surface, closer] of Object.entries(expected)) {
    assert.match(coordinator, new RegExp(`(?:'${surface}'|${surface}):\\s*'${closer}'`), `${surface} is not coordinated by ${closer}`);
  }
  assert.match(coordinator, /BridgeRegistry\.call\(closeOwner, false\)/, 'peer close must suppress stale focus restoration');

  const owners = {
    InboxPanel: ['client/js/core/InboxPanel.svelte', 'inbox'],
    SavedPanel: ['client/js/core/SavedPanel.svelte', 'saved'],
    GlobalSearchPanel: ['client/js/core/GlobalSearchPanel.svelte', 'search'],
    SearchPanel: ['client/js/core/SearchPanel.svelte', 'server-search'],
    PinnedMessagesPanel: ['client/js/core/PinnedMessagesPanel.svelte', 'pins'],
    CommandPalettePanel: ['client/js/core/CommandPalettePanel.svelte', 'command'],
    DmPanel: ['client/js/core/DmPanel.svelte', 'dm'],
    FriendsPanel: ['client/js/core/FriendsPanel.svelte', 'friends'],
    GroupDmPanel: ['client/js/core/GroupDmPanel.svelte', 'gdm'],
    DiscoverPanel: ['client/js/core/DiscoverPanel.svelte', 'discover'],
    MarketplaceShim: ['client/js/core/bot-marketplace/bot-marketplace-svelte.ts', 'marketplace'],
  };
  for (const [name, [file, surface]] of Object.entries(owners)) {
    assert.match(read(file), new RegExp(`closeExclusivePeers\\('${surface}'\\)`), `${name} bypasses the shell overlay coordinator`);
  }
});

test('canonical product dialog has accessible cancellation, focus and text-only rendering contracts', () => {
  const source = read('client/js/core/product-dialog.ts');
  assert.match(source, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(source, /role', options\.tone === 'danger' \? 'alertdialog' : 'dialog'/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /restoreFocus\?\.isConnected/);
  assert.match(source, /cancelButton\.dataset\.productDialogAction = 'cancel'/);
  assert.match(source, /confirmButton\.dataset\.productDialogAction = 'confirm'/);
  assert.match(source, /message\.textContent =/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/, 'product dialog must not render caller copy through HTML');
});

test('both search APIs enforce exact channelId scope before returning results', () => {
  const source = read('server/routes/search.ts');
  const exactDecls = source.match(/const exactChannelId = scalarQueryText\(req\.query\.channelId, MAX_SEARCH_ID_LENGTH\)/g) || [];
  const hiddenChecks = source.match(/exactChannelId && !visibleChannelSet\.has\(exactChannelId\)/g) || [];
  assert.ok(exactDecls.length >= 2, `expected exact channel scope in legacy + unified routes, found ${exactDecls.length}`);
  assert.ok(hiddenChecks.length >= 2, `expected permission-hiding exact channel checks in both routes, found ${hiddenChecks.length}`);
  assert.match(source, /const ftsChannelIds = exactChannelId \? \[exactChannelId\] : visibleChannelIds/);
  assert.match(source, /channelIds: exactChannelId \? \[exactChannelId\] : visibleChannelIds/);

  const regression = read('server/tests/search-channel-visibility.test.ts');
  assert.match(regression, /channelId/);
  assert.match(regression, /nonexistent|missing/i);
  assert.match(regression, /hidden/i);
  assert.match(regression, /400/);
});


test('DM and GDM optimistic sends have durable idempotent delivery contracts', () => {
  const dmPanel = read('client/js/core/DmPanel.svelte');
  const gdmPanel = read('client/js/core/GroupDmPanel.svelte');
  const handler = read('server/socket/handlers/dm.ts');
  const validate = read('server/middleware/validate.ts');
  const pgCollection = read('server/db/postgres/pgCollection.ts');
  const migration = read('server/db/migrations_pg/061_dm_delivery_idempotency.sql');
  const dmRepo = read('server/db/repositories/DmRepository.ts');
  const gdmRepo = read('server/db/repositories/GroupDmRepository.ts');

  for (const [name, panel, event] of [
    ['DM', dmPanel, 'dm:send'],
    ['GDM', gdmPanel, 'gdm:send'],
  ]) {
    assert.match(panel, /SEND_TIMEOUT_MS\s*=\s*10_000/, `${name} must expose a bounded acknowledgement timeout`);
    assert.match(panel, /clientNonce/, `${name} must attach a stable optimistic delivery key`);
    assert.match(panel, /scheduleSendTimeout\(message\.clientNonce\)/, `${name} retry must retain the same nonce`);
    assert.ok(panel.includes(`'${event}'`), `${name} must emit through the canonical socket event`);
    assert.match(panel, /Yeniden dene/, `${name} must render an explicit retry action`);
    assert.match(panel, /onSocketDisconnect/, `${name} must turn in-flight sends into retryable failures on transport loss`);
    assert.match(panel, /messageDeliveryError\(payload\.code, '(?:dm|gdm)'\)/, `${name} must map stable error codes instead of rendering server text`);
    assert.doesNotMatch(panel, /typeof payload\.(?:error|message) === 'string'/, `${name} must not reflect arbitrary socket error text into the UI`);
  }

  const deliveryCopy = read('client/js/core/message-delivery-error.ts');
  assert.match(deliveryCopy, /case 'RATE_LIMITED'/);
  assert.match(deliveryCopy, /case 'NONCE_CONFLICT'/);
  assert.match(deliveryCopy, /connectionLostDeliveryError/);

  assert.match(validate, /dmSend[\s\S]{0,500}clientNonce/);
  assert.match(validate, /gdmSend[\s\S]{0,500}clientNonce/);
  assert.match(dmRepo, /findByClientNonce\(userId: string, clientNonce: string\)/);
  assert.match(gdmRepo, /findByClientNonce\(userId: string, clientNonce: string\)/);
  assert.match(handler, /Dms\.findByClientNonce\(user\._id, clientNonce\)/);
  assert.match(handler, /GroupDms\.findByClientNonce\(user\._id, clientNonce\)/);
  assert.match(handler, /const \{ clientNonce: _privateNonce, \.\.\.publicMsg \} = msg/g);
  assert.doesNotMatch(handler, /io\.to\(`(?:dm|gdm):[^`]+`\)\.emit\([^\n]*clientNonce/, 'public room broadcasts must not expose private delivery nonces');
  assert.match(pgCollection, /clientNonce/);
  assert.match(migration, /idx_dm_messages_client_nonce/);
  assert.match(migration, /idx_gdm_messages_client_nonce/);
  assert.match(migration, /UNIQUE/);
});


test('P2P and SFU ICE configuration share the canonical TURN authority', () => {
  const turn = read('server/lib/turnConfig.ts');
  const health = read('server/routes/health.ts');
  const sfu = read('server/socket/handlers/mediasoup/index.ts');
  const env = read('server/.env.example');

  assert.match(turn, /function getRtcIceConfig\(/);
  assert.match(turn, /process\.env\.FORCE_TURN === 'true'/);
  assert.match(turn, /process\.env\.FORCE_RELAY === 'true'/);
  assert.match(turn, /requested && !hasTurn/);
  assert.match(health, /res\.json\(getRtcIceConfig\(userId\)\)/);
  assert.doesNotMatch(health, /const \{ TURN_URL, TURN_USERNAME, TURN_CREDENTIAL/,
    'ICE route must not duplicate static TURN env parsing');
  assert.match(sfu, /const iceConfig = getRtcIceConfig\(String\(user\._id\)\)/);
  assert.match(env, /FORCE_TURN=false/);
});


test('all live P2P call paths consume authenticated ICE policy before peer creation', () => {
  const voice = read('client/js/webrtc.ts');
  const dmCall = read('client/js/core/DmCallPanel.svelte');
  const gdmVoice = read('client/js/core/group-dm-voice.ts');

  assert.match(voice, /const iceConfigReady: Promise<void>/);
  assert.match(voice, /async joinVoice[\s\S]{0,700}await iceConfigReady/);
  assert.match(voice, /new RTCPeerConnection\(\{[\s\S]{0,180}iceTransportPolicy: ICE_SERVERS\.iceTransportPolicy/);

  assert.match(dmCall, /function ensureIceConfig\(\): Promise<void>/);
  assert.match(dmCall, /\/api\/rtc\/ice-config/);
  assert.match(dmCall, /await ensureIceConfig\(\);[\s\S]{0,120}new RTCPeerConnection\(ICE\)/);
  assert.match(dmCall, /iceTransportPolicy: raw\.iceTransportPolicy === 'relay' \? 'relay' : 'all'/);

  assert.match(gdmVoice, /async function loadIceConfig\(\): Promise<void>/);
  assert.match(gdmVoice, /await loadIceConfig\(\)/);
  assert.match(gdmVoice, /new RTCPeerConnection\(_iceConfig\)/);
});


test('release packager probes Info-ZIP unzip with its supported -v switch', () => {
  const source = read('scripts/package-release.js');
  assert.match(source, /function hasCommand\(command, versionArgs = \['--version'\]\)/);
  const unzipProbes = source.match(/hasCommand\('unzip', \['-v'\]\)/g) || [];
  assert.ok(unzipProbes.length >= 2, `expected unzip -v probes for integrity + extraction, found ${unzipProbes.length}`);
});

test('documented STUN separators and first-party release versions stay coherent', () => {
  const turn = read('server/lib/turnConfig.ts');
  const env = read('server/.env.example');
  assert.match(turn, /split\(\/\[,\\s\]\+\/\)/, 'STUN_URLS parser must accept comma and whitespace separators');
  assert.match(env, /STUN_URLS=.*stun:.*\s+stun:/, 'self-hosting example documents whitespace-separated STUN URLs');

  const version = JSON.parse(read('package.json')).version;
  assert.equal(version, '1.125.0');
  for (const file of ['server/package.json', 'mobile/package.json', 'bot-sdk/package.json', 'electron/package.json', 'e2e/package.json']) {
    assert.equal(JSON.parse(read(file)).version, version, `${file} version drifted from root release`);
  }
  for (const file of ['package-lock.json', 'server/package-lock.json', 'electron/package-lock.json', 'e2e/package-lock.json']) {
    const lock = JSON.parse(read(file));
    assert.equal(lock.version, version, `${file} top-level version drifted`);
    assert.equal(lock.packages?.['']?.version, version, `${file} root package version drifted`);
  }
  const rootLock = JSON.parse(read('package-lock.json'));
  assert.equal(rootLock.packages?.['bot-sdk']?.version, version);
  assert.equal(rootLock.packages?.mobile?.version, version);

  const unsignedWorkflow = read('.github/workflows/electron-windows-unsigned.yml');
  assert.match(unsignedWorkflow, /default:\s*'v1\.125\.0'/, 'manual unsigned release default drifted');
  assert.match(unsignedWorkflow, /EXPECTED_TAG="v\$\{PACKAGE_VERSION\}"/);
  assert.match(unsignedWorkflow, /Release tag\/version mismatch/);

  const releaseWorkflow = read('.github/workflows/electron-release.yml');
  assert.match(releaseWorkflow, /PACKAGE_VERSION=\$\(node -p "require\('\.\/package\.json'\)\.version"\)/);
  assert.match(releaseWorkflow, /GITHUB_REF_NAME/);
  assert.match(releaseWorkflow, /echo "version=\$\{EXPECTED_TAG\}" >> "\$\{GITHUB_OUTPUT\}"/);
  assert.doesNotMatch(releaseWorkflow, /GITHUB_REF#refs\/tags\//, 'manual dispatch must not derive a tag from a branch ref');
});

test('production database migration path is PostgreSQL-only, compiled and self-contained', () => {
  const serverPackage = JSON.parse(read('server/package.json'));
  assert.equal(serverPackage.scripts['db:migrate:pg'], 'node dist/db/migrate-postgres.js up');
  assert.equal(serverPackage.scripts['db:migrate:pg:status'], 'node dist/db/migrate-postgres.js status');
  assert.equal(serverPackage.scripts['db:migrate:pg:down'], 'node dist/db/migrate-postgres.js down');
  assert.equal(serverPackage.scripts['db:migrate:pg:rollback'], 'node dist/db/migrate-postgres.js rollback');
  assert.match(serverPackage.scripts.build, /copy-runtime-assets\.cjs/);
  assert.equal(serverPackage.scripts['db:migrate'], undefined, 'retired SQLite migration alias must not return');
  assert.equal(serverPackage.scripts['dev:js'], undefined, 'missing server/index.js runner must not return');

  assert.equal(fs.existsSync(path.join(ROOT, 'server/db/migrate.ts')), false, 'retired SQLite runner remains');
  assert.equal(fs.existsSync(path.join(ROOT, 'server/db/migrations')), false, 'retired SQLite migration directory remains');
  assert.equal(fs.existsSync(path.join(ROOT, 'server/tests/migrate-sqlite-runner.test.ts')), false, 'retired SQLite runner test remains');
  assert.equal(fs.existsSync(path.join(ROOT, 'server/migrations_pg')), false, 'duplicate migration re-export directory must not return');
  assert.match(read('server/db/postgres/migrations.ts'), /from '\.\.\/migrations_pg\/010_bot_marketplace_inline'/,
    'inline migration owner must import the canonical db/migrations_pg module directly');

  const copier = read('server/scripts/copy-runtime-assets.cjs');
  assert.match(copier, /migrations_pg/);
  assert.match(copier, /new Set\(\['\.sql', '\.json'\]\)/);
  assert.match(copier, /up\/down count mismatch/);
  assert.match(copier, /copy verification failed/);

  const loader = read('server/db/loader.ts');
  assert.match(loader, /DATABASE_URL/);
  assert.match(loader, /db\.missing_url/);
  assert.doesNotMatch(loader, /better-sqlite3/);

  const health = read('server/routes/health.ts');
  assert.match(health, /const DB_KIND = 'postgresql' as const/);
  assert.doesNotMatch(health, /DB_KIND = .*sqlite/);
});

test('v1.125 product preferences keep AI opt-in off by default and expose density controls', () => {
  const prefs = read('client/js/core/product-preferences.ts');
  const appearance = read('client/js/core/settings/tabs/AppearanceTab.svelte');
  const privacy = read('client/js/core/settings/tabs/PrivacyTab.svelte');
  assert.match(prefs, /AI_KEY\s*=\s*'bridge_ai_assistance'/);
  assert.match(prefs, /return storage\(\)\?\.getItem\(AI_KEY\) === 'enabled'/);
  assert.match(prefs, /bridge_ui_density/);
  assert.match(appearance, /t\(['"]appearance_content_density['"]/);
  assert.match(privacy, /AI/);
  assert.match(privacy, /\/api\/account\/export/);
  assert.match(privacy, /getAiAssistanceEnabled/);
});

test('composer exposes the canonical persisted scheduled-message backend with bounded validation', () => {
  const composer = read('client/js/core/MessageInputPanel.svelte');
  const html = read('client/index.html');
  const server = read('server/routes/scheduled.ts');
  assert.match(html, /id="btn-schedule-message"/);
  assert.match(composer, /\/api\/scheduled/);
  assert.match(composer, /30 \* 24 \* 60 \* 60_000/);
  assert.match(composer, /datetime-local/);
  assert.match(server, /router\.post\('\/'/);
  assert.match(server, /sendAt/);
});

test('search parser supports exact channel identity plus before/after date filters', () => {
  const client = read('client/js/core/search/unified-search-client.ts');
  const panel = read('client/js/core/GlobalSearchPanel.svelte');
  assert.match(client, /before\?: string/);
  assert.match(client, /after\?: string/);
  assert.match(client, /from\|in\|has\|after\|before/);
  assert.match(panel, /after:2026-09-01/);
  assert.match(panel, /before:2026-10-01/);
});

test('polls are production-reachable through a safe Svelte surface instead of the legacy HTML owner', () => {
  const app = read('client/js/app.ts');
  const coordinator = read('client/js/core/exclusive-surface.ts');
  const polls = read('client/js/core/PollsPanel.svelte');
  assert.match(app, /\.\/core\/polls-svelte\.ts/);
  assert.match(coordinator, /polls:\s*'closePolls'/);
  assert.match(polls, /openPolls/);
  assert.match(polls, /\/api\/channels\/\$\{encodeURIComponent\(channelId\)\}\/polls/);
  assert.doesNotMatch(polls, /\bconfirm\s*\(/);
  assert.doesNotMatch(polls, /innerHTML|\{@html/);
});

test('mobile shell tracks visualViewport and yields navigation to the virtual keyboard', () => {
  const mobile = read('client/js/mobile.ts');
  const css = read('client/css/modules/responsive-fixes.css');
  assert.match(mobile, /window\.visualViewport/);
  assert.match(mobile, /--bridge-visual-viewport-height/);
  assert.match(mobile, /bridge-keyboard-open/);
  assert.match(css, /html\.bridge-keyboard-open \.mobile-nav \{ display: none; \}/);
});

test('voice diagnostics reports TURN readiness without exposing relay credentials or URLs', () => {
  const voice = read('client/js/core/VoiceCheckPanel.svelte');
  assert.match(voice, /\/api\/rtc\/ice-config/);
  assert.match(voice, /t\(['"]voice_turn_config['"]/);
  assert.match(voice, /iceTransportPolicy/);
  assert.doesNotMatch(voice, /credential\}\}|username\}\}|urls\}\}/,
    'voice readiness UI must not render ICE credentials or URLs');
});

test('backup and restore workflow is checksum-backed and restore is explicitly gated', () => {
  const backup = read('backup/backup.sh');
  const verify = read('backup/verify-backup.sh');
  const restore = read('backup/restore.sh');
  assert.match(backup, /gzip -t "\$DUMP_FILE"/);
  // Final21 Faz 19: the sidecar must name the dump RELATIVELY — verify-backup.sh runs
  // `sha256sum -c` inside the dump's own directory, so an absolute path failed for every copied
  // or downloaded backup.
  assert.match(backup, /\(cd "\$BACKUP_DIR" && sha256sum "\$\(basename "\$DUMP_FILE"\)" > "\$\(basename "\$DUMP_FILE"\)\.sha256"\)/);
  assert.doesNotMatch(backup, /sha256sum "\$DUMP_FILE" >/);
  // CAP_CHOWN is dropped in production; preserving ownership made rsync exit 23 and abort the run.
  assert.match(backup, /rsync -a --no-owner --no-group --delete/);
  assert.match(verify, /BACKUP_VERIFY=PASS/);
  assert.match(verify, /sha256sum -c/);
  assert.match(restore, /BRIDGE_RESTORE_CONFIRM/);
  assert.match(restore, /RESTORE/);
  assert.match(restore, /ON_ERROR_STOP=1/);
  assert.match(restore, /BRIDGE_RESTORE_DRY_RUN/);
});

test('operator, permissions and desktop diagnostics have discoverable canonical entry points', () => {
  const palette = read('client/js/core/CommandPalettePanel.svelte');
  const channelMenu = read('client/js/core/channel-perms/ChannelActionMenu.svelte');
  const tray = read('electron/main.ts');
  const preload = read('electron/preload.ts');
  assert.match(palette, /id: 'server-health'/);
  assert.match(palette, /id: 'channel-permissions'/);
  assert.match(palette, /id: 'open-plugin-marketplace'/);
  assert.match(palette, /id: 'open-admin'/);
  assert.match(channelMenu, /openCurrentChannelPermissions/);
  assert.match(tray, /shellText\('voiceDiagnostics'\)/);
  assert.match(tray, /shellText\('systemStatus'\)/);
  assert.match(tray, /nativeText/);
  assert.match(preload, /tray:open-surface/);
});

test('channel edit/delete mutations require authoritative nonce-correlated server confirmation', () => {
  const composer = read('client/js/core/MessageInputPanel.svelte');
  const loader = read('client/js/core/MessageLoader.svelte');
  const handler = read('server/socket/handlers/messages-edit.ts');
  const owner = read('server/lib/messageMutations.ts');
  const validate = read('server/middleware/validate.ts');

  assert.match(composer, /message:edit'[\s\S]{0,220}clientNonce: nonce/);
  assert.match(composer, /pendingEdit[\s\S]{0,700}ACK_TIMEOUT_MS/);
  assert.match(composer, /resolveEditMutation/);
  assert.match(composer, /failEditMutation/);
  assert.match(composer, /message:delete'[\s\S]{0,220}clientNonce: nonce/);
  assert.match(composer, /pendingDeletes/);
  assert.match(composer, /resolveDeleteMutation/);
  assert.doesNotMatch(composer, /sock\.emit\('message:edit'[\s\S]{0,180}cancelEdit\(true\)/,
    'edit must not leave edit mode before the authoritative event');

  assert.match(loader, /message:edited'[\s\S]{0,450}resolveEditMutation/);
  assert.match(loader, /message:deleted'[\s\S]{0,1600}resolveDeleteMutation/);
  assert.match(loader, /error:message'[\s\S]{0,450}failEditMutation/);

  assert.match(validate, /editMessage[\s\S]{0,400}clientNonce/);
  assert.match(validate, /deleteMessage[\s\S]{0,300}clientNonce/);
  // Final21 Phase 16: the broadcasts moved into the shared owner; the socket handler must
  // still hand the client's nonce to it, and the owner must echo it.
  assert.match(handler, /deleteChannelMessage\(io, \{[^}]*clientNonce/);
  assert.match(handler, /editChannelMessage\(io, \{[^}]*clientNonce/);
  assert.match(owner, /message:deleted', \{ id: input\.messageId, clientNonce: input\.clientNonce \}/);
  assert.match(owner, /message:edited', \{ \.\.\.updated, clientNonce: input\.clientNonce \}/);
  assert.match(handler, /AUTOMOD_BLOCKED[\s\S]{0,220}clientNonce/);
});

test('pin and reaction production clients send retry-safe target state while server preserves legacy toggle compatibility', () => {
  const list = read('client/js/core/MessageListPanel.svelte');
  const pins = read('client/js/core/PinnedMessagesPanel.svelte');
  const voice = read('client/js/core/VoicePanel.svelte');
  const handler = read('server/socket/handlers/messages-edit.ts');
  const repo = read('server/db/repositories/MessageRepository.ts');
  const validate = read('server/middleware/validate.ts');

  assert.match(list, /message:pin'[\s\S]{0,220}pinned: !Boolean\(m\.pinned\)/);
  // `currentUserId` is `string | null` in the panel; the desired-state payload
  // stays retry-safe with the null-safe form (an absent viewer can never be in
  // `users`, so `active` correctly reads as "add my reaction").
  assert.match(list, /message:react'[\s\S]{0,260}active: !users\.includes\(currentUserId \?\? ''\)/);
  assert.match(pins, /message:pin'[\s\S]{0,180}pinned: false/);
  assert.doesNotMatch(pins, /pins\s*=\s*pins\.filter/, 'pinned viewer must wait for server confirmation');
  assert.match(voice, /message:pin'[\s\S]{0,180}pinned: true/);

  assert.match(validate, /pinMessage[\s\S]{0,350}pinned/);
  assert.match(validate, /reactMessage[\s\S]{0,350}active/);
  assert.match(handler, /typeof desiredPinned === 'boolean' \? desiredPinned : !msg\.pinned/);
  assert.match(handler, /typeof desiredActive === 'boolean'[\s\S]{0,220}setReactionStateAtomic/);
  assert.match(repo, /async setReactionStateAtomic\(/);
  assert.match(repo, /WHEN \$4::boolean/);
});

test('unified search honors URL date filters and exposes bounded permission-safe pagination', () => {
  const client = read('client/js/core/search/unified-search-client.ts');
  const panel = read('client/js/core/GlobalSearchPanel.svelte');
  const server = read('server/routes/search.ts');

  assert.match(client, /offset\?: number/);
  assert.match(client, /params\.set\('offset', String\(options\.offset\)\)/);
  assert.match(panel, /offset: append \? hits\.length : 0/);
  assert.match(panel, /Daha fazla sonuç yükle/);
  assert.match(panel, /res\.hits\.filter\(hit => !seen\.has\(hitKey\(hit\)\)\)/,
    'append path must deduplicate a boundary replay');

  assert.match(server, /router\.get\('\/unified'[\s\S]{0,700}parseNonNegativeSafeIntQuery\(req\.query\.offset, 0\)/);
  assert.match(server, /offset > 199/);
  assert.match(server, /req\.query\.before[\s\S]{0,100}modifiers\.before/);
  assert.match(server, /req\.query\.after[\s\S]{0,100}modifiers\.after/);
  assert.match(server, /if \(modifiers\.before\)[\s\S]{0,260}createdAt/);
  assert.match(server, /if \(modifiers\.after\)[\s\S]{0,260}createdAt/);
  assert.match(server, /filtered\.slice\(offset, offset \+ PAGE\)/);
  assert.match(server, /hasMore: filtered\.length > offset \+ PAGE/);
});

test('notification delivery resolves channel-to-server inheritance including timed mute expiry', () => {
  const mute = read('server/lib/notificationMute.ts');
  const delivery = read('server/lib/notifications.ts');
  const send = read('server/socket/handlers/messages-send.ts');
  const route = read('server/routes/notificationPrefs.ts');
  const client = read('client/js/core/notifications/notification-prefs-client.ts');
  const panel = read('client/js/core/NotificationPrefsPanel.svelte');

  assert.match(mute, /export function effectiveNotificationPref\(/);
  assert.match(mute, /channelLevel[\s\S]{0,180}serverLevel[\s\S]{0,180}level: 'all'/,
    'effective policy must be channel -> server -> all');
  assert.match(mute, /level === 'mute' && isMuteExpired\(pref, now\)[\s\S]{0,80}return 'default'/,
    'expired snooze must fall through to inheritance');

  assert.match(delivery, /channelId: \{ \$in: \[String\(msg\.channelId\), `server:\$\{canonicalServerId\}`\] \}/);
  assert.match(delivery, /effectiveNotificationPref\(channelPrefMap\.get\(userId\), serverPrefMap\.get\(userId\)\)/);
  assert.match(delivery, /directMentionIds\.includes\(userId\)/,
    'mentions-only must recognize stable-id mentions, not only usernames');

  assert.match(send, /findServerPref\(replyTargetUserId, serverId\)/);
  assert.match(send, /findServerPref\(uid, serverId\)/);
  assert.match(route, /effectiveNotificationPref\([\s\S]{0,120}prefByKey\.get\(`server:\$\{serverId\}`\)/,
    'unread badge must use the same inherited mute decision');

  assert.match(route, /serverMuteUntil: serverPref\?\.muteUntil \?\? null/);
  assert.match(route, /level === 'mute' \? \(muteUntil \?\? null\) : null/);
  assert.match(client, /serverMuteUntil: number \| null/);
  assert.match(client, /saveServerLevel\([\s\S]{0,260}muteUntil/);
  assert.match(panel, /setServerLevel\('mute', snoozeUntil\(option\)\)/);
});

test('web push settings use real VAPID subscription with false-success rollback and device attention policy', () => {
  const tab = read('client/js/core/settings/tabs/NotificationsTab.svelte');
  const push = read('client/js/core/notifications/web-push-client.ts');
  const device = read('client/js/core/notifications/notification-device-policy.ts');
  const sw = read('client/sw.ts');
  const route = read('server/routes/webpush.ts');

  assert.match(tab, /enableWebPush/);
  assert.match(tab, /disableWebPush/);
  assert.match(tab, /sendTestWebPush/);
  // The DND control is present and localized. (Its aria-label used to be the hardcoded
  // Turkish "Rahatsız Etmeyin'i …" in every locale; Final21 Phase 14 moved it to keys.)
  assert.match(tab, /t\("dnd_title"\)/);
  assert.match(tab, /aria-label=\{policy\.dnd \? t\("notif_dnd_turn_off"\) : t\("notif_dnd_turn_on"\)\}/);
  assert.match(tab, /onclick=\{\(\) => setDnd\(!policy\.dnd\)\}/);
  assert.match(tab, /Sessiz Saatler/);
  assert.doesNotMatch(tab, /henüz kullanıma açık değil/);

  assert.match(push, /\/api\/webpush\/vapid-public-key/);
  assert.match(push, /pushManager\.subscribe\(/);
  assert.match(push, /applicationServerKey/);
  assert.match(push, /if \(created\)[\s\S]{0,120}subscription\.unsubscribe\(\)/,
    'new local subscription must roll back if server persistence fails');
  assert.match(push, /SERVER_SYNC_KEY/,
    'UI subscription truth must include server persistence, not only PushManager state');

  assert.match(device, /bridge_notification_device_policy_v1/);
  assert.match(device, /start < end \? current >= start && current < end : current >= start \|\| current < end/,
    'quiet hours must handle ranges crossing midnight');
  assert.match(sw, /bridge-notification-policy/);
  assert.match(sw, /shouldSuppressNotification\(isCall\)/);
  assert.match(sw, /if \(policy\.dnd\) return true/);
  assert.match(sw, /return !isCall && quietHoursActive\(policy\)/,
    'quiet hours suppress normal notifications while leaving calls available');
  assert.match(sw, /SET_NOTIFICATION_POLICY/);

  assert.match(route, /findPushSubscriptionForUserEndpoint\(_u\.id, endpoint\)/);
  assert.match(route, /sameSubscription[\s\S]{0,100}persistedKeys\?\.p256dh === keys\.p256dh/);
  assert.match(route, /return res\.status\(409\)/,
    'endpoint alone must not be sufficient to steal another account subscription');
});

test('threads are production-reachable through the safe Svelte owner with retry-idempotent delivery', () => {
  const app = read('client/js/app.ts');
  const panel = read('client/js/core/ThreadPanel.svelte');
  const renderer = read('client/js/core/MessageRenderer.svelte');
  const list = read('client/js/core/MessageListPanel.svelte');
  const route = read('server/routes/threads.ts');
  const repo = read('server/db/repositories/ThreadRepository.ts');
  const migration = read('server/db/migrations_pg/062_thread_message_delivery_idempotency.sql');

  assert.match(app, /\.\/core\/thread-svelte\.ts/);
  assert.match(panel, /BridgeRegistry\.register\('openThread', open\)/);
  assert.match(panel, /body: JSON\.stringify\(\{ content, clientNonce: retryNonce \}\)/);
  assert.match(panel, /bridge:thread-draft:\$\{currentUserId\(\)\}:\$\{threadId\}/);
  assert.match(panel, /t\(['"`]surface_daha_eski_yan_tlar_yukle_454e5e['"`]/,
    'thread pagination copy must stay behind the canonical i18n key');
  assert.match(panel, /thread:message:new/);
  assert.doesNotMatch(panel, /innerHTML|\{@html|\bconfirm\s*\(/);
  assert.match(renderer, /onThread\?:/);
  assert.match(renderer, /Thread aç/);
  assert.match(list, /openThread/);

  assert.match(route, /clientNonce\.length < 8 \|\| clientNonce\.length > 128/);
  assert.match(route, /insertMessageIdempotent/);
  const duplicateReturn = route.indexOf('if (!inserted.created) return res.status(200).json(msg);');
  const recordReply = route.indexOf('await Threads.recordReply');
  assert.ok(duplicateReturn >= 0 && recordReply > duplicateReturn,
    'duplicate retry must return before counters/notifications/realtime side effects');
  assert.match(repo, /async insertMessageIdempotent\(/);
  assert.match(repo, /findMessageByClientNonce/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS/);
  assert.match(migration, /"threadId", "userId", "clientNonce"/);
});

test('message edit history is safe, accessible and protected by READ_HISTORY', () => {
  const route = read('server/routes/messages.ts');
  const renderer = read('client/js/core/MessageRenderer.svelte');

  const historyRoute = route.slice(route.indexOf("router.get('/:id/history'"), route.indexOf("router.post('/:id/react'"));
  assert.match(historyRoute, /requireChannelVisible/);
  assert.match(historyRoute, /resolvePermissions/);
  assert.match(historyRoute, /PERMS\.READ_HISTORY/);
  assert.match(historyRoute, /status\(403\)/);

  assert.match(renderer, /\/api\/messages\/\$\{encodeURIComponent\(message\._id\)\}\/history/);
  assert.match(renderer, /openEditHistory/);
  assert.match(renderer, /closeEditHistory/);
  assert.match(renderer, /historyOpen/);
  assert.match(renderer, /focusTrap/);
  assert.match(renderer, /Düzenleme geçmişi/);
  assert.doesNotMatch(renderer, /historyEntries[\s\S]{0,120}innerHTML|\{@html/);
  assert.doesNotMatch(renderer, /historyError\s*=\s*[^;]*\.message/,
    'backend/exception message must not be reflected into the user-facing history dialog');
});

test('composer manages pending scheduled messages without false-success cancellation', () => {
  const composer = read('client/js/core/MessageInputPanel.svelte');
  const server = read('server/routes/scheduled.ts');

  assert.match(composer, /loadScheduledForCurrentChannel/);
  assert.match(composer, /apiFetch\('\/api\/scheduled'\)/);
  assert.match(composer, /row\.channelId === channelId/,
    'composer manager must scope the visible list to the active channel');
  assert.match(composer, /apiFetch\(`\/api\/scheduled\/\$\{encodeURIComponent\(id\)\}`[\s\S]{0,100}method: 'DELETE'/);
  assert.match(composer, /response\.status === 409[\s\S]{0,140}iptal artık uygulanamadı/,
    'dispatching messages must not be shown as successfully cancelled');
  assert.match(composer, /response\.ok \|\| response\.status === 404/);
  assert.match(composer, /Bekleyenler/);
  assert.match(composer, /t\(['"]schedule_empty['"]/);
  assert.doesNotMatch(composer, /cancelScheduled[\s\S]{0,500}\bconfirm\s*\(/);

  assert.match(server, /router\.get\('\/'/);
  assert.match(server, /cancelPending\(id, _u\.id\)/);
  assert.match(server, /result === 'dispatching'[\s\S]{0,120}status\(409\)/);
});

test('saved searches persist only user-scoped canonical query text and always re-run authoritative search', () => {
  const panel = read('client/js/core/GlobalSearchPanel.svelte');
  const saved = read('client/js/core/search/saved-searches.ts');

  assert.match(saved, /bridge:saved-searches:\$\{safe\}/);
  assert.match(saved, /JSON\.stringify\(normalizeSaved\(list\)\)/);
  assert.match(saved, /type StorageLike = Pick<Storage, 'getItem' \| 'setItem'>/);
  assert.match(saved, /store\.setItem\(key\(userId\), JSON\.stringify\(normalizeSaved\(list\)\)\)/);
  assert.doesNotMatch(saved, /interface\s+SearchHit|messageId\s*:|channelId\s*:/,
    'saved search storage model must not include result/resource fields');
  assert.match(panel, /saved = loadSaved\(savedUserId\)/);
  assert.match(panel, /canonicalSavedQuery/);
  assert.match(panel, /if \(lockedChannelId\) return ''/,
    'structurally locked channel searches must not be persisted as ambiguous display-name shortcuts');
  assert.match(panel, /saveCurrentSearch/);
  assert.match(panel, /useSaved\(value/);
  assert.match(panel, /query = value/);
  assert.match(panel, /fetchUnifiedSearch/,
    'using a saved search must go through the normal server-authoritative search path');
  assert.match(panel, /Kaydedilen aramalar/);
  assert.doesNotMatch(panel, /const channelId[\s\S]{0,120}const channelId/,
    'channel search registration must not redeclare its channel id binding');
});

test('voice peer volume is device-local and applies to microphone plus screen-share audio', () => {
  const voice = read('client/js/core/VoicePanel.svelte');
  assert.match(voice, /PEER_VOLUME_PREFIX\s*=\s*'bridge:voice-peer-volume:'/);
  assert.match(voice, /localStorage\.setItem\(`\$\{PEER_VOLUME_PREFIX\}\$\{userId\}`/);
  assert.match(voice, /baseAudioSocketId\(key: string\)/);
  assert.match(voice, /::screen-audio/);
  assert.match(voice, /volume=\{playbackVolumeForSocket\(socketId\)\}/);
  assert.match(voice, /type="range"[\s\S]{0,300}max="100"/);
  assert.doesNotMatch(voice, /emit\([^\n]{0,120}volume/i, 'peer playback volume must not be synchronized to the server');
});

test('message reports are durable, permission-scoped, duplicate-safe and idempotently resolved', () => {
  const migration = read('server/db/migrations_pg/063_message_reports.sql');
  const repo = read('server/db/repositories/MessageReportRepository.ts');
  const messages = read('server/routes/messages.ts');
  const moderation = read('server/routes/moderation.ts');
  const renderer = read('client/js/core/MessageRenderer.svelte');
  const modUi = read('client/js/core/server-settings/tabs/ModerationTab.svelte');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS message_reports/);
  assert.match(migration, /WHERE status = 'open'/);
  assert.match(repo, /findOne\(\{ reporterId: input\.reporterId, messageId: input\.messageId, status: 'open' \}\)/);
  assert.match(repo, /resolveTargetState/);
  assert.match(repo, /status: 'open'/);

  assert.match(messages, /router\.post\('\/:id\/report'/);
  assert.match(messages, /PERMS\.READ_HISTORY/);
  assert.match(messages, /Message not available/);
  assert.match(messages, /MessageReports\.create/);

  assert.match(moderation, /router\.get\('\/reports'/);
  assert.match(moderation, /resolveEffectivePermissions\(_u\.id, serverId, channelId\)/);
  assert.match(moderation, /PERMS\.MANAGE_MESSAGES/);
  assert.match(moderation, /router\.put\('\/reports\/:reportId'/);
  assert.match(moderation, /result\.kind === 'updated'/);

  assert.match(renderer, /Mesajı raporla/);
  assert.match(renderer, /maxlength="500"/);
  assert.match(modUi, /t\(['"]moderation_message_reports['"]/);
  assert.match(modUi, /t\(['"]pin_jump['"]/);
  assert.match(modUi, /resolveReport\(report, 'dismissed'\)/);
  assert.match(modUi, /resolveReport\(report, 'resolved'\)/);
});


test('saved-message reminders are durable, authorization-aware and inbox-first', () => {
  const migration = read('server/db/migrations_pg/064_saved_message_reminders.sql');
  const savedRepo = read('server/db/repositories/SavedMessageRepository.ts');
  const notifRepo = read('server/db/repositories/NotificationRepository.ts');
  const savedRoute = read('server/routes/saved.ts');
  const inboxRoute = read('server/routes/inbox.ts');
  const reminderJob = read('server/jobs/savedMessageReminders.ts');
  const serverRuntime = read('server/runtime.ts');
  const savedPanel = read('client/js/core/SavedPanel.svelte');
  const inboxPanel = read('client/js/core/InboxPanel.svelte');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "remindAt" BIGINT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "remindedAt" BIGINT/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS[\s\S]{0,220}"remindAt"[\s\S]{0,180}"remindedAt" IS NULL/);

  assert.match(savedRepo, /findDueReminders\(/);
  assert.match(savedRepo, /markReminded\(id: string, remindAt: number, deliveredAt: number\)/);
  assert.match(savedRepo, /remindAt, remindedAt: null/);
  assert.match(notifRepo, /insertSavedReminder/);
  assert.match(notifRepo, /inbox:saved-reminder:\$\{userId\}:\$\{savedId\}:\$\{remindAt\}/);

  const insertAt = reminderJob.indexOf('insertSavedReminder');
  const markAt = reminderJob.indexOf('markReminded');
  const pushAt = reminderJob.indexOf('void sendPushToUser');
  assert.ok(insertAt >= 0 && markAt > insertAt && pushAt > markAt,
    'durable Inbox notification must be canonical before completion/push side effects');
  assert.match(reminderJob, /findDueReminders\(now/);
  assert.match(reminderJob, /startSavedMessageReminderJob/);
  assert.match(serverRuntime, /startSavedMessageReminderJob\(\)/);
  assert.match(serverRuntime, /stopSavedMessageReminderJob\(\)/);

  const reminderRoute = savedRoute.slice(savedRoute.indexOf("router.put('/:id/reminder'"));
  assert.match(reminderRoute, /authorizeTarget\(user\.id, type, targetId, messageId\)/,
    'setting a new reminder must re-check current target authorization');
  assert.match(reminderRoute, /remindAt === null/,
    'clearing an existing reminder must remain possible even if content later becomes unavailable');
  assert.match(reminderRoute, /5_000/);
  assert.match(reminderRoute, /30 \* 24 \* 60 \* 60_000/);

  assert.match(inboxRoute, /findUnreadSavedReminders/);
  assert.match(inboxRoute, /kind: 'reminder'/);
  assert.match(inboxRoute, /type: 'saved'/);
  assert.match(inboxRoute, /markSavedReminderRead/);
  assert.match(inboxRoute, /markAllSavedRemindersRead/);

  assert.match(savedPanel, /promptProductText/);
  assert.match(savedPanel, /\/api\/saved\/\$\{encodeURIComponent\(item\.id\)\}\/reminder/);
  assert.match(savedPanel, /Hatırlatıcı kur/);
  assert.doesNotMatch(savedPanel, /setTimeout\([\s\S]{0,250}remind/i,
    'Saved reminder UX must not rely on a tab-lifetime timer');
  assert.match(inboxPanel, /t\(['"]reminders['"]/);
  assert.match(inboxPanel, /showSaved/);
});

test('channel, DM and GDM composers share the bounded user-scoped durable draft owner', () => {
  const store = read('client/js/core/draft-store.ts');
  const channel = read('client/js/core/MessageInputPanel.svelte');
  const dm = read('client/js/core/DmPanel.svelte');
  const gdm = read('client/js/core/GroupDmPanel.svelte');

  assert.match(store, /DRAFT_KEY_PREFIX = 'bridge:draft:v2'/);
  assert.match(store, /MAX_DRAFTS_PER_USER = 50/);
  assert.match(store, /MAX_DRAFT_AGE_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(store, /kind: ConversationKind/);
  assert.match(channel, /DraftManager/);

  assert.match(dm, /readDraft, writeDraft, clearDraft/);
  assert.match(dm, /kind: 'dm'/);
  assert.match(dm, /persistDmDraft\(e\.currentTarget\.value\)/);
  assert.match(dm, /draft = restoreDmDraft\(conversation\)/);
  assert.match(dm, /clearDraft\(dmDraftIdentity\(active\)\)/);

  assert.match(gdm, /readDraft, writeDraft, clearDraft/);
  assert.match(gdm, /kind: 'gdm'/);
  assert.match(gdm, /persistGdmDraft\(e\.currentTarget\.value\)/);
  assert.match(gdm, /inputValue = restoreGdmDraft\(normalizedGroup\)/);
  assert.match(gdm, /clearDraft\(gdmDraftIdentity\(currentGroup\)\)/);
});

test('server link previews are production-visible as privacy-safe text cards', () => {
  const send = read('server/socket/handlers/messages-send.ts');
  const loader = read('client/js/core/MessageLoader.svelte');
  const renderer = read('client/js/core/MessageRenderer.svelte');

  assert.match(send, /fetchLinkPreview/);
  assert.match(send, /message:embedUpdate/);
  assert.match(loader, /message:embedUpdate/);
  assert.match(loader, /embeds: payload\.embeds \?\? \[\]/);
  assert.match(renderer, /const linkEmbeds = \$derived\.by/);
  assert.match(renderer, /class="msg-link-preview"/);
  assert.match(renderer, /rel="noopener noreferrer"/);
  assert.match(renderer, /safeUrl\(/);
  assert.doesNotMatch(renderer, /embed\.image[^\n]{0,180}<img|<img[^\n]{0,180}embed\.image/,
    'remote preview images must not silently expose the user IP to third-party origins');
  assert.doesNotMatch(renderer, /\{@html[^}]*embed/);
});

test('mobile DM and GDM use list-to-conversation navigation without squeezing chat beside sidebars', () => {
  const dm = read('client/js/core/DmPanel.svelte');
  const gdm = read('client/js/core/GroupDmPanel.svelte');

  assert.match(dm, /class:conversation-open=\{Boolean\(active\)\}/);
  assert.match(dm, /class="dm-mobile-back"/);
  assert.match(dm, /function backToDmList\(\)/);
  assert.match(dm, /@media\(max-width:700px\)/);
  assert.match(dm, /\.dm-panel\.conversation-open \.dm-sidebar\{display:none\}/);
  assert.match(dm, /--bridge-visual-viewport-height/);

  assert.match(gdm, /class:conversation-open=\{Boolean\(currentGroup\)\}/);
  assert.match(gdm, /class="gdm-mobile-back"/);
  assert.match(gdm, /function backToGroupList\(\)/);
  assert.match(gdm, /@media \(max-width: 700px\)/);
  assert.match(gdm, /\.gdm-panel\.conversation-open \.gdm-sidebar \{ display: none; \}/);
  assert.match(gdm, /--bridge-visual-viewport-height/);
});

test('first-unread navigation uses a durable monotonic read cursor instead of notification counts', () => {
  const schema = read('server/db/postgres/schema.ts');
  const migration = read('server/db/migrations_pg/065_channel_read_positions.sql');
  const notifications = read('server/db/repositories/NotificationRepository.ts');
  const messagesRepo = read('server/db/repositories/MessageRepository.ts');
  const route = read('server/routes/messages.ts');
  const app = read('client/js/core/AppState.svelte');
  const loader = read('client/js/core/MessageLoader.svelte');
  const list = read('client/js/core/MessageListPanel.svelte');
  const lifecycle = read('server/lib/accountLifecycle.ts');

  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS channel_read_positions/);
    assert.match(source, /PRIMARY KEY \("userId", "channelId"\)/);
    assert.match(source, /"lastReadAt" BIGINT NOT NULL/);
    assert.match(source, /"lastReadMessageId" TEXT NOT NULL/);
  }
  assert.match(notifications, /advanceChannelReadPosition/);
  assert.match(notifications, /ON CONFLICT \("userId", "channelId"\) DO UPDATE/);
  assert.match(notifications, /WHERE \(EXCLUDED\."lastReadAt", EXCLUDED\."lastReadMessageId"\) >=/,
    'cross-tab retries must not move the read cursor backwards');
  assert.match(messagesRepo, /findFirstUnreadAfter/);
  // Final21 Faz 8 (F21-8-03): okuyucu filtresi sorgudan SINIRLI tarama
  // penceresine tasindi (1M satirda 18.8 sn -> 19 ms). Bu iddia eskiden
  // `userId: { $ne: userId }` dizgesini ariyordu. Niyet aynen korunur ve
  // SIKILASTIRILIR: HER IKI yol da (PostgreSQL ve koleksiyon) cagiranin kendi
  // mesajlarini ayrac adayi saymaz; davranis ayrica
  // server/tests/pg-integration/first-unread-scan-window.pgtest.ts ve
  // server/tests/message-repository-behavior.test.ts ile olculur.
  assert.match(messagesRepo, /WHERE w\."userId" <> \$5/,
    'the first-unread divider must not treat the caller\'s own messages as unread (PostgreSQL path)');
  assert.match(messagesRepo, /row\?\.userId !== userId/,
    'the first-unread divider must not treat the caller\'s own messages as unread (collection path)');

  assert.match(route, /X-Bridge-First-Unread-Id/);
  assert.match(route, /if \(!row\) return null;[^\n]*First visit establishes a baseline/,
    'first-ever channel visit must not mark the entire history as unread');
  assert.match(route, /const readAnchor = isFirstPage \? await getReadAnchor/);
  assert.doesNotMatch(route, /const response = \{[^}]*firstUnread/s,
    'user-specific read metadata must not enter the shared first-page cache body');

  assert.match(app, /getFirstUnreadMessageId/);
  assert.match(loader, /response\.headers\.get\('X-Bridge-First-Unread-Id'\)/);
  assert.match(list, /class="first-unread-divider"/);
  assert.match(list, /jumpToFirstUnread/);
  assert.match(list, /page < 10/,
    'loading toward a very old boundary must be bounded per interaction');
  assert.match(lifecycle, /channel_read_positions[\s\S]{0,120}disposition: 'DELETE'/,
    'read-position personal data must participate in account deletion');
});

test('all production message mutations invalidate every cached first-page variant without Redis KEYS', () => {
  const cacheOwner = read('server/lib/messageCache.ts');
  const redis = read('server/lib/redisAdapter.ts');
  const send = read('server/socket/handlers/messages-send.ts');
  const edit = read('server/socket/handlers/messages-edit.ts');
  const plugins = read('server/plugins/actions.ts');
  const activity = read('server/lib/channelActivity.ts');

  assert.match(cacheOwner, /channelMessagesCachePrefix/);
  assert.match(cacheOwner, /cache\.invalidatePattern\(channelMessagesCachePrefix\(channelId\)\)/);

  assert.match(send, /await invalidateChannelMessages\(String\(channelId\)\)/);

  // Phase 15 moved every persisted-message fan-out onto one publisher. The
  // guarantee is unchanged — a bridge-forwarded message must not leave a stale
  // first page behind in the TARGET channel — but it is now owned by
  // `publishPersistedMessage` instead of being repeated at each call site, so
  // the contract is asserted where the ordering actually lives.
  assert.match(send, /channelId: bridge\.targetChannelId[\s\S]{0,1200}?await publishPersistedMessage\(io, bMsg\)/,
    'bridge-forwarded messages must go through the canonical persisted-message publisher');
  assert.match(
    activity,
    /export async function publishPersistedMessage[\s\S]*?await invalidateChannelMessages\(channelId\);\s*\n\s*broadcastPersistedMessage\(io, message\);/,
    'the canonical publisher must invalidate the channel cache BEFORE broadcasting, '
    + 'or a client that refetches on the broadcast can be served the stale page');

  // Pin and reaction stay in the socket handler; edit and delete moved to ONE owner shared with
  // the HTTP routes (Final21 Phase 16 — the HTTP copies had skipped the cache and the broadcast).
  const editInvalidations = edit.match(/invalidateChannelMessages\(/g) ?? [];
  assert.ok(editInvalidations.length >= 2, 'pin and reaction must invalidate the canonical channel message cache');
  const owner = read('server/lib/messageMutations.ts');
  assert.match(owner, /await invalidateChannelMessages\(channelId\);\s*\n\s*io\?\.to\(`channel:\$\{channelId\}`\)\.emit\('message:edited'/,
    'an edit must invalidate the cached page BEFORE announcing it');
  assert.match(owner, /await invalidateChannelMessages\(channelId\);\s*\n\s*io\?\.to\(`channel:\$\{channelId\}`\)\.emit\('message:deleted'/,
    'a delete must invalidate the cached page BEFORE announcing it, or a refetching client resurrects the message');
  const routes = read('server/routes/messages.ts');
  assert.match(routes, /await deleteChannelMessage\(req\.app\.get\('io'\)/, 'HTTP delete must use the shared owner');
  assert.match(routes, /await editChannelMessage\(req\.app\.get\('io'\)/, 'HTTP edit must use the shared owner');
  assert.doesNotMatch(routes, /Messages\.softDelete\(/, 'HTTP delete must not keep its own weaker deletion');
  assert.doesNotMatch(edit, /messages:\$\{channelId\}:first:(?:50|100)/,
    'edit handlers must not hard-code only two cached page sizes');

  assert.match(plugins, /const saved = await Messages\.create\(msg\);\s*\n\s*await publishPersistedMessage\(state\.io, saved\);/,
    'plugin-sent messages must go through the canonical persisted-message publisher');
  assert.match(plugins, /await invalidateChannelMessages\(canonicalChannelId\);\s*\n\s*state\.io\.to\(`channel:\$\{canonicalChannelId\}`\)\.emit\('message:deleted'/,
    'a plugin delete must invalidate the cached page BEFORE announcing the delete');

  assert.match(redis, /client\.scan\(cursor, \{ MATCH: pattern, COUNT: 100 \}\)/,
    'hot-path cache invalidation must incrementally scan Redis');
  const invalidateBlock = redis.match(/async invalidatePattern\(prefix: string\)[\s\S]*?\n  },/)?.[0] ?? '';
  assert.doesNotMatch(invalidateBlock, /client\.keys\(/,
    'ordinary message mutation must never block Redis with KEYS');
});

test('attachment UX keeps honest upload state, explicit retry and an accessible protected-media image viewer', () => {
  const composer = read('client/js/core/MessageInputPanel.svelte');
  const renderer = read('client/js/core/MessageRenderer.svelte');

  assert.match(composer, /fetch[^\n]*upload|apiFetch\(`\$\{apiBase\(\)\}\/api\/upload`/);
  assert.match(composer, /ILerleme|ILERLEME|İLERLEME|YUKLEME ilerlemesini|Yükleniyor/i,
    'fetch upload must remain indeterminate instead of fabricating a percentage');
  assert.match(composer, /function retryAttachment\(\)/);
  assert.match(composer, /class="attach-retry"/);
  assert.match(composer, /attachError && attachment && !uploading/,
    'a failed byte upload must preserve a user-controlled retry path');

  assert.match(renderer, /let imageViewerOpen = \$state\(false\)/);
  assert.match(renderer, /class="image-viewer-dialog"/);
  assert.match(renderer, /role="dialog"/);
  assert.match(renderer, /aria-modal="true"/);
  assert.match(renderer, /use:focusTrap=\{\{ active: imageViewerOpen/);
  assert.match(renderer, /queueMicrotask\(\(\) => imageViewerTrigger\?\.focus\(\)\)/,
    'closing the image viewer must return focus to the originating thumbnail');
  assert.match(renderer, /onclick=\{openProtectedFile\}>\{t\(['"]action_open_new_tab['"]/);
  assert.match(renderer, /function retryProtectedMedia\(\)/);
  assert.match(renderer, /mediaRetryCount = 0/);
  assert.doesNotMatch(renderer, /\{@html[^}]*file|\{@html[^}]*image/);
});

test('server-scoped watch words are literal, permission-aware, mute-respecting and lifecycle-owned', () => {
  const helper = read('server/lib/notificationWatchWords.ts');
  const schema = read('server/db/postgres/schema.ts');
  const migration = read('server/db/migrations_pg/066_notification_watch_words.sql');
  const pgCollection = read('server/db/postgres/pgCollection.ts');
  const repo = read('server/db/repositories/NotificationRepository.ts');
  const route = read('server/routes/notificationPrefs.ts');
  const delivery = read('server/lib/notifications.ts');
  const client = read('client/js/core/notifications/notification-prefs-client.ts');
  const panel = read('client/js/core/NotificationPrefsPanel.svelte');
  const lifecycle = read('server/lib/accountLifecycle.ts');
  const account = read('server/routes/account.ts');

  assert.match(helper, /MAX_NOTIFICATION_WATCH_WORDS = 10/);
  assert.match(helper, /WATCH_WORD_RE = \/\^\[\\p\{L\}\\p\{N\}_-\]\{2,32\}\$\/u/);
  assert.match(helper, /normalize\('NFKC'\)/);
  assert.match(helper, /MAX_MESSAGE_WATCH_TOKENS = 128/,
    'message token work must be bounded before matching user preferences');

  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS notification_keywords/);
    assert.match(source, /PRIMARY KEY \("userId", "serverId", keyword\)/);
    assert.match(source, /CREATE INDEX IF NOT EXISTS idx_notification_keywords_match[\s\S]{0,120}\("serverId", keyword\)/);
  }
  assert.match(pgCollection, /notification_keywords: \['userId', 'serverId', 'keyword'\]/);
  assert.match(repo, /findMatchingWatchWords\(serverId: string, words: string\[\]\)/);
  assert.match(repo, /replaceWatchWords\(userId: string, serverId: string, words: string\[\]/);
  assert.match(repo, /WITH removed AS[\s\S]{0,300}DELETE FROM notification_keywords[\s\S]{0,300}INSERT INTO notification_keywords/,
    'PostgreSQL watch-word replacement must be atomic rather than delete-then-crash partial state');

  const keywordRoute = route.slice(route.indexOf("router.put('/keywords'"), route.indexOf('// ── PUT /api/notification-prefs (channel level)'));
  assert.match(keywordRoute, /normalizeNotificationWatchWords\(keywords\)/);
  assert.match(keywordRoute, /Members\.findOne\(user\.id, serverId\)/,
    'watch words must only be configurable for the caller\'s current server membership');
  assert.match(keywordRoute, /replaceWatchWords\(user\.id, serverId, normalized\)/);
  assert.match(keywordRoute, /watchWords: normalized/);

  assert.match(delivery, /extractNotificationWatchTokens\(content\)/);
  assert.match(delivery, /findMatchingWatchWords\(canonicalServerId, watchTokens\)/);
  assert.match(delivery, /memberUserIds\.has\(userId\)/,
    'stale watch-word rows must not target former server members');
  assert.match(delivery, /allowed: await canViewChannel\(userId, canonicalServerId, String\(msg\.channelId\)\)/);
  const muteAt = delivery.indexOf('if (isMuted(pref)) return;');
  const watchAllowAt = delivery.indexOf("const matchedKeyword = watchWordByUser.get(userId)");
  assert.ok(muteAt >= 0 && watchAllowAt > muteAt,
    'channel/server mute must remain authoritative over watch-word attention');
  assert.match(delivery, /notification_watch_word_read_failed[\s\S]{0,300}continuing with explicit mentions/,
    'a watch-word store outage must not suppress ordinary explicit mentions');

  assert.match(client, /MAX_WATCH_WORDS = 10/);
  assert.match(client, /body: JSON\.stringify\(\{ serverId, keywords: normalized \}\)/);
  assert.match(panel, /Takip edilen kelimeler/);
  assert.match(panel, /void persistWatchWords\(\[\.\.\.watchWords, word\]\)/);
  assert.match(panel, /watchWords = previous/,
    'failed preference writes must roll back optimistic watch-word state');
  assert.doesNotMatch(panel, /new RegExp\(watchInput|eval\(|\{@html[^}]*watch/,
    'watch-word UX must not turn user input into executable regex/HTML');

  assert.match(lifecycle, /notification_keywords[\s\S]{0,100}disposition: 'DELETE'/);
  assert.match(account, /notificationKeywords[\s\S]{0,80}notification_keywords/,
    'watch-word personal metadata must be included in account export');
});

test('watch-word attention stays distinct from mentions throughout the durable Inbox', () => {
  const migration = read('server/db/migrations_pg/067_inbox_watch_attention.sql');
  const schema = read('server/db/postgres/schema.ts');
  const repo = read('server/db/repositories/NotificationRepository.ts');
  const delivery = read('server/lib/notifications.ts');
  const route = read('server/routes/inbox.ts');
  const panel = read('client/js/core/InboxPanel.svelte');

  assert.match(migration, /DROP INDEX IF EXISTS idx_notifications_inbox_message/,
    'an existing partial index must be rebuilt; CREATE IF NOT EXISTS alone cannot change its predicate');
  assert.match(migration, /type IN \('mention', 'reply', 'watch'\)/);
  assert.match(schema, /idx_notifications_inbox_unread[\s\S]{0,160}type IN \('mention', 'reply', 'watch'\)/);
  assert.match(repo, /type: 'mention' \| 'reply' \| 'watch'/);
  assert.match(repo, /type: \{ \$in: \['mention', 'reply', 'watch'\] \}/);
  assert.match(delivery, /type: explicitlyMentioned \? 'mention' : 'watch'/,
    'a real @mention must win over a simultaneous watch-word match for the same canonical message row');

  assert.match(route, /type InboxFilter = 'all' \| 'mentions' \| 'watches'/);
  assert.match(route, /row\.type === 'watch' \? 'watch' : 'mention'/);
  assert.match(route, /watches: channelItems\.filter\(item => item\.kind === 'watch'\)\.length/);
  assert.match(route, /counts\.mentions \+ counts\.watches \+ counts\.replies/);
  assert.match(panel, /kind: 'mention' \| 'watch' \| 'reply'/);
  assert.match(panel, /if \(item\.kind === 'watch'\) return t\(["']ui_takip["']/);
  assert.match(panel, /filter === 'watches'[\s\S]{0,220}>\{t\(['"]ui_takip['"]/);
});

test('critical auth, social, search and settings surfaces share the mobile visual-viewport modal contract', () => {
  const auth = read('client/css/modules/auth.css');
  const friends = read('client/js/core/FriendsPanel.svelte');
  const settings = read('client/js/core/settings/SettingsModal.svelte');
  const serverSettings = read('client/js/core/server-settings/ServerSettingsModal.svelte');
  const search = read('client/js/core/GlobalSearchPanel.svelte');
  const pins = read('client/js/core/PinnedMessagesPanel.svelte');
  const invite = read('client/js/core/InvitePanel.svelte');
  const createChannel = read('client/js/core/CreateChannelPanel.svelte');
  const onboarding = read('client/js/core/OnboardingWizard.svelte');

  assert.match(auth, /width: min\(440px, 100%\)/,
    'authentication must never require a 440px-wide viewport');
  assert.match(auth, /--bridge-visual-viewport-height/);
  assert.match(auth, /env\(safe-area-inset-top\)/);
  assert.match(auth, /prefers-reduced-motion: reduce/);

  assert.match(friends, /class="friends-overlay"/);
  assert.match(friends, /use:focusTrap/);
  assert.match(friends, /--bridge-visual-viewport-height/);
  assert.match(friends, /@media\(max-width:480px\)/);
  assert.match(friends, /env\(safe-area-inset-bottom\)/);

  assert.match(settings, /--bridge-visual-viewport-height|100dvh/);
  assert.match(settings, /@media \(max-width: 480px\)/);
  assert.match(serverSettings, /flex-direction: row/,
    'server settings categories must become a horizontal mobile tab rail');
  assert.match(serverSettings, /--bridge-visual-viewport-height/);
  assert.match(serverSettings, /env\(safe-area-inset-top\)/);

  assert.match(search, /@media \(max-width: 600px\)/);
  assert.match(search, /height: var\(--bridge-visual-viewport-height, 100dvh\)/);
  assert.match(search, /env\(safe-area-inset-bottom\)/);
  assert.match(pins, /max-height: min\(82dvh, var\(--bridge-visual-viewport-height, 82dvh\)\)/);
  assert.match(pins, /border-radius: var\(--radius-modal\) var\(--radius-modal\) 0 0/);
  assert.doesNotMatch(pins, /max-height: calc\(100vh - 16px\)/,
    'mobile pinned messages must not regress to layout-viewport sizing');

  for (const surface of [invite, createChannel, onboarding]) {
    assert.match(surface, /--bridge-visual-viewport-height/,
      'entry/setup modals must follow the actual mobile visual viewport');
    assert.match(surface, /env\(safe-area-inset-bottom\)/,
      'entry/setup modals must keep controls above device safe areas');
  }
  assert.match(invite, /\.inv-linkrow \{ flex-direction: column; \}/,
    'invite link and copy action must not squeeze side-by-side on narrow phones');
  assert.match(createChannel, /grid-template-columns: 1fr 1fr/,
    'channel creation actions must keep equal touch-safe targets');
  assert.match(onboarding, /prefers-reduced-motion: reduce/);
});

test('floating menus clamp to the visual viewport and remaining core modal surfaces stay touch-safe on phones', () => {
  const clamp = read('client/js/core/floating-position.ts');
  const serverMenu = read('client/js/core/ServerMenu.svelte');
  const channelMenu = read('client/js/core/channel-perms/ChannelActionMenu.svelte');
  const perms = read('client/js/core/channel-perms/ChannelPermsEditor.svelte');
  const emptyStart = read('client/js/core/EmptyServerStart.svelte');
  const member = read('client/js/core/MemberProfilePopover.svelte');
  const dmCall = read('client/js/core/DmCallPanel.svelte');
  const discover = read('client/js/core/DiscoverPanel.svelte');

  assert.match(clamp, /window\.visualViewport/);
  assert.match(clamp, /offsetLeft/);
  assert.match(clamp, /offsetTop/);
  assert.match(clamp, /Math\.min\(Math\.max\(input\.left/);
  assert.match(clamp, /Math\.min\(Math\.max\(input\.top/);
  assert.match(serverMenu, /clampFloatingRect/);
  assert.match(serverMenu, /menuEl\?\.getBoundingClientRect\(\)\.height/);
  assert.match(channelMenu, /bind:this=\{menuEl\}/);
  assert.match(channelMenu, /clampFloatingRect\(\{ left: menuX, top: menuY/);

  for (const surface of [perms, emptyStart, member, dmCall, discover]) {
    assert.match(surface, /--bridge-visual-viewport-height/);
    assert.match(surface, /env\(safe-area-inset-bottom\)/);
  }
  assert.match(perms, /\.cp-roles \{[^}]*flex-direction: row/s,
    'role navigation must become horizontal instead of crushing the permission matrix');
  assert.match(member, /\.mp-overlay \{ place-items: end center/);
  assert.match(dmCall, /\.dm-call-overlay \{ padding: 0; align-items: flex-end; \}/);
  assert.match(discover, /height: var\(--bridge-visual-viewport-height, 100dvh\)/);
});


test('narrow shell and voice overlays stay inside the visual viewport without dead navigation space', () => {
  const responsive = read('client/css/modules/responsive-fixes.css');
  const onboarding = read('client/css/modules/stage-onboarding.css');
  const voice = read('client/js/core/VoicePanel.svelte');
  const pinned = read('client/js/core/PinnedMessagesPanel.svelte');

  assert.match(onboarding, /@media \(max-width: 600px\) and \(orientation: landscape\) and \(max-height: 430px\)/,
    'landscape phone compaction must not reserve hidden mobile-nav space in the 601–812px tablet range');
  assert.match(responsive, /@media \(min-width: 601px\) and \(max-width: 768px\)/,
    'the compact tablet shell remains the canonical owner above the phone breakpoint');

  assert.match(onboarding, /\.soundboard-panel \{[^}]*--bridge-visual-viewport-height[^}]*safe-area-inset-bottom/s,
    'mobile soundboard height must follow the real visual viewport and home-indicator inset');
  assert.match(voice, /\.screen-share-view\.ss-mini \{[^}]*width: min\(320px, calc\(100vw - 24px\)\)[^}]*--bridge-visual-viewport-height[^}]*aspect-ratio: 4 \/ 3/s,
    'mini screen share must shrink instead of clipping on narrow phones');
  assert.match(voice, /right: max\(12px, env\(safe-area-inset-right\)\)/);
  assert.match(voice, /bottom: calc\(12px \+ env\(safe-area-inset-bottom\) \+ 60px\)/,
    'mobile mini screen share must clear the bottom navigation while it is visible');
  assert.match(voice, /:global\(html\.bridge-keyboard-open\) \.screen-share-view\.ss-mini/,
    'keyboard-open state must reclaim bottom-nav space for the floating screen-share surface');

  assert.match(pinned, /use:focusTrap=\{\{ active: isVisible, initialFocus: '\.pin-close', returnFocus: false \}\}/,
    'pinned messages is modal and must keep keyboard focus inside until close');
  assert.match(pinned, /işlem menüsünden Sabitle/,
    'pinned empty-state guidance must not assume a hover-capable pointer');
  assert.match(pinned, /max-height: min\(640px, calc\(var\(--bridge-visual-viewport-height, 100dvh\) - 96px\)\)/,
    'desktop/narrow pinned panel must use the shared visual viewport owner too');
});


test('production modal surfaces trap focus instead of leaking keyboard navigation into the shell', () => {
  const dmCall = read('client/js/core/DmCallPanel.svelte');
  const channelPerms = read('client/js/core/channel-perms/ChannelPermsEditor.svelte');
  const marketplace = read('client/js/core/bot-marketplace/BotMarketplace.svelte');

  assert.match(dmCall, /role="dialog"[^>]*use:focusTrap=\{\{ active: isVisible, initialFocus: '\.dm-btn-reject' \}\}/,
    'DM call dialog must own focus while ringing/active');
  assert.match(channelPerms, /role="dialog"[^>]*aria-modal="true"[^>]*use:focusTrap/,
    'canonical channel permission editor must own focus while open');
  // KANONİK BİÇİM: arka plan katmanı `role="presentation"`, DİYALOG ise iç
  // panel. Arka plana tıklayınca kapanan bir kapsayıcıya `role="dialog"`
  // vermek, Svelte'nin haklı olarak uyardığı a11y ihlaliydi (tıklanabilir
  // kapsayıcı, klavye eşdeğeri olmadan). Sözleşme değişmedi: odak tuzağı
  // hâlâ diyalogdadır ve Tab uygulama kabuğuna SIZMAZ.
  assert.match(marketplace, /id="bot-marketplace-modal"[\s\S]{0,120}role="presentation"/,
    'bot marketplace backdrop must be presentational, not an interactive dialog');
  assert.match(marketplace, /class="mp-panel"[\s\S]{0,200}role="dialog"[\s\S]{0,200}use:focusTrap=\{\{ initialFocus: '\.mp-search' \}\}/,
    'bot marketplace dialog panel must own focus so Tab cannot leak into the app shell');
  assert.match(marketplace, /id="mp-detail-overlay"[\s\S]{0,120}role="presentation"/,
    'nested bot detail backdrop must be presentational');
  assert.match(marketplace, /class="mp-det-panel"[\s\S]{0,200}role="dialog"[\s\S]{0,200}use:focusTrap=\{\{ initialFocus: '\.mp-det-cls' \}\}/,
    'nested bot detail dialog must sit on top of the focus-trap stack');
});


test('message history, protected media and global search obey the shared visual viewport owner', () => {
  const message = read('client/js/core/MessageRenderer.svelte');
  const search = read('client/js/core/GlobalSearchPanel.svelte');

  assert.match(message, /edit-history-dialog \{[^}]*--bridge-visual-viewport-height/s,
    'edit-history dialog must not be sized from the layout viewport while the software keyboard is open');
  assert.match(message, /image-viewer-dialog \{[^}]*--bridge-visual-viewport-height/s,
    'protected-media lightbox must remain inside the actual visual viewport at every breakpoint');
  assert.doesNotMatch(message, /edit-history-dialog \{[^}]*calc\(100dvh - 40px\)/s);
  assert.doesNotMatch(message, /image-viewer-dialog \{[^}]*calc\(100dvh - 40px\)/s);

  assert.match(search, /max-height: min\(620px, calc\(var\(--bridge-visual-viewport-height, 100dvh\) - 96px\)\)/,
    'desktop/narrow global search must shrink with visualViewport instead of clipping under an on-screen keyboard');
  assert.match(search, /safe-area-inset-bottom/,
    'global search overlay must keep its bottom edge clear of device safe areas');
});


test('offline/reconnect banner follows real socket lifecycle and owns its timers', () => {
  const banner = read('client/js/core/OfflineBanner.svelte');

  assert.match(banner, /bridge:socket-disconnected/);
  assert.match(banner, /bridge:socket-reconnected/);
  assert.match(banner, /setSocketReconnecting/,
    'reconnect copy must be driven by the actual Socket.IO lifecycle');
  assert.doesNotMatch(banner, /RECONNECT_DELAY|reconnectSecs|setInterval\(/,
    'the banner must not invent a countdown that does not itself trigger a reconnect');
  assert.match(banner, /pendingClearTimer/);
  assert.match(banner, /if \(pendingClearTimer\) clearTimeout\(pendingClearTimer\)/,
    'the post-sync dismissal timer must be component-owned and cleared on destroy');
  assert.match(banner, /removeEventListener\('bridge:socket-disconnected'/);
  assert.match(banner, /t\(['"`]ui_offline_waiting['"`]/,
    'offline copy must stay behind the canonical i18n key');
});


test('channel send failures render bounded product copy instead of server diagnostic text', () => {
  const loader = read('client/js/core/MessageLoader.svelte');
  const copy = read('client/js/core/message-delivery-error.ts');

  assert.match(loader, /messageDeliveryError\(payload\.code, 'channel'\)/,
    'channel delivery UI must select copy from a bounded code instead of trusting payload.message');
  assert.doesNotMatch(loader, /failPendingSend', key, payload\.message/,
    'raw websocket message text must not reach the visible pending-message error state');
  assert.match(copy, /case 'INVALID_FILE_REFERENCE'/);
  assert.match(copy, /case 'CHANNEL_NOT_FOUND'/);
  assert.match(copy, /case 'MISSING_PERMISSION'/);
});


test('notification preferences stay inside the visual viewport and device safe areas', () => {
  const prefs = read('client/js/core/NotificationPrefsPanel.svelte');

  assert.match(prefs, /max-height: min\(660px, calc\(var\(--bridge-visual-viewport-height, 100dvh\) - 96px\)\)/,
    'notification settings must shrink with the actual visual viewport on desktop/narrow layouts too');
  assert.match(prefs, /\.np-header \{ padding-top: max\(14px, env\(safe-area-inset-top\)\); \}/,
    'a tall mobile notification sheet must keep its close control below the top safe area');
  assert.match(prefs, /env\(safe-area-inset-bottom\)/);
});


test('remaining settings, command, emoji and polls overlays use the shared visual viewport owner', () => {
  const settings = read('client/js/core/settings/SettingsModal.svelte');
  const command = read('client/js/core/CommandPalettePanel.svelte');
  const emoji = read('client/js/core/EmojiPickerPanel.svelte');
  const polls = read('client/js/core/PollsPanel.svelte');

  assert.match(settings, /height: min\(680px, calc\(var\(--bridge-visual-viewport-height, 100dvh\)/);
  assert.match(settings, /height: var\(--bridge-visual-viewport-height, 100dvh\)/);
  assert.match(settings, /safe-area-inset-top/);
  assert.match(settings, /safe-area-inset-bottom/);
  assert.doesNotMatch(settings, /height: 100dvh/);

  assert.match(command, /max-height: min\(540px, calc\(var\(--bridge-visual-viewport-height, 100dvh\) - 96px\)\)/);
  assert.match(command, /safe-area-inset-top/);
  assert.doesNotMatch(command, /max-height: calc\(100dvh - 32px\)/);

  assert.match(emoji, /--bridge-visual-viewport-height/);
  assert.match(emoji, /safe-area-inset-right/);
  assert.match(emoji, /safe-area-inset-bottom/);

  assert.match(polls, /height:var\(--bridge-visual-viewport-height,100dvh\)/);
  assert.match(polls, /safe-area-inset-top/);
  assert.match(polls, /safe-area-inset-bottom/);
  assert.doesNotMatch(polls, /height:100dvh/);
});


test('GDM shell owns focus and channel creation never reflects backend diagnostic text', () => {
  const gdm = read('client/js/core/GroupDmPanel.svelte');
  const createChannel = read('client/js/core/CreateChannelPanel.svelte');

  assert.match(gdm, /id="gdm-panel"[\s\S]{0,260}use:focusTrap=\{\{ active: isVisible/,
    'the aria-modal GDM shell must trap focus just like the canonical DM shell');
  assert.match(createChannel, /safeApiErrorMessage\(res,\s*t\(["']ui_kanal_olusturulamadi["']/,
    'channel creation failures must map HTTP responses to bounded product copy');
  assert.doesNotMatch(createChannel, /error\s*=\s*b\.error/,
    'raw backend error text must never become visible channel-creation copy');
});


test('leave-server, uploads and soundboard avoid raw backend copy and layout-viewport clipping', () => {
  const menu = read('client/js/core/ServerMenu.svelte');
  const composer = read('client/js/core/MessageInputPanel.svelte');
  const composerUtils = read('client/js/core/message-input-utils.ts');
  const stageCss = read('client/css/modules/stage-onboarding.css');

  assert.match(menu, /safeApiErrorMessage\(res,\s*t\(["']ui_sunucudan_ayrilamadin_lutfen_tekrar_dene["']/);
  assert.doesNotMatch(menu, /leaveError\s*=\s*b\.error/);

  assert.match(composerUtils, /function uploadErrorText\(status: number\): string/);
  assert.doesNotMatch(composer, /body\.error/,
    'upload rejection copy must come from bounded status mapping, never response body text');
  assert.doesNotMatch(composer, /Yükleme başarısız \(HTTP/,
    'visible upload errors should not expose diagnostic HTTP text');

  assert.match(stageCss, /height: min\(560px, calc\(var\(--bridge-visual-viewport-height, 100dvh\) - 112px\)\)/,
    'desktop/narrow soundboard must shrink with the keyboard-visible visual viewport too');
});


test('the communication shell follows visualViewport at tablet and desktop widths too', () => {
  const layout = read('client/css/modules/layout.css');
  const mobile = read('client/js/mobile.ts');

  assert.match(mobile, /document\.documentElement\.style\.setProperty\('--bridge-visual-viewport-height', `\$\{height\}px`\)/,
    'the canonical viewport controller must publish the measured visual viewport');
  assert.match(layout, /\.app \{[\s\S]{0,180}height: var\(--bridge-visual-viewport-height, 100dvh\)/,
    'the whole communication shell, not only phone overrides, must consume the visual viewport height');
});

test('canonical SFU engine is locally bundled, server-negotiated and request-correlated', () => {
  const app = read('client/js/app.ts');
  const html = read('client/index.html');
  const sfuClient = read('client/js/webrtc-sfu.ts');
  const p2pOwner = read('client/js/webrtc.ts');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const voiceServer = read('server/socket/handlers/voice.ts');
  const socketIndex = read('server/socket/index.ts');
  const sfuServer = read('server/socket/handlers/mediasoup/index.ts');

  // The browser client is a real local ESM dependency, never a CDN/global.
  assert.equal(pkg.dependencies?.['mediasoup-client'], '3.23.1');
  assert.equal(lock.packages?.['node_modules/mediasoup-client']?.version, '3.23.1');
  // Kutuphane YEREL bir ESM bagimliligi olarak KALIR; degisen tek sey ne
  // zaman yuklendigidir: ilk boyamada degil, kullanici bir SFU odasina
  // katildiginda (dinamik `import()`). Sozlesmenin amaci "CDN/global
  // degil, yerel paket" olmaya devam eder.
  assert.match(sfuClient, /import\('mediasoup-client'\)/);
  assert.doesNotMatch(sfuClient, /^import \{ Device \} from 'mediasoup-client';/m);
  assert.doesNotMatch(sfuClient, /declare const mediasoupClient|window\.mediasoupClient|_sfuClientAvailable/);
  const htmlCode = html.replace(/<!--[\s\S]*?-->/g, ' ');
  assert.doesNotMatch(htmlCode, /cdn\.jsdelivr\.net\/npm\/mediasoup-client|window\.mediasoupClient/);
  assert.match(html, /SFU \(mediasoup\) — YEREL BUNDLE \/ TEK RTC OWNER/);

  // Import order makes the SFU factory available before the one canonical
  // RTC singleton/lifecycle owner boots; there are not two competing owners.
  const sfuImport = app.indexOf("import './webrtc-sfu.ts'");
  const ownerImport = app.indexOf("import './webrtc.ts'");
  assert.ok(sfuImport >= 0 && ownerImport > sfuImport, 'SFU factory must load before canonical RTC owner');
  assert.match(sfuClient, /BridgeRegistry\.register\('rtc:sfu-factory'/);
  assert.match(p2pOwner, /BridgeRegistry\.get<\(socket: BridgeSocket\) => BridgeRTC>\('rtc:sfu-factory'\)/);
  assert.match(p2pOwner, /_rtcInstance = sfuFactory \? sfuFactory\(socket\) : new BridgeRTC\(socket\)/);
  assert.match(sfuClient, /destroy\(\): void/);
  assert.match(sfuClient, /setAudioProcessing\(/);
  assert.match(sfuClient, /_socketHandlers/);
  assert.match(sfuClient, /_detachSocketHandlers\(\)/);
  assert.match(sfuClient, /detail: \{ reason: 'socket-replaced' \}/);

  // Client support never implies server support. Voice owner always answers
  // capability discovery; the engine enables SFU only from that response.
  assert.match(voiceServer, /voice:get-capabilities/);
  assert.match(voiceServer, /voice:capabilities/);
  assert.match(socketIndex, /registerVoiceHandlers\(rateLimitedSocket, io, socketUser, \{ sfuReady: isSFUReady\(\) \}\)/);
  assert.match(sfuClient, /_negotiateSfuCapability\(\)/);
  assert.match(sfuClient, /this\._sfuAvailable = await this\._negotiateSfuCapability\(\)/);
  assert.match(sfuClient, /SFU_CAPABILITY_TIMEOUT_MS/);

  // Concurrent transport/produce/consume operations cannot reject one
  // another's waiters, and internal mediasoup exceptions stay in server logs.
  assert.match(sfuClient, /_nextSfuRequestId/);
  assert.match(sfuClient, /scope\?\.requestId/);
  assert.match(sfuClient, /scope\?\.operation/);
  assert.match(sfuServer, /function emitSfuError/);
  assert.match(sfuServer, /requestId: boundedRequestId\(requestId\)/);
  assert.match(sfuServer, /logSfuFailure\('join'/);
  assert.match(sfuServer, /logSfuFailure\('produce'/);
  assert.match(sfuServer, /logSfuFailure\('consume'/);
  assert.doesNotMatch(sfuServer, /socket\.emit\('sfu:error', \{ message: \(e as Error\)\.message \}\)/,
    'internal mediasoup exception text must never be reflected directly to clients');
});

test('live P2P voice tolerates transient disconnects and owns every recovery timer', () => {
  const rtc = read('client/js/webrtc.ts');

  assert.match(rtc, /PEER_DISCONNECT_GRACE_MS = 8_000/);
  assert.match(rtc, /state === 'disconnected'[\s\S]{0,260}_schedulePeerDisconnect/,
    'a transient disconnected state must get a recovery grace period instead of immediate peer deletion');
  assert.match(rtc, /state === 'failed'[\s\S]{0,520}restartIce/,
    'a failed ICE path should make one bounded recovery attempt before dropping the participant');
  assert.match(rtc, /MAX_ICE_RESTART_ATTEMPTS = 1/);
  assert.match(rtc, /_peerDisconnectTimers/);
  assert.match(rtc, /for \(const timer of this\._peerDisconnectTimers\.values\(\)\) clearTimeout\(timer\)/,
    'voice leave/socket teardown must not leak peer recovery timers');
  assert.match(rtc, /startAdaptiveBitrate\(pc: RTCPeerConnection\): void \{[\s\S]{0,220}this\.stopAdaptiveBitrate\(pc\)/,
    'ICE recovery must not accumulate duplicate adaptive-bitrate intervals');
  assert.match(rtc, /private _removePeer[\s\S]{0,240}this\.stopAdaptiveBitrate\(pc\)/,
    'peer removal must own ABR cleanup');
});

test('live P2P voice join is authoritative, retry-safe and never leaves false joined UI', () => {
  const rtc = read('client/js/webrtc.ts');
  const stage = read('client/js/core/ChannelStagePanel.svelte');
  const voice = read('server/socket/handlers/voice.ts');
  const validate = read('server/middleware/validate.ts');

  assert.match(validate, /requestId:[\s\S]{0,120}\^\[A-Za-z0-9:_-\]\+\$/,
    'voice joins need a bounded request correlation id');
  assert.match(voice, /voice:join-rejected/);
  assert.match(voice, /code: 'FORBIDDEN'/);
  assert.match(voice, /code: 'FULL'/);
  assert.match(voice, /voice:joined/);
  assert.match(voice, /status: 'already'[\s\S]{0,220}peers\.filter|peers\.filter[\s\S]{0,220}status: 'already'/,
    'a lost ACK retry must re-ack existing membership instead of silently timing out');

  const currentIndex = voice.indexOf('socket.currentVoiceChannel = channelId');
  const joinedIndex = voice.indexOf("socket.emit('voice:joined'");
  const peersIndex = voice.indexOf("socket.emit('voice:existing-peers'");
  assert.ok(currentIndex >= 0 && joinedIndex > currentIndex && peersIndex > joinedIndex,
    'server socket room state and authoritative ACK must exist before the client is asked to signal peers');

  assert.match(rtc, /_waitForVoiceJoinAck/);
  assert.match(rtc, /voice:joined/);
  assert.match(rtc, /voice:join-rejected/);
  assert.match(rtc, /VOICE_JOIN_ACK_TIMEOUT_MS/);
  assert.match(rtc, /await admitted/);
  assert.match(rtc, /this\._cleanupVoiceState\(\)[\s\S]{0,100}throw err/,
    'failed authoritative admission must roll back microphone/local joined state');
  assert.match(stage, /VoiceChannelFullError/);
  assert.match(stage, /VoiceJoinForbiddenError/);
  assert.doesNotMatch(stage, /\(err as Error\)\.message/,
    'voice join failures must stay on bounded product copy instead of raw server/browser messages');
});

test('production admin moderation shell uses bounded errors, canonical confirmation and responsive focus ownership', () => {
  const admin = read('client/js/admin/AdminPanel.svelte');

  assert.match(admin, /safeApiErrorMessage\(e,\s*t\(["']ui_admin_verileri_yuklenemedi["']/,
    'admin loader exceptions must collapse to bounded product copy');
  assert.match(admin, /safeApiErrorMessage\(r,\s*t\(["']ui_yasak_eklenemedi["']/,
    'admin API rejection copy must not reflect backend error strings');
  assert.doesNotMatch(admin, /error\s*=\s*\(e as Error\)\.message/);
  assert.doesNotMatch(admin, /data\.error\s*\|\|/);
  assert.doesNotMatch(admin, /\bconfirm\s*\(/,
    'destructive admin operations must not use blocking native confirm dialogs');
  assert.ok((admin.match(/confirmProductAction\s*\(/g) || []).length >= 5,
    'all destructive admin flows should use the canonical themed confirmation owner');
  assert.match(admin, /use:focusTrap=\{\{ active: true, initialFocus: 'button\.admin-close-btn' \}\}/,
    'admin dialog must own keyboard focus and provide a safe initial escape action');
  assert.match(admin, /height: var\(--bridge-visual-viewport-height, 100dvh\)/,
    'admin shell must follow the actual visual viewport');
  assert.match(admin, /safe-area-inset-top/);
  assert.match(admin, /@media \(max-width: 720px\)[\s\S]{0,900}\.admin-shell \{ flex-direction: column/,
    'admin navigation must stop squeezing the task surface on phones');
});

test('Inbox and Saved side panels keep their backdrop inside the shared visual viewport at every width', () => {
  const inbox = read('client/js/core/InboxPanel.svelte');
  const saved = read('client/js/core/SavedPanel.svelte');

  assert.match(inbox, /\.inbox-backdrop \{ position: fixed; inset: 0; height: var\(--bridge-visual-viewport-height, 100dvh\)/,
    'Inbox backdrop must not keep layout-viewport height on tablet/desktop when the visual viewport shrinks');
  assert.match(saved, /\.saved-backdrop \{ position: fixed; inset: 0; height: var\(--bridge-visual-viewport-height, 100dvh\)/,
    'Saved backdrop must own the same visual viewport as its mobile panel');
});


test('server-rendered public and proxy error surfaces stay mobile-safe and keyboard-visible', () => {
  const invite = read('server/routes/invitePreview.ts');
  const profile = read('server/routes/serverProfile.ts');
  const podcast = read('server/routes/podcast.ts');
  const proxyErrors = [400, 403, 408, 429, 500, 502, 503, 504].map(code => read(`haproxy/errors/${code}.http`));

  for (const source of [invite, profile, podcast, ...proxyErrors]) {
    assert.doesNotMatch(source, /(?:min-)?height:\s*100vh\b/,
      'production public/error HTML must not depend on the legacy layout viewport height');
  }
  assert.match(invite, /viewport-fit=cover/);
  assert.match(invite, /safe-area-inset-bottom/);
  assert.match(profile, /viewport-fit=cover/);
  assert.match(profile, /safe-area-inset-bottom/);
  assert.match(podcast, /min-height:\s*100dvh/);
  assert.match(podcast, /safe-area-inset-bottom/);

  for (const source of proxyErrors) {
    assert.match(source, /viewport-fit=cover/);
    assert.match(source, /min-height:100dvh/);
    assert.match(source, /safe-area-inset-bottom/);
    assert.match(source, /\.btn:hover,\.btn:focus-visible/,
      'proxy recovery actions must expose the same affordance to keyboard users as pointer users');
  }
});


test('P1 migrations 062-067 have explicit rollback owners and preserve pre-watch Inbox index semantics', () => {
  const pairs = [
    ['062_thread_message_delivery_idempotency.sql', '062_thread_message_delivery_idempotency.down.sql'],
    ['063_message_reports.sql', '063_message_reports.down.sql'],
    ['064_saved_message_reminders.sql', '064_saved_message_reminders.down.sql'],
    ['065_channel_read_positions.sql', '065_channel_read_positions.down.sql'],
    ['066_notification_watch_words.sql', '066_notification_watch_words.down.sql'],
    ['067_inbox_watch_attention.sql', '067_inbox_watch_attention.down.sql'],
  ];
  for (const [upName, downName] of pairs) {
    const up = read(`server/db/migrations_pg/${upName}`);
    const down = read(`server/db/migrations_pg/rollback/${downName}`);
    assert.ok(up.trim().length > 0 && down.trim().length > 0, `${upName} must have a non-empty rollback owner`);
  }

  const m062 = read('server/db/migrations_pg/062_thread_message_delivery_idempotency.sql');
  const d062 = read('server/db/migrations_pg/rollback/062_thread_message_delivery_idempotency.down.sql');
  assert.match(m062, /CREATE UNIQUE INDEX IF NOT EXISTS uq_thread_messages_delivery_nonce/);
  assert.match(d062, /DROP INDEX IF EXISTS uq_thread_messages_delivery_nonce/);
  assert.match(d062, /DROP COLUMN IF EXISTS "clientNonce"/);

  const m063 = read('server/db/migrations_pg/063_message_reports.sql');
  const d063 = read('server/db/migrations_pg/rollback/063_message_reports.down.sql');
  assert.match(m063, /CREATE TABLE IF NOT EXISTS message_reports/);
  assert.match(m063, /idx_message_reports_open_unique/);
  assert.match(d063, /DROP TABLE IF EXISTS message_reports/);

  const m064 = read('server/db/migrations_pg/064_saved_message_reminders.sql');
  const d064 = read('server/db/migrations_pg/rollback/064_saved_message_reminders.down.sql');
  assert.match(m064, /idx_saved_messages_due_reminder/);
  assert.match(d064, /DROP INDEX IF EXISTS idx_saved_messages_due_reminder/);
  assert.match(d064, /DROP COLUMN IF EXISTS "remindedAt"/);
  assert.match(d064, /DROP COLUMN IF EXISTS "remindAt"/);

  const m065 = read('server/db/migrations_pg/065_channel_read_positions.sql');
  const d065 = read('server/db/migrations_pg/rollback/065_channel_read_positions.down.sql');
  assert.match(m065, /PRIMARY KEY \("userId", "channelId"\)/);
  assert.match(d065, /DROP TABLE IF EXISTS channel_read_positions/);

  const m066 = read('server/db/migrations_pg/066_notification_watch_words.sql');
  const d066 = read('server/db/migrations_pg/rollback/066_notification_watch_words.down.sql');
  assert.match(m066, /PRIMARY KEY \("userId", "serverId", keyword\)/);
  assert.match(m066, /char_length\(keyword\) BETWEEN 2 AND 32/);
  assert.match(d066, /DROP TABLE IF EXISTS notification_keywords/);

  const originalInbox = read('server/db/migrations_pg/024_unified_inbox.sql');
  const m067 = read('server/db/migrations_pg/067_inbox_watch_attention.sql');
  const d067 = read('server/db/migrations_pg/rollback/067_inbox_watch_attention.down.sql');
  assert.match(m067, /type IN \('mention', 'reply', 'watch'\)/);
  const canonicalOldPredicates = [...originalInbox.matchAll(/WHERE[^;]+type IN \('mention', 'reply'\)[^;]*;/g)].map(m => m[0].replace(/\s+/g, ' ').trim());
  const rollbackPredicates = [...d067.matchAll(/WHERE[^;]+type IN \('mention', 'reply'\)[^;]*;/g)].map(m => m[0].replace(/\s+/g, ' ').trim());
  assert.deepEqual(rollbackPredicates, canonicalOldPredicates,
    '067 rollback must restore the exact pre-watch Inbox partial-index predicates from migration 024');
});

test('P2 analytics is production-reachable through server settings and remains permission-backed', () => {
  const modal = read('client/js/core/server-settings/ServerSettingsModal.svelte');
  const tab = read('client/js/core/server-settings/tabs/AnalyticsTab.svelte');
  const route = read('server/routes/stats.ts');

  assert.match(modal, /import AnalyticsTab from '\.\/tabs\/AnalyticsTab\.svelte'/);
  assert.match(modal, /id: 'analytics'/);
  assert.match(modal, /<AnalyticsTab \{store\} \/>/);
  assert.match(tab, /\/api\/servers\/\$\{sid\}\/stats/);
  assert.match(tab, /stats\/growth\?days=\$\{nextDays\}/);
  assert.match(tab, /stats\/activity/);
  assert.match(tab, /stats\/retention/);
  assert.match(tab, /stats\/export\.csv\?days=\$\{days\}/);
  assert.match(tab, /safeApiErrorMessage\(/,
    'analytics must use bounded product errors instead of backend response text');
  assert.match(tab, /isStillCurrentServer\(serverId\)/,
    'analytics must fail closed if the server changes while settings remain open');
  assert.doesNotMatch(tab, /innerHTML|\{@html\}|window\.Chart|Chart\.js/,
    'analytics should be native Svelte/token UI without reviving archived HTML or a chart dependency');
  assert.match(route, /hasPermission\(perms, PERMS\.MANAGE_SERVER\)/,
    'analytics metadata must remain server-authorized');
  assert.match(route, /if \(!await requireOwner\(me\.id, sid\)\)/,
    'CSV export must remain owner-only');
});

test('P2 member profile exposes no-oracle idempotent block management through canonical friends API', () => {
  const profile = read('client/js/core/MemberProfilePopover.svelte');
  const route = read('server/routes/friends.ts');

  assert.match(profile, /\/api\/friends\/blocks`/);
  assert.match(profile, /method: 'POST'[\s\S]{0,220}JSON\.stringify\(\{ userId: target \}\)/);
  assert.match(profile, /\/api\/friends\/blocks\/\$\{encodeURIComponent\(target\)\}/);
  assert.match(profile, /confirmProductAction\(\{/,
    'blocking must use the canonical non-native destructive confirmation');
  assert.match(profile, /blockState === 'blocked'/);
  assert.doesNotMatch(profile, /data\.(?:error|message)|payload\.(?:error|message)/,
    'block UI must not reflect backend diagnostic text');

  assert.match(route, /router\.get\('\/blocks'/);
  assert.match(route, /Social\.findBlocksByUser\(_u\.id\)/,
    'block list must expose only the caller-owned edge, not who blocked them');
  assert.match(route, /const existing = await Social\.findBlock\(_u\.id, targetId\)/,
    'block creation must be retry-idempotent');
  assert.match(route, /await Social\.removeBlock\(_u\.id, targetId\)/,
    'unblock must never accept a caller-supplied blocker identity');
});

test('P2 presence separates durable preference from effective live state with authoritative ACK and realtime UI', () => {
  const migration = read('server/db/migrations_pg/068_user_presence_status.sql');
  const rollback = read('server/db/migrations_pg/rollback/068_user_presence_status.down.sql');
  const inline = read('server/db/postgres/migrations.ts');
  const schema = read('server/db/postgres/schema.ts');
  const collection = read('server/db/postgres/pgCollection.ts');
  const users = read('server/lib/userUtils.ts');
  const socketIndex = read('server/socket/index.ts');
  const infra = read('server/socket/handlers/infra.ts');
  const contracts = read('server/socket/contracts.ts');
  const authRoute = read('server/routes/auth.ts');
  const profile = read('client/js/core/settings/tabs/ProfileTab.svelte');
  const members = read('client/js/core/MemberListPanel.svelte');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "presenceStatus" TEXT NOT NULL DEFAULT 'online'/);
  assert.match(migration, /users_presenceStatus_check/);
  assert.match(migration, /'online', 'idle', 'dnd', 'offline'/);
  assert.match(rollback, /DROP CONSTRAINT IF EXISTS \"users_presenceStatus_check\"/);
  assert.match(rollback, /DROP COLUMN IF EXISTS "presenceStatus"/);
  assert.match(schema, /"presenceStatus" TEXT NOT NULL DEFAULT 'online'/);
  assert.match(inline, /column_name = 'presenceStatus'/,
    'normal startup upgrades must own migration 068, not only fresh schema and the numbered runner');
  assert.match(inline, /IF NOT EXISTS[\s\S]{0,260}column_name = 'presenceStatus'[\s\S]{0,520}UPDATE users/,
    'startup backfill must run only when the presence preference column is first introduced');
  assert.match(inline, /users_presenceStatus_check/);
  assert.match(collection, /'presenceStatus'/);
  assert.match(users, /presenceStatus: normalizePresenceStatus\(row\.presenceStatus\)/,
    'own-user serialization must expose the durable presence preference');

  assert.match(socketIndex, /const preferredStatus = normalizePresenceStatus/);
  assert.match(socketIndex, /const connectedStatus = presenceVisible \? preferredStatus : 'offline'/);
  assert.doesNotMatch(socketIndex, /presenceStatus:\s*connectedStatus/,
    'reconnect must never overwrite the durable preference with the effective state');
  assert.match(infra, /presenceStatus: preferredStatus/);
  assert.match(infra, /ack\?\.\(\{ ok: true, status: effectiveStatus \}\)/,
    'status:update must ACK the authoritative effective result');
  assert.match(infra, /releaseSocket\(user\._id, rawSocket\.id\)/);
  assert.doesNotMatch(infra, /Users\.update\(user\._id,\s*\{[^}]*presenceStatus:\s*'offline'/s,
    'disconnect must only change effective status, not the durable preference');
  assert.match(contracts, /'status:update': \(/);
  assert.match(contracts, /statusText\?: string;\s*statusEmoji\?: string;/);
  assert.match(authRoute, /updates\.presenceStatus = status/,
    'legacy REST profile status changes must also preserve the reconnect preference');

  assert.match(profile, /BridgeRegistry\.get<SocketLike>\('socket'\)/);
  assert.match(profile, /socket\.emit\('status:update', \{ status: next \},/);
  assert.match(profile, /ACK_TIMEOUT/);
  assert.match(profile, /if \(!result\.ok\)/);
  assert.match(profile, /presenceStatus = next;/,
    'selection must move only after a successful authoritative ACK');
  assert.match(profile, /role="radiogroup"/);
  assert.match(profile, /role="radio"/);
  assert.doesNotMatch(profile, /data\.(?:error|message)|payload\.(?:error|message)/,
    'presence UI must use bounded product copy, never backend diagnostics');

  assert.match(members, /boundSocket\?\.on\('user:status', onPresenceUpdate\)/);
  assert.match(members, /bridge:socket-reconnected/);
  assert.match(members, /boundSocket\?\.off\('user:status', onPresenceUpdate\)/,
    'member-list realtime presence listener must be lifecycle-owned');
});

test('P2 stage channels use an authoritative listener-first session owner without pretending media exists', () => {
  const router = read('client/js/core/ChannelStagePanel.svelte');
  const stage = read('client/js/core/StageSessionPanel.svelte');
  const handler = read('server/socket/handlers/stage.ts');

  assert.match(router, /if \(type === 'stage'\) return 'stage'/,
    'stage channels must not be classified as normal voice channels');
  assert.match(router, /<StageSessionPanel active=\{kind === 'stage'\}/,
    'the production channel router must keep one dedicated stage-session owner');
  assert.match(router, /desiredVoiceChannel = kind === 'voice'/,
    'stage selection must never enter rtc.joinVoice/getUserMedia routing');

  assert.match(stage, /emitAck\('stage:join', \{ channelId: wanted \}\)/);
  assert.match(stage, /emitAck\('stage:setRole', \{ channelId: wanted, role: 'listener' \}\)/,
    'stage entry must be listener-first and microphone-free');
  assert.match(stage, /emitAck\('stage:handRaise'/);
  assert.match(stage, /emitAck\('stage:leave'/);
  assert.match(stage, /if \(result\.ok\) \{[\s\S]{0,160}manuallyLeft = true/,
    'leave UI must move only after authoritative acknowledgement');
  assert.match(stage, /stage:state/);
  assert.match(stage, /stage:topicUpdate/);
  assert.match(stage, /stage:liveUpdate/);
  assert.match(stage, /bridge:socket-reconnected/,
    'stage listeners must rebind through the canonical reconnect lifecycle');
  assert.doesNotMatch(stage, /getUserMedia|joinVoice|RTCPeerConnection|attachRemoteStream/,
    'the stage control plane must not fabricate an unverified media path');
  assert.match(stage, /Gerçek Stage SFU medya aktarımı doğrulanmadan/,
    'the UI must remain explicit about real-media verification boundaries');

  assert.match(handler, /type StageAck = \(result: \{ ok: boolean; code\?: string; canManage\?: boolean \}\) => void/);
  assert.match(handler, /stage:join'[\s\S]{0,900}ack\?\.\(\{ ok: true, canManage:/,
    'stage join must ACK only after access, room creation and Socket.IO room join');
  assert.match(handler, /stage:setRole'[\s\S]{0,1800}ack\?\.\(\{ ok: true \}\)/,
    'role changes must ACK only after authoritative room persistence');
  assert.match(handler, /stage:handRaise'[\s\S]{0,1000}ack\?\.\(\{ ok: true \}\)/,
    'hand raise must be server-confirmed');
  assert.match(handler, /stage:leave'[\s\S]{0,1000}ack\?\.\(\{ ok: true \}\)/,
    'leave must be retry-safe and server-confirmed');
  assert.match(handler, /canManage: await _isAuthorized\(channelId, user\._id, room\)/,
    'stage management capability must come from the authoritative server owner');
  for (const event of ['stage:promote', 'stage:demote', 'stage:setTopic', 'stage:setLive']) {
    assert.match(handler, new RegExp(`${event}'[\\s\\S]{0,2200}ack\\?\\.\\(\\{ ok: true \\}\\)`),
      `${event} must be server-confirmed before the client treats it as successful`);
  }
  assert.match(stage, /runModeration\(event: 'stage:promote' \| 'stage:demote'/);
  assert.match(stage, /emitAck\(event, \{ channelId: joinedChannelId, targetUserId \}\)/);
  assert.match(stage, /emitAck\('stage:setTopic'/);
  assert.match(stage, /emitAck\('stage:setLive'/);
  assert.match(stage, /if \(!canManage \|\| !joinedChannelId \|\| moderationBusy\) return;/,
    'stage moderation controls must remain gated by the server-issued capability');
});

test('Stage SFU media authority is subordinate to the canonical control-plane role', () => {
  const stage = read('server/socket/handlers/stage.ts');
  const sfu = read('server/socket/handlers/mediasoup/index.ts');

  assert.match(stage, /export async function isStageParticipant\(channelId: string, userId: string, socketId\?: string\)/,
    'Stage must expose one canonical participant query usable by media owners');
  assert.match(stage, /participant\.userId === userId && \(!socketId \|\| participant\.socketId === socketId\)/,
    'same-socket owners may require the exact Stage roster slot');
  assert.match(stage, /export async function isStageSpeaker\(channelId: string, userId: string, socketId\?: string\)/,
    'Stage media publishing must have a canonical speaker-role query');

  // SFU signaling can legitimately move to a dedicated owner-node Socket.IO
  // connection, so it is bound to the authenticated account's current Stage
  // role rather than the primary app socket id.
  assert.match(sfu, /authority\.channelType === 'stage' && !await isStageParticipant\(channelId, user\._id\)/,
    'Stage RTP capability discovery must require a live Stage participant account');
  assert.match(sfu, /authority\.channelType === 'stage' && !await isStageParticipant\(channelId, user\._id\)/g,
    'Stage SFU join must repeat participant authorization instead of trusting earlier discovery');
  assert.match(sfu, /publishAuthority\.channelType === 'stage' && !await isStageSpeaker\(peer\.channelId, user\._id\)/,
    'Stage SFU produce must reject listeners even when they possess the channel SPEAK permission');
});

test('Stage video-grid metadata cannot invent media or speaking state', () => {
  const grid = read('server/socket/handlers/stage-video-grid.ts');
  assert.match(grid, /isStageParticipant\(channelId, user\._id, socket\.id\)/,
    'video-grid join must use exact-socket Stage participation');
  assert.match(grid, /await isStageSpeaker\(channelId, user\._id, socket\.id\)/,
    'Stage speaking/media metadata must be subordinate to the exact speaker slot');
  assert.match(grid, /const sfuState = readSfuVideoState\(socket\.id\)/,
    'video-grid state must be derived from canonical SFU peer/producers');
  assert.match(grid, /peer\.hasCamera = speaker && sfuState\.hasCamera/);
  assert.match(grid, /peer\.hasScreen = speaker && sfuState\.hasScreen/);
  assert.doesNotMatch(grid, /peer\.hasCamera\s*=\s*video/,
    'client video booleans must never create fake camera state');
  assert.doesNotMatch(grid, /peer\.hasScreen\s*=\s*screensharing/,
    'client screenshare booleans must never create fake screen state');
});


test('Stage demotion and leave revoke already-open SFU producers across the cluster', () => {
  const stage = read('server/socket/handlers/stage.ts');
  const rooms = read('server/socket/handlers/mediasoup/rooms.ts');
  const socketIndex = read('server/socket/index.ts');

  assert.match(rooms, /export function revokeStagePublishers\(channelId: string, userId: string\): number/,
    'the canonical mediasoup room owner must expose an authoritative producer revoker');
  assert.match(rooms, /for \(const \[kind, producer\] of \[\.\.\.peer\.producers\.entries\(\)\]\)/);
  assert.match(rooms, /producer\.close\(\)/,
    'revocation must close mediasoup producers, not merely ask the client to stop');
  assert.match(stage, /await _revokeStageMedia\(io, channelId, targetUserId\)/,
    'demotion must revoke media before announcing the new listener state');
  assert.match(stage, /if \(role === 'listener'\) await _revokeStageMedia\(io, channelId, user\._id\)/,
    'self-demotion to listener must revoke existing media too');
  assert.match(stage, /io\.serverSideEmit\('stage:media-revoke', \{ channelId, userId \}\)/,
    'cluster deployments must carry media revocation to the SFU owner node');
  assert.match(socketIndex, /bindStageMediaClusterControl\(io\)/,
    'the cluster revocation listener must be bound once at Socket.IO server setup');
});

test('P2 polls keep voter identities private and broadcast only authoritative invalidations', () => {
  const routes = read('server/routes/polls.ts');

  assert.match(routes, /function pollForViewer\(poll: PollForClient, viewerId: string\)/,
    'poll REST payloads must pass through one viewer-specific serializer');
  assert.match(routes, /poll\.options\.map\(\(\{ votes = \[\], \.\.\.option \}\) => \(\{/,
    'the serializer must destructure persistence-only voter ids out of every option');
  assert.match(routes, /voteCount: votes\.length/);
  assert.match(routes, /votedByMe: votes\.includes\(viewerId\)/,
    'the viewer may learn only aggregate count plus their own vote bit');
  assert.doesNotMatch(routes, /res\.json\(poll\);/,
    'no poll endpoint may accidentally return the persistence model directly');
  assert.match(routes, /function emitPollInvalidation[\s\S]{0,500}emit\(event, \{ channelId, pollId \}\)/,
    'channel broadcasts must carry invalidation ids, not viewer-specific poll bodies');
  assert.doesNotMatch(routes, /emit\([^\n]+\{[^\n]*poll\s*:/,
    'poll socket broadcasts must not expose a raw poll payload to every channel viewer');
});

test('P2 production poll UI consumes privacy-safe vote state and owns close/delete mutations', () => {
  const panel = read('client/js/core/PollsPanel.svelte');
  const app = read('client/js/app.ts');

  assert.match(app, /import ['"]\.\/core\/polls-svelte\.ts['"]/,
    'the production boot must continue to use the Svelte poll owner');
  assert.doesNotMatch(app, /import ['"]\.\/polls\.ts['"]/,
    'the legacy HTML-string poll implementation must remain dormant');
  assert.match(panel, /interface PollOption \{ id: string; text: string; voteCount: number; votedByMe: boolean \}/);
  assert.match(panel, /option\.voteCount/);
  assert.match(panel, /option\.votedByMe === true/);
  assert.doesNotMatch(panel, /option\.votes|\.votes\?\.length/,
    'the production UI must not depend on voter identity arrays');
  assert.match(panel, /selectedVotes = Object\.fromEntries\(polls\.map\(\(poll\) => \[poll\._id, poll\.options\.filter\(\(option\) => option\.votedByMe\)/,
    'authoritative reload must restore only the current viewer\'s selections');
  assert.match(panel, /const delta = \[\.\.\.new Set\(/,
    'desired vote state must be converted to a toggle delta instead of replaying current votes');
  assert.match(panel, /removingAll[\s\S]{0,300}\? \{ method: 'DELETE' \}/,
    'clearing all selected votes must use the authoritative remove-vote endpoint');
  assert.match(panel, /fetcher\(`\/api\/polls\/\$\{encodeURIComponent\(poll\._id\)\}\/close`, \{ method: 'POST' \}\)/);
  assert.match(panel, /confirmProductAction\(\{/,
    'destructive poll deletion must use the canonical product confirmation surface');
  assert.match(panel, /fetcher\(`\/api\/polls\/\$\{encodeURIComponent\(poll\._id\)\}`, \{ method: 'DELETE' \}\)/);
  // `keepError` ZORUNLUDUR. Reddedilen bir mutasyondan sonraki tazeleme,
  // reddin GEREKCESINI silmemelidir; aksi halde 403/404/429 yanitlari
  // sessizce yutulur: liste tazelenir, secim geri alinir ve kullanici neden
  // basarisiz oldugunu HIC goremez. Sozlesme bu yuzden yalnizca "tazeleme
  // yapiliyor" degil, "hata KORUNARAK tazeleniyor" seklinde baglanir.
  assert.match(panel, /if \(!response\.ok\) \{ error = safeError\(response\.status, 'delete'\); await load\(\{ keepError: true \}\); return; \}/,
    'delete must never show false success, and the refusal reason must survive the refresh');
  assert.doesNotMatch(panel, /data\.(?:error|message)|payload\.(?:error|message)/,
    'poll mutations must use bounded product copy rather than backend diagnostics');
});

test('P2 forum channels are production-reachable through one Svelte owner and reuse canonical thread delivery', () => {
  const router = read('client/js/core/ChannelStagePanel.svelte');
  const forum = read('client/js/core/ForumChannelPanel.svelte');
  const thread = read('client/js/core/ThreadPanel.svelte');
  const routes = read('server/routes/threads.ts');

  assert.match(router, /import ForumChannelPanel from '\.\/ForumChannelPanel\.svelte'/);
  assert.match(router, /if \(type === 'forum'\) return 'forum'/,
    'forum channels must no longer fall through to the unsupported surface');
  assert.match(router, /<ForumChannelPanel active=\{kind === 'forum'\} \{channelId\} \{channelName\} \/>/);

  assert.match(forum, /fetcher\(`\/api\/threads\/channel\/\$\{encodeURIComponent\(requestedChannel\)\}\?\$\{params\}`\)/,
    'forum listing must use the permission-scoped canonical thread route');
  assert.match(forum, /fetcher\('\/api\/threads', \{/);
  assert.match(forum, /JSON\.stringify\(\{ channelId: requestedChannel, name: title\.trim\(\), firstMessage: firstMessage\.trim\(\), tags: parseTags\(\) \}\)/,
    'forum creation must submit bounded structured data to the canonical route');
  assert.match(forum, /BridgeRegistry\.call\('openExistingThread', thread\._id, thread\.firstMessage\)/,
    'forum cards must reuse the production thread panel rather than create a second message stack');
  assert.match(forum, /forum:thread:created/);
  assert.match(forum, /forum:thread:updated/);
  assert.match(forum, /bridge:socket-reconnected/,
    'forum invalidation listeners must rebind through the canonical reconnect lifecycle');
  assert.doesNotMatch(forum, /innerHTML|data\.(?:error|message)|payload\.(?:error|message)/,
    'the production forum surface must render text safely and keep backend diagnostics bounded');

  assert.match(thread, /async function openExisting\(threadId: string, preview = ''\)/);
  assert.match(thread, /fetcher\(`\/api\/threads\/\$\{encodeURIComponent\(threadId\)\}`\)/,
    'existing forum threads must be re-authorized before the side panel opens');
  assert.match(thread, /socket\(\)\?\.emit\('thread:join', id\)/);
  assert.match(thread, /thread\?\._id && thread\._id !== threadId[\s\S]{0,180}socket\(\)\?\.emit\('thread:leave', thread\._id\)/,
    'switching forum threads must leave the old realtime room first');
  assert.match(thread, /BridgeRegistry\.register\('openExistingThread', openExisting\)/);
  assert.match(thread, /BridgeRegistry\.unregister\('openExistingThread'\)/,
    'the new forum entry point must remain lifecycle-owned by the canonical thread surface');

  assert.match(routes, /if \(channel\.type !== 'forum'\) return res\.status\(400\)/,
    'server creation remains explicitly constrained to real forum channels');
  assert.match(routes, /VIEW_CHANNELS\) \|\| !hasPermission\(perms, PERMS\.SEND_MESSAGES\)/,
    'forum creation remains server permission-enforced');
  assert.match(routes, /READ_HISTORY\)\)\s*return res\.status\(403\)/,
    'forum listing remains server history-permission enforced');
});

test('P2 server events are production-reachable with permission-safe pagination and authoritative RSVP', () => {
  const app = read('client/js/app.ts');
  const menu = read('client/js/core/ServerMenu.svelte');
  const panel = read('client/js/core/ServerEventsPanel.svelte');
  const routes = read('server/routes/serverEvents.ts');

  assert.match(app, /import '\.\/core\/server-events-svelte\.ts'/,
    'server events must be part of the production client bundle');
  assert.match(menu, /BridgeRegistry\.has\('openServerEvents'\)/);
  assert.match(menu, /id: 'events'[\s\S]{0,180}BridgeRegistry\.call\('openServerEvents'\)/,
    'the server menu must expose one discoverable events entry point');
  assert.match(panel, /BridgeRegistry\.register\('openServerEvents', open\)/);
  assert.match(panel, /use:focusTrap=/,
    'the events dialog must own keyboard focus');
  assert.match(panel, /var\(--bridge-visual-viewport-height,100dvh\)/,
    'the events surface must stay inside the shared visual viewport contract');
  assert.match(panel, /filter=\$\{filter\}&limit=20&offset=\$\{offset\}/,
    'event listing must use bounded backend pagination instead of unbounded client fetches');
  assert.match(panel, /events = reset \? page : \[\.\.\.events, \.\.\.page\.filter/);
  assert.match(panel, /events\.length < total/,
    'the product surface must expose load-more when the server reports additional rows');
  assert.match(panel, /\/me\/permissions/);
  assert.match(panel, /\(permissions & ADMINISTRATOR\) !== 0 \|\| \(permissions & MANAGE_SERVER\) !== 0/,
    'server-wide create controls must be hidden unless server-issued permissions allow management');
  assert.match(panel, /fetcher\(`\/api\/servers\/\$\{encodeURIComponent\(sid\)\}\/events`, \{/);
  assert.match(panel, /if \(!response\.ok\) \{ error = safeError\(response\.status, 'create'\); return; \}/,
    'event creation must not show false success');
  assert.match(panel, /\/events\/\$\{encodeURIComponent\(event\.id\)\}\/rsvp/);
  assert.match(panel, /status\s*\? \{ method: 'POST'/);
  assert.match(panel, /: \{ method: 'DELETE' \}/,
    'RSVP target state must use authoritative POST/DELETE mutations');
  // `keepError` ZORUNLUDUR. Reddedilen bir mutasyondan sonraki tazeleme,
  // reddin GEREKCESINI silmemelidir; aksi halde 403/404/429 yanitlari
  // sessizce yutulur: liste tazelenir, secim geri alinir ve kullanici neden
  // basarisiz oldugunu HIC goremez. Sozlesme bu yuzden yalnizca "tazeleme
  // yapiliyor" degil, "hata KORUNARAK tazeleniyor" seklinde baglanir.
  assert.match(panel, /if \(!response\.ok\) \{ error = safeError\(response\.status, 'rsvp'\); await load\(true, true\); return; \}/,
    'failed RSVP must reload authoritative state AND keep the refusal reason visible');
  assert.match(panel, /server:event:created/);
  assert.match(panel, /server:event:rsvp/);
  assert.match(panel, /bridge:socket-reconnected/,
    'event invalidation listeners must be reconnect-owned');
  assert.doesNotMatch(panel, /data\.(?:error|message)|payload\.(?:error|message)|innerHTML/,
    'event UI must keep server diagnostics bounded and text rendering safe');

  assert.match(routes, /visibleEventChannelIds\(u\.id, sid\)/,
    'event list visibility must be reduced to channels the viewer can currently see before pagination');
  assert.match(routes, /canViewEventChannel\(u\.id, sid, event\.channel_id\)/,
    'event detail and RSVP must revalidate current channel visibility');
  assert.match(routes, /requireEventPerm\(u\.id, sid, channelId \?\? null\)/,
    'create authorization remains owned by the backend');
});

test('P2 forum moderation exposes tag filtering and authoritative pin/lock lifecycle', () => {
  const panel = read('client/js/core/ForumChannelPanel.svelte');
  const routes = read('server/routes/threads.ts');
  assert.match(panel, /params\.set\('tag', tagFilter\)/);
  assert.match(panel, /X-Bridge-Forum-Can-Manage/);
  assert.match(panel, /setThreadState\(thread, 'pin', !thread\.pinned\)/);
  assert.match(panel, /setThreadState\(thread, 'lock', !thread\.locked\)/);
  assert.match(routes, /X-Bridge-Forum-Can-Manage/);
  assert.match(routes, /forum:thread:deleted/);
  assert.match(routes, /forum:thread:updated/);
});

test('P2 server events expose authoritative edit/delete lifecycle without native confirmation', () => {
  const panel = read('client/js/core/ServerEventsPanel.svelte');
  const routes = read('server/routes/serverEvents.ts');
  assert.match(panel, /async function updateEvent\(\)/);
  assert.match(panel, /method: 'PATCH'/);
  assert.match(panel, /confirmProductAction\(\{\s*title:\s*t\(["']ui_etkinligi_sil["']/);
  assert.match(panel, /method: 'DELETE'/);
  // `keepError` ZORUNLUDUR. Reddedilen bir mutasyondan sonraki tazeleme,
  // reddin GEREKCESINI silmemelidir; aksi halde 403/404/429 yanitlari
  // sessizce yutulur: liste tazelenir, secim geri alinir ve kullanici neden
  // basarisiz oldugunu HIC goremez. Sozlesme bu yuzden yalnizca "tazeleme
  // yapiliyor" degil, "hata KORUNARAK tazeleniyor" seklinde baglanir.
  assert.match(panel, /if \(!response\.ok\) \{ error = safeError\(response\.status, 'delete'\); await load\(true, true\); return; \}/,
    'failed delete must reload authoritative state AND keep the refusal reason visible');
  assert.match(routes, /router\.patch\([\s\S]*'\/:sid\/events\/:eid'/);
  assert.match(routes, /router\.delete\([\s\S]*'\/:sid\/events\/:eid'/);
  assert.match(routes, /requireEventPerm\(u\.id, sid, existing\.channel_id\)/);
});

test('P2 boost economy is production-reachable with authoritative membership state and no false-success removal', () => {
  const modal = read('client/js/core/server-settings/ServerSettingsModal.svelte');
  const panel = read('client/js/core/server-settings/tabs/BoostTab.svelte');
  const routes = read('server/routes/boosts.ts');
  assert.match(modal, /import BoostTab\s+from '\.\/tabs\/BoostTab\.svelte'/);
  assert.match(modal, /id: 'boost'/);
  assert.match(modal, /<BoostTab \/>/);
  assert.match(panel, /\/api\/servers\/\$\{encodeURIComponent\(serverId\)\}\/boosts/);
  assert.match(panel, /data\?\.boosters\?\.some\(row => String\(row\.userId/,
    'current-user boost state must come from the authoritative booster list');
  assert.match(panel, /confirmProductAction\(\{/,
    'boost removal must use canonical confirmation');
  assert.match(panel, /if \(!res\.ok && !\(next && res\.status === 409\)\)/,
    'mutation denial must not become false success');
  assert.doesNotMatch(panel, /data\.(?:error|message)|payload\.(?:error|message)/);
  assert.match(routes, /Members\.findOne\(me\.id, sid\)/,
    'boost creation remains membership-enforced on the server');
  assert.match(routes, /Boosts\.getActiveBoost\(sid, me\.id\)/,
    'duplicate boost remains server-idempotent');
});

test('P2 automation surface wires AutoMod, reaction roles and outgoing webhooks to canonical permission-backed APIs', () => {
  const modal = read('client/js/core/server-settings/ServerSettingsModal.svelte');
  const panel = read('client/js/core/server-settings/tabs/AutomationTab.svelte');
  const automod = read('server/routes/automod.ts');
  const reaction = read('server/routes/reactionRoles.ts');
  const hooks = read('server/routes/outgoingWebhooks.ts');
  assert.match(modal, /import AutomationTab from '\.\/tabs\/AutomationTab\.svelte'/);
  assert.match(modal, /id: 'automation'/);
  assert.match(modal, /<AutomationTab \/>/);
  assert.match(panel, /PERM_MANAGE_SERVER/);
  assert.match(panel, /PERM_MANAGE_ROLES/);
  assert.match(panel, /\/automod/);
  assert.match(panel, /\/reaction-roles/);
  assert.match(panel, /\/outgoing-webhooks/);
  assert.match(panel, /confirmProductAction\(\{\s*title:\s*t\(["']ui_automod_kuralini_sil["']/);
  assert.match(panel, /confirmProductAction\(\{\s*title:\s*t\(["']ui_reaction_role_sil["']/);
  assert.match(panel, /confirmProductAction\(\{\s*title:\s*t\(["']ui_giden_webhook_sil["']/);
  assert.doesNotMatch(panel, /data\.(?:error|message)|payload\.(?:error|message)|innerHTML/,
    'automation UI must keep backend diagnostics bounded and text rendering safe');
  assert.match(automod, /hasPermission\(perms, PERMS\.MANAGE_SERVER\)/);
  assert.match(reaction, /hasPermission\(perms, PERMS\.MANAGE_ROLES\)/);
  assert.match(reaction, /canManageRole\(_u\.id, roleId, sid\)/,
    'reaction-role creation must remain hierarchy-enforced');
  assert.match(hooks, /hasPermission\(perms, PERMS\.MANAGE_SERVER\)/);
  assert.match(hooks, /checkOutboundUrl\(normalizedUrl\)/,
    'outgoing webhook URL remains SSRF-checked by the server');
  assert.match(hooks, /Never expose the stored signing secret/,
    'stored webhook secrets must not be reflected back to the client');
});

test('P2 announcement messages expose one authoritative publish action across desktop and touch surfaces', () => {
  const list = read('client/js/core/MessageListPanel.svelte');
  const renderer = read('client/js/core/MessageRenderer.svelte');
  const routes = read('server/routes/announcement.ts');
  assert.match(list, /currentChannelType === 'announcement'/);
  assert.match(list, /\/api\/v1\/channels\/\$\{encodeURIComponent\(message\.channelId\)\}\/messages\/\$\{encodeURIComponent\(message\._id\)\}\/crosspost/);
  assert.match(list, /safeApiErrorMessage\(response,\s*t\(["']ui_duyuru_yayinlanamadi["']/);
  assert.match(renderer, /onCrosspost\?: \(message: MessageData\) => void/);
  assert.match(renderer, /id: 'crosspost'/,
    'touch action sheet must expose the same publish owner');
  assert.match(renderer, /t\(['"]announcement_publish_followers['"]/,
    'desktop action bar must expose announcement publish');
  assert.match(routes, /const canPublishOwn = String\(msg\.userId\) === me\.id && hasPermission\(sourcePerms, PERMS\.SEND_MESSAGES\)/);
  assert.match(routes, /hasPermission\(sourcePerms, PERMS\.MANAGE_MESSAGES\)/);
  assert.match(routes, /persistCrosspost\(/,
    'crosspost remains durable/idempotent server persistence, not a client-only broadcast');
});

test('P3 sticker messages use server-verified durable snapshots without mutating legacy sticker bytes', () => {
  const types = read('server/socket/handlers/messages-types.ts');
  const send = read('server/socket/handlers/messages-send.ts');
  const validate = read('server/middleware/validate.ts');
  const schema = read('server/db/postgres/schema.ts');
  const migration = read('server/db/migrations_pg/069_message_stickers.sql');
  const rollback = read('server/db/migrations_pg/rollback/069_message_stickers.down.sql');
  const pg = read('server/db/postgres/pgCollection.ts');
  const outbox = read('client/js/core/outbox-store.ts');
  const input = read('client/js/core/MessageInputPanel.svelte');
  const composerPolicy = read('client/js/core/message-composer-policy.ts');
  const panel = read('client/js/core/stickers/StickerPanel.svelte');
  const opener = read('client/js/core/stickers/StickerOpener.svelte');
  const renderer = read('client/js/core/MessageRenderer.svelte');

  assert.match(types, /stickerPackId\?: string;[\s\S]{0,120}stickerId\?: string;/);
  assert.match(validate, /enum: \['normal', 'file', 'sticker'\]/,
    'canonical message validation must recognize sticker as its own message kind');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS messages[\s\S]{0,900}sticker JSONB/,
    'fresh schema must persist sticker snapshots on messages rather than altering asset bytes');
  assert.match(migration, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker JSONB/);
  assert.match(migration, /messages_sticker_shape_check/);
  assert.match(rollback, /DROP COLUMN IF EXISTS sticker/);
  assert.match(pg, /JSONB_COLS[\s\S]{0,2600}'sticker'/,
    'PgCollection must serialize sticker JSONB instead of failing at runtime');
  assert.match(pg, /ALLOWED_COLUMNS[\s\S]{0,5200}'sticker'/,
    'message persistence whitelist must explicitly admit the canonical sticker column');

  assert.match(send, /findStickerPackByIdAndServer\(String\(stickerPackId\), serverId\)/,
    'pack lookup must remain tenant-scoped to the current server');
  assert.match(send, /findStickerItemByIdAndPack\(String\(stickerId\), String\(stickerPackId\)\)/,
    'item identity must be subordinate to the verified pack');
  assert.match(send, /if \(!pack \|\| !item \|\| !safeUrl\)[\s\S]{0,180}INVALID_STICKER_REFERENCE/,
    'corrupt or foreign references must fail closed');
  assert.match(send, /msgData\.sticker = stickerSnapshot/,
    'the durable row must store the server-created snapshot, never the client optimistic object');
  assert.match(send, /if \(type === 'file' \|\| type === 'sticker'\) continue/,
    'cross-server Bridge forwarding must not silently reinterpret sticker assets as text');

  assert.match(outbox, /OutboxMessageType = 'normal' \| 'file' \| 'sticker'/);
  assert.match(input, /messageType: 'sticker'/);
  assert.match(composerPolicy, /type: 'sticker', stickerPackId: entry\.stickerPackId, stickerId: entry\.stickerId/,
    'retries must send only canonical sticker identity through the existing ackId protocol');
  assert.match(input, /BridgeRegistry\.register\('sendSticker'/,
    'sticker selection must reuse the canonical message outbox owner');
  assert.match(panel, /t\(['"]sticker_send_named_aria['"], undefined, \{ name: st\.name \}\)/);
  assert.match(panel, /onerror=\{\(\) => markPreviewFailed\(st\.url\)\}/,
    'immutable legacy sticker payload failures must degrade to a controlled preview fallback');
  assert.match(panel, /class="sp-img-fallback"/);
  assert.match(opener, /BridgeRegistry\.call<boolean>\('sendSticker', sticker\) === true/);
  assert.match(renderer, /message\?\.type !== 'sticker'/);
  assert.match(renderer, /class="msg-sticker"/);
  assert.match(renderer, /stickerImageFailed = true/);
  assert.match(renderer, /class="msg-sticker-fallback"/,
    'message rendering must not expose a broken-image icon when immutable sticker bytes are invalid');
  assert.doesNotMatch(renderer, /\{@html\}/,
    'sticker names and metadata must remain text-rendered');
});

test('P3 screen-share system audio is opt-in, separately owned and never claimed from permission alone', () => {
  const p2p = read('client/js/webrtc.ts');
  const sfu = read('client/js/webrtc-sfu.ts');
  const voice = read('client/js/core/VoicePanel.svelte');
  const controller = read('client/js/core/VoiceScreenShareController.svelte');
  const server = read('server/socket/handlers/mediasoup/index.ts');

  assert.match(p2p, /startScreenShare\(quality: ScreenQuality = '1080p60', includeAudio = false\)/,
    'P2P system audio must remain explicit opt-in');
  assert.match(p2p, /_screenAudioTrack = this\.screenStream\.getAudioTracks\(\)\[0\] \?\? null/,
    'P2P must own the actually captured display audio track');
  assert.match(p2p, /_attachScreenAudioTo\(pc\)/,
    'P2P screen audio must be a separate peer track instead of replacing the microphone');

  assert.match(sfu, /screenAudioActive\s*= false/,
    'SFU manager must start from a fail-closed real-audio state');
  assert.match(sfu, /appData:\s*\{ screenAudio: true \}/,
    'SFU system audio must use a distinct producer identity');
  assert.match(sfu, /this\.producers\.set\('screen-audio', audioProducer\)/);
  assert.match(sfu, /this\._closeProducer\('screen-audio'\)/,
    'stopping share must close the screen-audio producer independently of microphone audio');
  assert.match(sfu, /_p2pAttachScreenTracks\(pc\)/,
    'SFU-capable manager must keep screen sharing functional when server SFU capability falls back to P2P');
  assert.match(sfu, /pc\.removeTrack\(sender\)/,
    'P2P fallback stop must remove only display senders and renegotiate without replacing the microphone');
  assert.match(sfu, /screenAudioTrack\.stop\(\)[\s\S]{0,160}screenAudioActive = false/,
    'failed audio publication must stop the otherwise-unused live system-audio capture');
  assert.match(sfu, /expectedKind = appData\?\.screenAudio \? 'screen-audio'/,
    'request-correlated SFU produce ACKs must distinguish screen audio from microphone audio');

  assert.match(server, /const isScreenAudio = appData\?\.screenAudio === true/);
  assert.match(server, /\(isScreenAudio && kind !== 'audio'\)/,
    'server must reject forged screen-audio metadata on non-audio producers');
  assert.match(server, /trackKind = isScreenAudio \? 'screen-audio'/,
    'server producer ownership must not collide with microphone or screen video');
  assert.match(server, /peer\.producers\.has\(trackKind\)/,
    'duplicate screen-audio publication must be rejected by canonical producer ownership');

  assert.match(voice, /id="ss-include-audio"/);
  assert.doesNotMatch(voice, /id="ss-include-audio" disabled/,
    'the production control may be enabled now that both canonical media owners have an honest path');
  assert.match(voice, /tarayıcı ve paylaşılan yüzeye bağlı/,
    'UI must explain that capture availability depends on browser/OS/surface');
  assert.match(controller, /const includeAudio = audioEl\?\.checked \?\? false/);
  assert.match(controller, /screenAudioActive\?: boolean/,
    'the controller must claim system audio only from actual captured/published state, not from the checkbox');
});

test('P3 marketplace installs only admin-bound executable public bots through authoritative server links', () => {
  const route = read('server/routes/bot-marketplace.ts');
  const repo = read('server/db/repositories/BotMarketplaceRepository.ts');
  const bots = read('server/db/repositories/BotRepository.ts');
  const migration = read('server/db/migrations_pg/070_marketplace_executable_bot.sql');
  const rollback = read('server/db/migrations_pg/rollback/070_marketplace_executable_bot.down.sql');
  const startup = read('server/db/postgres/migrations.ts');
  const api = read('client/js/core/bot-marketplace/bot-api.ts');
  const catalog = read('client/js/core/bot-marketplace/bot-catalog.ts');
  const panel = read('client/js/core/bot-marketplace/BotMarketplace.svelte');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "executableBotId" TEXT/);
  assert.match(migration, /FOREIGN KEY \("executableBotId"\) REFERENCES bots\(_id\) ON DELETE SET NULL/,
    'marketplace executable identity must be a database-owned bot reference, not a catalog slug');
  assert.match(rollback, /DROP COLUMN IF EXISTS "executableBotId"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_marketplace_executable/,
    'one executable bot must not be ambiguously represented by multiple marketplace listings');
  assert.match(startup, /ALTER TABLE bot_marketplace ADD COLUMN IF NOT EXISTS "executableBotId" TEXT/,
    'fresh/startup schema owner must receive the same executable binding');

  assert.match(route, /'executableBotId' in updateFields[\s\S]{0,700}bot\.active !== true \|\| bot\.isPublic !== true/,
    'only database admins may bind a catalog row, and the target must be active/public');
  assert.match(route, /router\.post\('\/:botId\/install'/);
  assert.match(route, /requireManageServer\(userId, serverId\)/,
    'install and removal must remain server-permission enforced');
  assert.match(route, /listing\?\.approved === true && typeof listing\.executableBotId === 'string'/,
    'unapproved or unbound catalog rows must never become executable installs');
  assert.match(route, /Bots\.findServerBot\(executableBotId, serverId\)/);
  // Final21 Phase 14: the install row also records the scopes the admin consented to.
  assert.match(route, /if \(!existing\)[\s\S]{0,320}Bots\.addToServer\(executableBotId, serverId, userId, requested\.scopes\)[\s\S]{0,260}23505/,
    'retries and concurrent installs must converge on the unique target state instead of surfacing false failure');
  assert.match(route, /Server-owned bot cannot be removed as a marketplace install/,
    'marketplace removal must not delete or disguise a server-owned bot');
  assert.match(bots, /removeFromServer\(botId: string, serverId: string\)/);
  assert.match(repo, /JOIN bots b ON b\._id = m\."executableBotId" AND b\.active = TRUE/,
    'installed state must be derived from executable bot identity, not browser-local state');
  assert.match(repo, /syncInstallCount\(executableBotId: string\)/);

  assert.match(catalog, /installable: row\.installable === true/);
  assert.match(api, /\/api\/bots\/marketplace\/installed\?serverId=/);
  assert.match(api, /installBotOnServer\(botId: string, serverId: string, acceptedPermissions: readonly string\[\]\)/);
  assert.match(api, /uninstallBotFromServer\(botId: string, serverId: string\)/);
  assert.match(panel, /fetchInstallState\(sid\)/);
  assert.match(panel, /hasPerm\(perms, PERM_MANAGE_SERVER\)/,
    'client controls should fail closed when current server management permission is absent');
  assert.match(panel, /confirmProductAction\(\{\s*title:\s*t\(["']ui_botu_kaldir["']/,
    'destructive uninstall must use the canonical product confirmation');
  assert.match(panel, /safeApiErrorMessage\(cause,\s*next\s*\?\s*t\(["']ui_bot_kurulamadi["'][\s\S]{0,100}:\s*t\(["']ui_bot_kaldirilamadi["']/,
    'failed install/uninstall must not render raw backend diagnostics or false success');
  assert.doesNotMatch(panel, /toggleInstalledLocal/,
    'browser-local installed state must not be the product authority');
});


test('10/10 marketplace executable surface and global admin owner are production-reachable with correct authority', () => {
  const app = read('client/js/app.ts');
  const palette = read('client/js/core/CommandPalettePanel.svelte');
  const shim = read('client/js/core/bot-marketplace/bot-marketplace-svelte.ts');
  const coordinator = read('client/js/core/exclusive-surface.ts');

  assert.match(app, /import '\.\/core\/bot-marketplace\/bot-marketplace-svelte\.ts'/,
    'canonical executable marketplace owner must be bundled');
  assert.match(app, /import '\.\/admin\/admin-launcher\.ts'/,
    'lightweight site-admin owner must be bundled when the command palette exposes it');
  assert.match(shim, /import\('\.\/BotMarketplace\.svelte'\)/);
  assert.match(shim, /import\('svelte'\)/);
  assert.match(shim, /BridgeRegistry\.register\('openMarketplacePage', openBotMarketplace\)/);
  assert.match(shim, /closeExclusivePeers\('marketplace'\)/);
  assert.match(coordinator, /marketplace:\s*'closeBotMarketplace'/,
    'marketplace must participate in the top-level exclusive surface lifecycle');
  assert.match(palette, /available: \(\) => BridgeRegistry\.has\('openAdminDashboard'\) && currentUserIsSiteAdmin\(\)/,
    'global Admin Panel visibility must use the global site-admin identity, not a server permission bit');
  assert.match(palette, /return user\?\.isAdmin === true/);
  assert.doesNotMatch(palette, /openAdminDashboard'\) && permissionBits !== null && hasPerm\(permissionBits, PERM_MANAGE_SERVER\)/,
    'MANAGE_SERVER must not expose global /api/admin tooling');
});


test('10/10 marketplace keyboard semantics use one Escape owner and an accessible roving tablist', () => {
  const panel = read('client/js/core/bot-marketplace/BotMarketplace.svelte');
  const standalone = read('client/js/plugin-marketplace-page.ts');
  assert.match(panel, /window\.addEventListener\('keydown', onKey\)/);
  assert.match(panel, /window\.removeEventListener\('keydown', onKey\)/);
  assert.doesNotMatch(panel, /use:focusTrap=\{\{ initialFocus: '\.mp-search' \}\}[\s\S]{0,120}onkeydown=\{onKey\}/,
    'root dialog must not run the same Escape handler again while the window owner is active');
  assert.doesNotMatch(panel, /use:focusTrap=\{\{ initialFocus: '\.mp-det-cls' \}\}[\s\S]{0,120}onkeydown=\{onKey\}/,
    'detail dialog Escape must not bubble through a duplicate local owner and close both layers');
  assert.match(panel, /aria-selected=\{activeTab === tab\.id\}/);
  assert.match(panel, /tabindex=\{activeTab === tab\.id \? 0 : -1\}/);
  assert.match(panel, /e\.key === 'ArrowRight'/);
  assert.match(panel, /e\.key === 'ArrowLeft'/);
  assert.match(panel, /e\.key === 'Home'/);
  assert.match(panel, /e\.key === 'End'/);
  assert.doesNotMatch(standalone, /executable transport sözleşmesine bağlı değildir/,
    'standalone discovery page must not contradict the executable marketplace contract');
});


test('10/10 dismissible canonical dialogs provide keyboard Escape without weakening call safety', () => {
  const events = read('client/js/core/ServerEventsPanel.svelte');
  const polls = read('client/js/core/PollsPanel.svelte');
  const admin = read('client/js/admin/AdminPanel.svelte');
  const dmCall = read('client/js/core/DmCallPanel.svelte');
  assert.match(events, /events-panel[^>]+onkeydown=\{\(e\) => \{ if \(e\.key === 'Escape'\)/,
    'server events dialog needs keyboard dismissal');
  assert.match(polls, /polls-panel[^>]+onkeydown=\{\(e\) => \{ if \(e\.key === 'Escape'\)/,
    'polls dialog needs keyboard dismissal');
  assert.match(admin, /admin-overlay[^>]+onkeydown=\{\(e\) => \{ if \(e\.key === 'Escape'\)/,
    'site admin dialog needs keyboard dismissal');
  assert.doesNotMatch(dmCall, /dm-call-overlay[^>]+onkeydown=\{[^}]*Escape/,
    'Escape must not silently terminate or reject an active DM call');
});


test('10/10 marketplace startup degrades safely instead of hanging on partial API failure', () => {
  const panel = read('client/js/core/bot-marketplace/BotMarketplace.svelte');
  assert.match(panel, /async function initializeMarketplace\(\): Promise<void>/);
  assert.match(panel, /Promise\.allSettled\(\[loadCatalog\(\), fetchLoadedPlugins\(\), loadInstallState\(\)\]\)/,
    'catalog/plugin/install startup must settle independently');
  assert.match(panel, /safeApiErrorMessage\(catalogFailure,\s*t\(["']ui_bot_katalogu_yuklenemedi_tekrar_deneyebilirsin["']/);
  assert.match(panel, /safeApiErrorMessage\(pluginFailure,\s*t\(["']ui_plugin_listesi_yuklenemedi["']/);
  assert.match(panel, /ready = true/,
    'startup must leave the loading state even when a secondary dependency fails');
  assert.match(panel, /onclick=\{\(\) => void initializeMarketplace\(\)\}>\{t\(['"]retry['"]\)\}<\/button>/,
    'recoverable marketplace load failures need an explicit retry affordance');
  assert.doesNotMatch(panel, /Promise\.all\(\[loadCatalog\(\), fetchLoadedPlugins\(\), loadInstallState\(\)\]\)\.then/,
    'unhandled all-or-nothing startup must not return');
});


test('10/10 SSO settings distinguish unavailable configuration from a genuinely disabled provider', () => {
  const sso = read('client/js/core/server-settings/tabs/SsoTab.svelte');
  assert.match(sso, /let loadError = \$state\(false\)/);
  assert.match(sso, /async function loadConfig\(\): Promise<void>/);
  assert.match(sso, /if \(!response\.ok\) throw new Error\(`SSO config HTTP \$\{response\.status\}`\)/);
  assert.match(sso, /loadError = true/);
  assert.match(sso, /Bu, özelliklerin kapalı olduğu anlamına gelmez\./,
    'network/config failure must not masquerade as OIDC/SAML being disabled');
  assert.match(sso, /onclick=\{\(\) => void loadConfig\(\)\}>\{t\(['"]retry['"]\)\}<\/button>/);
  assert.doesNotMatch(sso, /\.catch\(\(\) => \(\{\}\)\)/,
    'SSO load failures must not collapse into a false empty configuration');
});


test('10/10 standalone marketplace modal uses the canonical focus trap lifecycle', () => {
  const page = read('client/js/plugin-marketplace-page.ts');
  assert.match(page, /import \{ focusTrap \} from '\.\/core\/a11y\/focusTrap\.ts'/);
  assert.match(page, /modalTrap = focusTrap\(modal, \{ active: true, initialFocus: '\[data-bridge-action="closeMktModal"\]' \}\)/,
    'standalone aria-modal surface must trap focus through the canonical owner');
  assert.match(page, /modalTrap\?\.destroy\(\);[\s\S]{0,80}modalTrap = null/,
    'closing the standalone modal must release the trap and return focus');
  assert.doesNotMatch(page, /modal\.focus\(\)/,
    'raw container focus must not replace full keyboard containment');
});


test('10/10 marketplace search, sort and tab controls expose accessible names', () => {
  const panel = read('client/js/core/bot-marketplace/BotMarketplace.svelte');
  assert.match(panel, /id="mp-search"[^>]*aria-label=\{t\(['"]attr_bot_ara_0294678['"]/);
  assert.match(panel, /class="mp-sort"[^>]*aria-label=\{t\(['"]market_sort_bots['"]/);
  assert.match(panel, /class="mp-tabs" role="tablist" aria-label=\{t\(['"]market_view['"]/);
});


test('10/10 heavy admin and marketplace surfaces remain reachable without inflating the initial app chunk', () => {
  const app = read('client/js/app.ts');
  const adminLauncher = read('client/js/admin/admin-launcher.ts');
  const adminMount = read('client/js/admin/admin-svelte.ts');
  const marketplaceShim = read('client/js/core/bot-marketplace/bot-marketplace-svelte.ts');

  assert.match(app, /import '\.\/admin\/admin-launcher\.ts'/);
  assert.doesNotMatch(app, /import '\.\/admin\/admin-svelte\.ts'/,
    'heavy AdminPanel mount owner must not be eagerly imported by app.ts');
  assert.match(adminLauncher, /import\('\.\/admin-svelte\.ts'\)/,
    'admin panel must lazy-load on first explicit open');
  assert.match(adminMount, /import AdminPanel from '\.\/AdminPanel\.svelte'/,
    'lazy admin mount module remains the canonical component owner');
  assert.doesNotMatch(marketplaceShim, /^import BotMarketplace/m,
    'marketplace component must not be statically pulled into the initial graph');
  assert.match(marketplaceShim, /import\('\.\/BotMarketplace\.svelte'\)/);
  assert.match(marketplaceShim, /generation !== myGeneration/,
    'closing while a lazy marketplace import is pending must prevent stale mount');
});


test('10/10 standalone marketplace uses the canonical authenticated HTTP owner', () => {
  const page = read('client/js/plugin-marketplace-page.ts');
  assert.match(page, /import \{ apiFetch \} from '\.\/core\/api-fetch\.ts'/,
    'standalone authenticated marketplace must share refresh, cookie and CSRF semantics');
  assert.match(page, /const res = await apiFetch<T>\(`\$\{API\}\$\{path\}`, opts\)/);
  assert.doesNotMatch(page, /localStorage\.getItem\(['\"]token['\"]\)/,
    'standalone product pages must not create a second token owner');
  assert.doesNotMatch(page, /await fetch\(`\$\{API\}\$\{path\}`/,
    'authenticated marketplace API calls must not bypass canonical apiFetch');
});


test('10/10 health settings never turn malformed responses into a false unavailable service state', () => {
  const health = read('client/js/core/server-settings/tabs/HealthTab.svelte');
  assert.match(health, /body = await response\.json\(\)/,
    'health payload parsing must remain explicit');
  assert.match(health, /Sistem durumu yanıtı doğrulanamadı\. Tekrar deneyebilirsin\./,
    'malformed health payloads need a truthful retryable error state');
  assert.match(health, /candidate\.services\.every\(\(service\) => service/,
    'service rows must be validated before rendering operational labels');
  assert.match(health, /validStates\.has\(candidate\.overall as State\)/,
    'overall state must come from the bounded server contract');
  assert.doesNotMatch(health, /response\.json\(\)\.catch\(\(\) => \(\{\}\)\)/,
    'parse failure must not collapse into an empty payload that looks like a real health result');
});


test('10/10 announcement crosspost and message report require valid 2xx response contracts before success', () => {
  const messages = read('client/js/core/MessageListPanel.svelte');
  assert.match(messages, /payload\?\.ok !== true \|\| !Number\.isSafeInteger\(payload\.crosspostedTo\)/,
    'crosspost success must validate the authoritative result payload');
  assert.match(messages, /Duyuru yanıtı doğrulanamadı\. Tekrar deneyin\./);
  assert.match(messages, /data\?\.reported !== true \|\| typeof data\.created !== 'boolean'/,
    'report success must validate reported\/created identity instead of treating malformed 2xx as success');
  assert.match(messages, /Rapor yanıtı doğrulanamadı\. Tekrar deneyin\./);
  assert.doesNotMatch(messages, /response\.json\(\)\.catch\(\(\) => \(\{\}\)\) as \{ created\?: boolean \}/);
});

test('10/10 permission explainability rejects malformed or cross-context 2xx payloads', () => {
  const store = read('client/js/core/channel-perms/channelPermsStore.ts');
  assert.match(store, /function isPermissionExplanationResponse\(value: unknown\): value is PermissionExplanationResponse/);
  assert.match(store, /!isPermissionExplanationResponse\(data\) \|\| data\.channelId !== channelId/,
    'permission trace must remain bound to the selected channel');
  assert.match(store, /explanationError = t\(['"]perm_explanation_invalid['"]\)/);
  assert.doesNotMatch(store, /res\.json\(\)\.catch\(\(\) => \(\{\}\)\) as PermissionExplanationResponse/);
});

test('10/10 role preview rejects malformed or wrong-role 2xx payloads', () => {
  const store = read('client/js/core/channel-perms/channelPermsStore.ts');
  assert.match(store, /function isRolePreviewResponse\(value: unknown\): value is RolePreviewResponse/);
  assert.match(store, /!isRolePreviewResponse\(data\) \|\| data\.role\.id !== roleId/,
    'role simulation must remain bound to the role the user requested');
  assert.match(store, /rolePreviewError = t\(['"]perm_role_preview_invalid['"]\)/);
  assert.doesNotMatch(store, /res\.json\(\)\.catch\(\(\) => \(\{\}\)\) as RolePreviewResponse/);
});

test('10/10 marketplace resets recoverable errors and permission state when server context changes', () => {
  const panel = read('client/js/core/bot-marketplace/BotMarketplace.svelte');
  assert.match(panel, /async function initializeMarketplace\(\): Promise<void> \{[\s\S]{0,120}ready = false;[\s\S]{0,80}installError = '';/,
    'a successful retry must not leave a stale marketplace error visible');
  assert.match(panel, /function onServerContextChange\(\): void \{[\s\S]{0,180}installedIds = new Set\(\);[\s\S]{0,80}canManage = false;[\s\S]{0,120}void loadInstallState\(\);/,
    'server switches must clear old install/permission truth before reloading');
  assert.match(panel, /document\.addEventListener\('bridge:load-channels', onServerContextChange\)/);
  assert.match(panel, /document\.removeEventListener\('bridge:load-channels', onServerContextChange\)/,
    'server-context listener must be lifecycle-owned');
});

test('10/10 transient UI timers cannot write component state after teardown', () => {
  const dmCall = read('client/js/core/DmCallPanel.svelte');
  const privacy = read('client/js/core/settings/tabs/PrivacyTab.svelte');
  assert.match(dmCall, /let _endedResetTimer: ReturnType<typeof setTimeout> \| null/);
  assert.match(dmCall, /if \(_endedResetTimer\) \{ clearTimeout\(_endedResetTimer\); _endedResetTimer = null; \}/,
    'DM call cleanup must own the ended-state timer');
  assert.match(privacy, /let savedResetTimer: ReturnType<typeof setTimeout> \| null = null/);
  assert.match(privacy, /onDestroy\(\(\) => \{[\s\S]{0,120}clearTimeout\(savedResetTimer\)/,
    'privacy saved-state timer must be cancelled on unmount');
});

test('10/10 active navigation and filter controls expose their selected state to assistive technology', () => {
  const inbox = read('client/js/core/InboxPanel.svelte');
  const friends = read('client/js/core/FriendsPanel.svelte');
  const events = read('client/js/core/ServerEventsPanel.svelte');
  const forum = read('client/js/core/ForumChannelPanel.svelte');
  const discover = read('client/js/core/DiscoverPanel.svelte');
  const marketplace = read('client/js/core/bot-marketplace/BotMarketplace.svelte');
  const dm = read('client/js/core/DmPanel.svelte');
  assert.match(inbox, /aria-pressed=\{filter === 'all'\}/);
  assert.match(friends, /role="tablist"[^>]+Arkadaş filtreleri/);
  assert.match(friends, /role="tab"[^>]+aria-selected=\{tab==='online'\}/);
  assert.match(events, /aria-pressed=\{filter === value\}/);
  assert.match(forum, /aria-pressed=\{sort === 'latest'\}/);
  assert.match(discover, /aria-pressed=\{tab === id\}/);
  assert.match(discover, /aria-pressed=\{category === cat\.id\}/);
  assert.match(marketplace, /aria-pressed=\{activeCategory === cat\.id\}/);
  assert.match(dm, /aria-current=\{active\?\._id === conversation\._id \? 'page' : undefined\}/);
});

test('10/10 maintainability keeps normalization, composer policy and screen-share quality in dedicated pure owners', () => {
  const group = read('client/js/core/GroupDmPanel.svelte');
  const groupNormalize = read('client/js/core/group-dm-normalize.ts');
  const composer = read('client/js/core/MessageInputPanel.svelte');
  const composerUtils = read('client/js/core/message-input-utils.ts');
  const p2p = read('client/js/webrtc.ts');
  const sfu = read('client/js/webrtc-sfu.ts');
  const screen = read('client/js/core/rtc-screen-quality.ts');

  assert.match(group, /from '\.\/group-dm-normalize\.ts'/);
  assert.doesNotMatch(group, /function normalizeGdmMessages\(/);
  assert.match(groupNormalize, /export function normalizeGdmMessages\(/);
  assert.match(groupNormalize, /export function normalizeGdmGroups\(/);

  assert.match(composer, /from '\.\/message-input-utils\.ts'/);
  assert.doesNotMatch(composer, /function uploadErrorText\(/);
  assert.match(composerUtils, /export function uploadErrorText\(/);
  assert.match(composerUtils, /export function safeScheduledRow\(/);

  assert.match(p2p, /rtc-screen-quality\.ts/);
  assert.match(sfu, /rtc-screen-quality\.ts/);
  assert.doesNotMatch(p2p, /const SCREEN_PRESETS:/);
  assert.doesNotMatch(sfu, /const SCREEN_PRESETS:/);
  assert.match(screen, /export const SCREEN_BITRATES/);
  assert.match(screen, /export function normalizeScreenQuality/);
});

test('production i18n exposes ten fully stable locales and CI enforces quality', () => {
  const index = read('client/js/core/i18n/index.ts');
  const checker = read('scripts/check-i18n-parity.js');
  const workflow = read('.github/workflows/quality-gate.yml');
  const readme = read('README.md');

  for (const locale of ['tr', 'en', 'es', 'ru', 'ja', 'ko', 'zh', 'pt', 'de', 'fr']) {
    assert.equal(fs.existsSync(path.join(ROOT, `client/js/core/i18n/${locale}.ts`)), true,
      `stable production locale missing: ${locale}`);
    assert.match(index, new RegExp(`\\b${locale}:`));
  }
  assert.match(index, /export type LocaleStatus = 'stable' \| 'beta'/);
  assert.match(index, /LOCALE_STATUS: Record<Locale, LocaleStatus>/);
  for (const locale of ['tr', 'en', 'es', 'ru', 'ja', 'ko', 'zh', 'pt', 'de', 'fr']) {
    assert.match(index, new RegExp(`\\b${locale}:\\s*'stable'`));
  }
  assert.match(checker, /const LANGS = \['tr', 'en', 'es', 'ru', 'ja', 'ko', 'zh', 'pt', 'de', 'fr'\]/);
  assert.match(checker, /placeholder uyuşmazlığı/);
  assert.match(checker, /MAX_IDENTICAL_RATIO/);
  assert.match(workflow, /npm run check:i18n/);
  assert.match(readme, /10 stable production language packs/i);
  assert.doesNotMatch(readme, /15 dil desteği/);
});

test('OpenAPI artifacts are version-coherent and validation is a CI gate', () => {
  const version = JSON.parse(read('package.json')).version;
  const openapi = read('docs/api/openapi.yaml');
  const swagger = read('server/lib/swagger.ts');
  const validator = read('scripts/validate-openapi.js');
  const contract = read('scripts/openapi-contract.js');
  const workflow = read('.github/workflows/quality-gate.yml');

  assert.match(openapi, new RegExp(`version:\\s*${version.replaceAll('.', '\\.')}`));
  assert.doesNotMatch(openapi, /version:\s*1\.115\.0/);
  assert.match(swagger, /import runtimeSpec from '\.\.\/generated\/openapi\.json'/);
  assert.match(swagger, /const BASE_SPEC: OpenApiSpec = asOpenApiSpec\(runtimeSpec\)/);
  assert.doesNotMatch(swagger, /(?:from\s+['"]swagger-jsdoc['"]|require\(['"]swagger-jsdoc['"]\))/, 'production docs must not import runtime source-scanning dependencies');
  assert.match(validator, /Runtime OpenAPI snapshot/);
  // SwaggerParser.validate() dereferences its argument IN PLACE. Passing the
  // canonical object straight in left the snapshot comparison below comparing a
  // dereferenced spec against the raw generated file, so the drift gate could
  // never pass — it was dead code hiding behind an earlier schema failure.
  assert.match(validator, /SwaggerParser\.validate\(structuredClone\(spec\)\)/);
  assert.match(validator, /const canonicalJson = JSON\.stringify\(spec\)/);
  assert.doesNotMatch(validator, /SwaggerParser\.validate\(spec\)/);
  assert.match(contract, /OpenAPI info\.version drift/);
  assert.match(workflow, /npm run validate:openapi/);
});

test('canonical OpenAPI spec satisfies the structural contracts the meta-schema misses', () => {
  const { loadCanonicalSpec, structuralErrors, annotationErrors } = require(path.join(ROOT, 'scripts/openapi-contract.js'));
  const { spec, coverage } = loadCanonicalSpec(ROOT);

  // Regression guard for the 1.125.0 tree, where docs/api/openapi.yaml carried
  // 16 component schemas nested inside a path item, 29 responses without the
  // required `description`, 3 responses shredded by an unquoted flow mapping,
  // and 24 paths that repeated the /api prefix already in servers[].url.
  assert.deepEqual(structuralErrors(spec), []);
  assert.deepEqual(annotationErrors(ROOT), []);

  for (const server of spec.servers || []) {
    assert.match(server.url, /\/api$/, `servers[].url must end in /api: ${server.url}`);
  }
  for (const pathKey of Object.keys(spec.paths || {})) {
    assert.equal(pathKey.startsWith('/api/'), false, `documented path double-prefixes /api: ${pathKey}`);
  }

  const operationIds = new Set();
  for (const item of Object.values(spec.paths || {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!/^(?:get|post|put|patch|delete|options|head|trace)$/i.test(method)) continue;
      if (!op.operationId) continue;
      assert.equal(operationIds.has(op.operationId), false, `duplicate operationId: ${op.operationId}`);
      assert.doesNotMatch(op.operationId, /_api_/, `operationId still encodes the redundant /api prefix: ${op.operationId}`);
      operationIds.add(op.operationId);
    }
  }
  assert.ok(coverage.documentedOperations >= coverage.handlers);
});

test('the generated production HTML and service worker stay in sync with hardened source', () => {
  const source = read('client/index.html');
  const dist = read('client/index.dist.html');
  const sw = read('client/sw.js');

  // The shipped 1.125.0 tree carried a STALE client/index.dist.html: the source
  // had already moved the auth shell to delegated `data-auth-tab` actions so the
  // CSP needs neither unsafe-inline nor unsafe-hashes, but the generated file
  // still contained 8 `onclick=` and 3 `onkeydown=` attributes. The contract
  // covering the source therefore proved nothing about what a built deployment
  // actually serves.
  assert.match(source, /data-auth-tab="login"/);
  assert.match(dist, /data-auth-tab="login"/);
  for (const handler of ['onclick=', 'onkeydown=', 'onsubmit=', 'onchange=', 'oninput=']) {
    assert.equal(dist.includes(handler), false, `client/index.dist.html contains inline ${handler}`);
  }

  // client/sw.js is the COMPILED output of client/sw.ts. The shipped copy was
  // the unminified intermediate, complete with TypeScript reference directives.
  assert.equal(sw.includes('/// <reference'), false, 'client/sw.js is not the minified build output');
  assert.equal(sw.includes('// client/sw.ts'), false, 'client/sw.js is not the minified build output');
});

test('application state machines are keyed on literals, never on translated text', () => {
  const security = read('client/js/core/settings/tabs/SecurityTab.svelte');
  const checker = read('scripts/check-i18n-hardcoded.js');

  // The 2FA tab used `asama = t("surface_yenile_00502a")` on one side and
  // `asama === t("surface_yenile_00502a")` on the other. Both sides agreed only
  // as long as the locale never changed: switching language mid-flow left the
  // stored (old-locale) value unmatched and the backup-code screen rendered
  // nothing. Application state must be a literal union member.
  assert.match(security, /type Asama = .*'yenile'/);
  assert.match(security, /asama = 'yenile';/);
  assert.match(security, /\{:else if asama === 'yenile'\}/);
  assert.doesNotMatch(security, /asama\s*=\s*t\(/);
  assert.doesNotMatch(security, /asama\s*===\s*t\(/);

  // The hardcoded-string gate must not push state tokens through i18n — that
  // pressure is what produced the defect above.
  assert.match(checker, /APPLICATION STATE IS NOT PRODUCT CHROME/);
  assert.match(checker, /isComparisonOperand/);
  assert.match(checker, /isHandlerAssignment/);
});

test('the Helm chart references only templates that exist', () => {
  const templateDir = path.join(ROOT, 'k8s/helm/bridge/templates');
  const present = new Set(fs.readdirSync(templateDir));
  const referenced = new Set();
  for (const file of fs.readdirSync(templateDir)) {
    const source = fs.readFileSync(path.join(templateDir, file), 'utf8');
    // `include (print $.Template.BasePath "/name.yaml")` — a missing name is a
    // RENDER-TIME error, so `helm template/install` fails for the whole chart.
    for (const match of source.matchAll(/\$\.Template\.BasePath\s+"\/([^"]+)"/g)) referenced.add(match[1]);
  }
  assert.ok(referenced.size > 0, 'expected at least one BasePath template reference');
  const missing = [...referenced].filter((name) => !present.has(name));
  assert.deepEqual(missing, []);
});

test('the Kubernetes release tree ships no self-declared deprecated manifest', () => {
  const dir = path.join(ROOT, 'k8s');
  const kustomization = read('k8s/kustomization.yaml');
  const offenders = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.yaml') || file === 'kustomization.yaml') continue;
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const deprecated = /ARTIK KULLANILMIYOR|DEPRECATED|artik kullanilmaz/i.test(source);
    if (deprecated && !kustomization.includes(`- ${file}`)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
  assert.equal(fs.existsSync(path.join(dir, 'secret.yaml')), false,
    'k8s/secret.yaml was superseded by sealed-secret.yaml and must not ship');
  assert.doesNotMatch(read('k8s/README.md'), /cp secret\.yaml/);
});

// ── Final21 Faz 10 — F21-10-01 ───────────────────────────────────────────────
// Socket.IO istemcisi WebSocket engellenince UZUN YOKLAMAYA düşer ve uzun
// yoklamada bir oturumun tüm istekleri AYNI sunucuya gitmelidir. İki gerçek
// Bridge örneği (aynı PostgreSQL + Redis) önünde yapışkan olmayan bir vekille
// ÖLÇÜLDÜ: 25 sn'de HİÇ bağlanamadı, 86 x HTTP 400 "Session ID unknown";
// yapışkan vekille 13/13. Bu test iddiayı KOŞULA bağlar: istemci yoklamaya
// düşebiliyor VE dağıtım birden fazla replika çalıştırıyorsa, her ingress
// çerez yapışkanlığı taşımak ZORUNDADIR.
test('multi-replica Kubernetes ingresses pin Socket.IO polling sessions to one pod', () => {
  const socketManager = read('client/js/core/SocketManager.svelte');
  const clientCanPoll = /transports:\s*\[[^\]]*'polling'[^\]]*\]/.test(socketManager);
  const manifestReplicas = Number(/replicas:\s*(\d+)/.exec(read('k8s/bridge.yaml'))?.[1] ?? 1);
  const hpaMin = Number(/minReplicas:\s*(\d+)/.exec(read('k8s/hpa.yaml'))?.[1] ?? 1);
  const values = read('k8s/helm/bridge/values.yaml');
  const helmReplicas = Number(/^replicaCount:\s*(\d+)/m.exec(values)?.[1] ?? 1);

  // Önkoşulların kendisi de kilitlidir: biri değişirse bu test yeniden düşünülmeli.
  assert.equal(clientCanPoll, true, 'istemci artik yoklamaya dusmuyor — testi yeniden degerlendirin');
  assert.ok(Math.max(manifestReplicas, hpaMin, helmReplicas) > 1, 'tek replika — yapiskanlik gereksiz olabilir');

  const ingress = read('k8s/ingress.yaml');
  for (const [name, source] of [['k8s/ingress.yaml', ingress], ['k8s/helm/bridge/values.yaml', values]]) {
    assert.match(source, /nginx\.ingress\.kubernetes\.io\/affinity:\s*"cookie"/, `${name} cerez yapiskanligi tasimiyor`);
    assert.match(source, /nginx\.ingress\.kubernetes\.io\/session-cookie-name:\s*"[^"]+"/, `${name} oturum cerezi adi yok`);
  }
  // Güncel ingress-nginx snippet açıklamalarını varsayılan olarak reddeder.
  // Yalnızca GERÇEK açıklama anahtarı aranır (yorumdaki açıklama metni değil).
  assert.doesNotMatch(ingress, /^\s*nginx\.ingress\.kubernetes\.io\/configuration-snippet:/m);
});

// ── Final21 Faz 10 — F21-10-02 ───────────────────────────────────────────────
// Yükleme deposu varsayılan olarak yerel disktir ve `uploads` pod başına
// `emptyDir`dir. İki gerçek örnek önünde ÖLÇÜLDÜ: A'ya yüklenen avatar B'de 404,
// B aynı URL'yi kullanıcıya veriyordu. Çok replikalı her dağıtım yolu bu
// yapılandırmayı SESSİZCE kuramamalıdır:
//   · Helm: render anında `fail` (9 satırlık karar matrisi helm template ile doğrulandı)
//   · kustomize: `BRIDGE_MULTI_NODE=true` → uygulama üretimde açılışı reddeder
//     (derlenmiş ikiliyle doğrulandı: bayraksız 0 hata ve açılır, bayrakla tek hata)
test('multi-replica Kubernetes deployments cannot silently use node-local uploads', () => {
  const helpers = read('k8s/helm/bridge/templates/_helpers.tpl');
  const deployment = read('k8s/helm/bridge/templates/deployment.yaml');
  assert.match(helpers, /define "bridge\.validateUploadStorage"/);
  assert.match(helpers, /fail "bridge: multi-replica deployment with node-local uploads/);
  assert.match(helpers, /PRIVATE_STORAGE_PROVIDER/, 'ozel ekler genel CDN uzak olsa bile yerel kalir; ikisi de denetlenmeli');
  assert.match(helpers, /ReadWriteMany/);
  assert.match(deployment, /include "bridge\.validateUploadStorage" \./);

  const manifestReplicas = Number(/replicas:\s*(\d+)/.exec(read('k8s/bridge.yaml'))?.[1] ?? 1);
  const hpaMin = Number(/minReplicas:\s*(\d+)/.exec(read('k8s/hpa.yaml'))?.[1] ?? 1);
  if (Math.max(manifestReplicas, hpaMin) > 1) {
    const configmap = read('k8s/configmap.yaml');
    const hasRemote = /^\s*CDN_PROVIDER:\s*"(s3|r2|minio|b2)"/m.test(configmap)
      && /^\s*PRIVATE_STORAGE_PROVIDER:\s*"(s3|r2|minio|b2)"/m.test(configmap);
    assert.ok(hasRemote || /^\s*BRIDGE_MULTI_NODE:\s*"true"/m.test(configmap),
      'cok replikali kustomize dagitimi ne uzak depolama ne de BRIDGE_MULTI_NODE ilani tasiyor');
  }

  const env = read('server/lib/env.ts');
  assert.match(env, /sharedUploadStorageProblem\(process\.env\)/);
});

// ── Final21 Faz 10 — F21-10-03 ───────────────────────────────────────────────
// docs/REDIS_PRODUCTION.md `noeviction` ister; dört dağıtım dosyası
// `allkeys-lru` gönderiyordu. redis:8-alpine (maxmemory 4mb) ile ÖLÇÜLDÜ:
// arama sınırı doldu (429), bellek baskısı iki hız sınırı anahtarını da tahliye
// etti ve aynı dakikada 5/5 arama 200 döndü. `noeviction` ile aynı adımlarda
// anahtarlar kaldı, 5/5 429. `volatile-*` de güvenli DEĞİLDİR: hız sınırı
// sayaçları TTL taşır, yani "volatile"dir.
test('shipped Redis deployments never evict authoritative rate-limit and CSRF keys', () => {
  const files = ['k8s/redis.yaml', 'docker-compose.yml', 'docker-compose.cluster.yml', 'docker-compose.prod.yml'];
  const policies = [];
  for (const file of files) {
    const source = read(file).split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    const found = [...source.matchAll(/maxmemory-policy["',\s]+([a-z-]+)/g)].map((m) => m[1]);
    assert.ok(found.length > 0, `${file} maxmemory-policy tasimiyor (politika acik olmali)`);
    for (const policy of found) policies.push(`${file}:${policy}`);
  }
  assert.deepEqual(policies.filter((entry) => !entry.endsWith(':noeviction')), []);
  assert.match(read('docs/REDIS_PRODUCTION.md'), /`maxmemory-policy` \| `noeviction`/);
});

// ── Final21 Faz 19 — F21-10-04 ───────────────────────────────────────────────
// Redis hız sınırı, CSRF, oturum iptali ve soket durumunun YETKİLİ deposudur ama kustomize,
// Helm ve üretim compose'u onu PAROLASIZ çalıştırıyordu (üretim rehberi `requirepass` ister);
// veri depolarına ağ düzeyinde erişim sınırı da yoktu. Üretim compose'undaki Redis ayrıca
// `cap_drop: ALL` yüzünden hiç AÇILMIYORDU (Permission denied, sürekli yeniden başlatma).
// Canlı kanıt: tools/p19-redis-auth-proof.sh, p19-k8s-rendered-redis-run.cjs,
// p19-compose-redis-proof.sh. Bu test o düzenin geri alınmasını engeller.
test('shipped Redis requires a password that never appears in process arguments; data stores are network-scoped', () => {
  const yaml = require(path.join(ROOT, 'node_modules/js-yaml'));
  const strip = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

  // kustomize
  const redis = yaml.loadAll(read('k8s/redis.yaml')).find((d) => d && d.kind === 'Deployment');
  const c = redis.spec.template.spec.containers[0];
  const script = [...(c.command ?? []), ...(c.args ?? [])].join(' ');
  assert.match(script, /redis-server - [^\n]*<<EOF\s+requirepass \$REDIS_PASSWORD\s+EOF/, 'config via stdin, password from env');
  assert.doesNotMatch(script, /--requirepass/, 'a --requirepass argument is readable with ps');
  assert.deepEqual(c.env.find((e) => e.name === 'REDIS_PASSWORD').valueFrom.secretKeyRef, { name: 'bridge-secrets', key: 'REDIS_PASSWORD' });
  assert.match(c.readinessProbe.exec.command.join(' '), /REDISCLI_AUTH="\$REDIS_PASSWORD" redis-cli ping \| grep -q PONG/);
  assert.match(read('k8s/kustomization.yaml'), /^\s+- networkpolicy\.yaml/m);
  const policies = yaml.loadAll(read('k8s/networkpolicy.yaml')).filter(Boolean);
  const scoped = Object.fromEntries(policies.map((p) => [p.spec.podSelector.matchLabels.app, {
    types: p.spec.policyTypes, from: p.spec.ingress.map((i) => i.from.map((f) => f.podSelector.matchLabels)), ports: p.spec.ingress.flatMap((i) => i.ports.map((x) => x.port)),
  }]));
  assert.deepEqual(scoped, {
    redis: { types: ['Ingress'], from: [[{ app: 'bridge' }]], ports: [6379] },
    postgres: { types: ['Ingress'], from: [[{ app: 'bridge' }]], ports: [5432] },
  });

  // Helm
  const values = yaml.load(read('k8s/helm/bridge/values.yaml'));
  assert.equal(values.redis.auth.enabled, true);
  assert.ok(values.redis.auth.existingSecret && values.redis.auth.existingSecretPasswordKey);
  assert.deepEqual(values.redis.networkPolicy, { enabled: true, allowExternal: false });
  const deployment = strip(read('k8s/helm/bridge/templates/deployment.yaml'));
  assert.match(deployment, /redis:\/\/:\$\(REDIS_PASSWORD\)@\{\{ include "bridge\.dependencyFullname" \(list \. "redis"\) \}\}-master:6379/);
  assert.match(deployment, /\{\{ include "bridge\.dependencyFullname" \(list \. "redis"\) \}\}-client: "true"/);
  assert.match(deployment, /- name: POSTGRES_PASSWORD\s+valueFrom:\s+secretKeyRef:/);
  // Dependency hosts derived from the Bridge chart's OWN name only resolved for releases named "*bridge*".
  assert.doesNotMatch(deployment, /bridge\.fullname" \. \}\}-(redis-master|postgresql)/);

  // Production compose
  const prod = strip(read('docker-compose.prod.yml'));
  assert.match(prod, /REDIS_URL: "redis:\/\/:\$\{REDIS_PASSWORD:\?[^}]*\}@redis:6379"/);
  assert.match(prod, /REDIS_PASSWORD: "\$\{REDIS_PASSWORD:\?/);
  assert.match(prod, /requirepass \$\$REDIS_PASSWORD/, '`$$` keeps the password out of the rendered compose config');
  assert.match(prod, /redis:\n\s+user: "999:1000"/, 'without it the capability-less container cannot write /data');
  assert.match(read('.env.docker'), /^REDIS_PASSWORD=/m);
});

// ── Final21 Faz 10 ───────────────────────────────────────────────────────────
// İki dağıtım da `bridge-app:latest` çalıştırıyordu. Değişken etiket yerine
// sürüm, kök package.json ile EŞLİ olmalıdır; aksi hâlde Faz 3'teki native
// sürüm kayması gibi sessizce geride kalır.
test('Kubernetes deployments pin the Bridge image to the release version', () => {
  const version = JSON.parse(read('package.json')).version;
  const chart = read('k8s/helm/bridge/Chart.yaml');
  const values = read('k8s/helm/bridge/values.yaml');
  const kustomization = read('k8s/kustomization.yaml');
  assert.match(chart, new RegExp(`^appVersion:\\s*"${version.replace(/\./g, '\\.')}"`, 'm'), 'Chart appVersion surumle esli degil');
  assert.match(values, /^image:\s*\n\s*repository:[^\n]*\n(?:\s*#[^\n]*\n)*\s*tag:\s*""/m, 'Helm image.tag bos olmali (appVersion kullanilir)');
  assert.match(kustomization, new RegExp(`name:\\s*bridge-app\\s*\\n\\s*newTag:\\s*"${version.replace(/\./g, '\\.')}"`), 'kustomize newTag surumle esli degil');
});

test('client strict gate actually enables null, implicit-any and unknown-catch checks', () => {
  for (const file of ['client/tsconfig.strict.json', 'client/tsconfig.bridge5.json']) {
    const config = JSON.parse(read(file));
    assert.equal(config.compilerOptions.noImplicitAny, true, `${file} permits implicit any`);
    assert.equal(config.compilerOptions.strictNullChecks, true, `${file} disables null safety`);
    assert.equal(config.compilerOptions.useUnknownInCatchVariables, true, `${file} weakens catch typing`);
  }
});

test('Kubernetes uses dedicated health semantics and read-only containers with explicit writable mounts', () => {
  const manifest = read('k8s/bridge.yaml');
  const values = read('k8s/helm/bridge/values.yaml');
  const template = read('k8s/helm/bridge/templates/deployment.yaml');
  const canary = read('deploy-canary.sh');

  assert.match(manifest, /readinessProbe:[\s\S]{0,120}path: \/api\/health\/ready/);
  assert.match(manifest, /livenessProbe:[\s\S]{0,120}path: \/api\/health\/live/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
  assert.match(manifest, /capabilities:[\s\S]{0,80}- ALL/);
  assert.match(manifest, /mountPath: \/tmp/);
  assert.match(manifest, /mountPath: \/app\/server\/uploads/);

  assert.match(values, /livenessProbe:[\s\S]{0,100}path: \/api\/health\/live/);
  assert.match(values, /readinessProbe:[\s\S]{0,100}path: \/api\/health\/ready/);
  assert.match(values, /readOnlyRootFilesystem: true/);
  assert.match(template, /mountPath: \/tmp/);
  assert.match(template, /emptyDir: \{\}/);
  assert.match(canary, /\/api\/health\/ready/);
});

test('CI covers production Node and minimum supported Node plus Firefox/WebKit compatibility', () => {
  const workflow = read('.github/workflows/quality-gate.yml');
  assert.match(workflow, /NODE_VERSION: '24.20.0'/);
  assert.match(workflow, /name: Node 22\.19 minimum compatibility/);
  assert.match(workflow, /NODE_VERSION: '22\.19\.0'/);
  assert.match(workflow, /playwright install --with-deps chromium firefox webkit/);
  assert.match(workflow, /--project=firefox/);
  assert.match(workflow, /--project=webkit/);
});

test('documentation does not overclaim locale or server/channel limits', () => {
  const readme = read('README.md');
  const security = read('SECURITY.md');
  assert.doesNotMatch(readme, /Sınırsız sunucu & kanal/);
  assert.doesNotMatch(readme, /15 dil desteği/);
  assert.match(security, /1\.125\.x/);
  assert.doesNotMatch(security, /1\.121\.x/);
  assert.match(readme, /quality-gate\.yml\/badge\.svg/);
});

test('production TypeScript does not disable semantic checking with ts-nocheck/ts-ignore', () => {
  const roots = ['server', 'client/js'];
  const violations = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
        walk(rel);
      } else if (/\.(?:ts|tsx|svelte)$/.test(entry.name)) {
        const source = read(rel);
        if (/^\s*\/\/\s*@ts-(?:nocheck|ignore)\b/m.test(source)) violations.push(rel);
      }
    }
  }
  for (const root of roots) walk(root);
  assert.deepEqual(violations, [], `semantic TypeScript checks disabled in production source:\n${violations.join('\n')}`);
});

test('local quality gate enforces the same repository hygiene contracts as CI', () => {
  const gate = read('scripts/quality-gate.sh');
  for (const required of [
    'npm run check:i18n',
    'npm run validate:openapi',
    'npm run check:brand',
    'node scripts/check-no-legacy.mjs',
    'node server/scripts/verify-migration-rollback.js --static',
    'npm run typecheck:strict-client',
  ]) assert.ok(gate.includes(required), `local quality gate missing: ${required}`);
});

test('workspace SDK examples resolve canonical package entrypoints instead of build-tree relative paths', () => {
  const botExample = read('bot-sdk/examples/welcomebot/index.js');
  const shimExample = read('discord-shim/examples/ping-bot.js');
  const shimPackage = JSON.parse(read('discord-shim/package.json'));
  assert.match(botExample, /require\(['"]bridge-bot-sdk['"]\)/);
  assert.match(shimExample, /require\(['"]bridge-discord-shim['"]\)/);
  assert.equal(shimPackage.exports['.'].require, './dist/index.js');
  assert.doesNotMatch(botExample, /\.\.\/\.\.\/dist/);
  assert.doesNotMatch(shimExample, /require\(['"]\.\.\/['"]\)/);
});

test('every deployable and CI PostgreSQL image pins the same major version', () => {
  // ÖLÇÜLEN SÜRÜKLENME: docker-compose `postgres:18-alpine` dağıtırken CI'ın
  // dört servis bloğu ve k8s StatefulSet'i `postgres:16-alpine` kullanıyordu,
  // README "PostgreSQL 14+", DATABASE_SCHEMA "16+" diyordu. Yani migration'lar
  // operatörlerin çalıştırdığından İKİ ana sürüm eski bir motorda kanıtlanıyor
  // ve sürüme bağlı davranış (hata metinleri, planlayıcı, kısıt doğrulama)
  // CI'da hiç görülmüyordu.
  const sources = [
    'docker-compose.yml',
    'docker-compose.cluster.yml',
    '.github/workflows/quality-gate.yml',
    'k8s/postgres.yaml',
    'scripts/ci-local.sh',
    // Final21 Faz 19: yedek imajı postgres:16 istemcisiyle 18 sunucusunu yedekleyemiyordu
    // (pg_dump: server version mismatch) ve bu liste onu hiç denetlemiyordu.
    'backup/Dockerfile',
  ];
  // Etiket soneki ZORUNLU: `postgres:5432` bir baglanti dizgesindeki PORTTUR,
  // imaj etiketi degil.
  const found = [];
  for (const rel of sources) {
    const source = read(rel);
    for (const match of source.matchAll(/\bpostgres:(\d+)-[a-z][a-z0-9.]*\b/g)) {
      found.push({ rel, major: match[1], tag: match[0] });
    }
    // Sonekisiz bir imaj pini (`image: postgres:16`) yukaridaki taramadan
    // kacardi; acikca yasaklanir.
    for (const line of source.split('\n')) {
      if (!/\bimage:\s*postgres:/.test(line)) continue;
      assert.match(
        line.trim(), /image:\s*postgres:\d+-alpine$/,
        `unpinned PostgreSQL image in ${rel}: ${line.trim()}`);
    }
  }
  assert.ok(found.length >= 8, `expected PostgreSQL image pins in every source, saw ${found.length}`);
  const majors = [...new Set(found.map(f => f.major))];
  assert.deepEqual(
    majors, ['18'],
    `PostgreSQL major drift across deploy/CI:\n${found.map(f => `${f.rel} -> ${f.tag}`).join('\n')}`,
  );

  // Belgeler de aynı ana sürümü söylemeli; "14+" gibi bir alt sınır ifadesi
  // operatöre CI'ın kanıtlamadığı bir motoru kurma izni veriyordu.
  assert.match(read('README.md'), /PostgreSQL \*\*18\*\*/);
  assert.match(read('docs/DATABASE_SCHEMA.md'), /\*\*Motor:\*\* PostgreSQL 18\b/);
  assert.match(read('docs/PRODUCTION.md'), /\| PostgreSQL 18 \|/);
});

// ── Final21 Faz 19 ───────────────────────────────────────────────────────────
// postgres:18 PGDATA'yı /var/lib/postgresql/18/docker'a taşıdı ve bir birim eski
// /var/lib/postgresql/data'ya bağlıyken BAŞLAMAYI REDDEDER. Üç dağıtım dosyası da eski yolu
// kullanıyordu: tam üretim compose'unda PostgreSQL yeniden başlatma döngüsüne girdi, Bridge hiç
// açılmadı (tools/p19-compose-prod-boot.sh).
test('PostgreSQL 18 data volumes are mounted where the 18 image keeps its data', () => {
  const yaml = require(path.join(ROOT, 'node_modules/js-yaml'));
  const compose = (rel, volume) => {
    const doc = yaml.load(read(rel));
    const svc = Object.values(doc.services).find((s) => /^postgres:18-/.test(String(s.image ?? '')));
    assert.ok(svc, `${rel}: postgres:18 service`);
    assert.ok(svc.volumes.includes(`${volume}:/var/lib/postgresql`), `${rel}: ${JSON.stringify(svc.volumes)}`);
  };
  compose('docker-compose.yml', 'postgres_data');
  compose('docker-compose.cluster.yml', 'cluster_postgres_data');
  const sts = yaml.loadAll(read('k8s/postgres.yaml')).find((d) => d && d.kind === 'StatefulSet');
  const mounts = sts.spec.template.spec.containers[0].volumeMounts.map((m) => m.mountPath);
  assert.deepEqual(mounts, ['/var/lib/postgresql']);
  for (const rel of ['docker-compose.yml', 'docker-compose.cluster.yml', 'k8s/postgres.yaml']) {
    const live = read(rel).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(live, /\/var\/lib\/postgresql\/data\b/, `${rel} still mounts the pre-18 path`);
  }
});

test('CI runs the real S3 storage-boundary suite instead of silently skipping it', () => {
  // `minio-storage-boundary.pgtest.ts` MINIO_TEST_ENDPOINT yoksa describe.skip
  // olur. O değişken CI'da hiç verilmediği için, özel bucket'ın anonim erişime
  // kapalı olduğunu kanıtlayan TEK süit hiç çalışmamıştı.
  //
  // Bu sözleşme belirli bir vendor/image adına değil, korumamız gereken kanıta
  // kilitlenir: gerçek S3-uyumlu servis, endpoint'in teste verilmesi ve
  // public bucket için anonim GetObject politikası.
  const workflow = read('.github/workflows/quality-gate.yml');
  assert.match(workflow, /s3:\n\s+image: rustfs\/rustfs:/);
  assert.match(workflow, /MINIO_TEST_ENDPOINT: http:\/\/127\.0\.0\.1:9000/);
  // Yanlış-pozitif kontrolünün ön koşulu: genel bucket gerçekten anonim
  // okunabilir olmalı, yoksa "her şey 403" olur ve test hiçbir şey kanıtlamaz.
  assert.match(workflow, /PutBucketPolicyCommand/);
  assert.match(workflow, /bridge-public\/\*/);
  assert.match(workflow, /s3:GetObject/);
});

test('bundle budget measures INITIAL download, not the sum of every emitted chunk', () => {
  // ÖLÇÜLEN KUSUR: kapı `dist/js` altındaki bütün `.js` dosyalarını toplayıp
  // 1200 KB'lık "JS" bütçesiyle karşılaştırıyordu. Çıktı code-splitting ile
  // üretiliyor: dinamik `import()` parçaları ilk açılışta İNDİRİLMEZ. Yani
  // kapı, hiçbir kullanıcının indirmediği bir toplamı ölçüyor ve yapısal
  // olarak kırmızı kalıyordu. Bu test o metriğin geri gelmesini engeller.
  const { analyzeBundleGraph } = require(path.join(ROOT, 'scripts/bundle-graph.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bundle-'));
  try {
    // Sentetik metafile: entry + 1 statik chunk + 1 dinamik chunk.
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      outputs: {
        'client/dist/js/app-AAAA.js': {
          bytes: 1000,
          entryPoint: 'client/js/app.ts',
          imports: [
            { path: 'client/dist/js/chunk-STATIC.js', kind: 'import-statement' },
            { path: 'client/dist/js/chunk-LAZY.js',   kind: 'dynamic-import' },
          ],
          inputs: {},
        },
        'client/dist/js/chunk-STATIC.js': { bytes: 200, imports: [], inputs: {} },
        'client/dist/js/chunk-LAZY.js':   { bytes: 9000, imports: [], inputs: {} },
      },
    }));

    const graph = analyzeBundleGraph(dir);
    const app = graph.pages.find(p => p.name === 'app');
    assert.ok(app, 'app sayfası tanınmalı');
    // İlk indirme yalnızca entry + STATİK kapanış: 1000 + 200.
    assert.equal(app.initialBytes, 1200);
    assert.equal(app.initialFiles, 2);
    // Dinamik parça ayrı sayılır ve ilk indirmeye KARIŞMAZ.
    assert.equal(app.lazyBytes, 9000);
    assert.equal(app.lazyFiles, 1);
    // Toplam hâlâ görünür (yönetilebilsin diye), ama ilk indirme değildir.
    assert.equal(graph.totalBytes, 10200);
    assert.equal(graph.worstInitialBytes, 1200);
    assert.deepEqual(graph.orphanFiles, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle budget gate refuses to fall back to a naive total when the graph is missing', () => {
  // Grafik yoksa "hepsini topla"ya düşmek, düzeltilen kusuru geri getirirdi.
  const gate = read('scripts/check-bundle-budget.js');
  assert.match(gate, /analyzeBundleGraph/);
  assert.match(gate, /meta\.json yok/);
  assert.doesNotMatch(gate, /const\s+totalJs\s*=\s*jsFiles\.reduce/);
  // Bütçe SAYISI değişmedi: düzeltilen şey metrikti, eşik değil.
  assert.match(gate, /BRIDGE_BUNDLE_JS_BUDGET\s*\|\|\s*1200 \* 1024/);
});

test('build always emits meta.json so the budget gate can see the import graph', () => {
  // `--analyze` olmadan meta.json yazılmıyordu; `build:ci` analyze'siz koşar,
  // bu yüzden chunk/entry alt bütçeleri CI'da HİÇ çalışmıyordu.
  const build = read('scripts/build.js');
  const metaWrite = build.slice(build.indexOf('meta.json'));
  assert.doesNotMatch(build, /if \(ANALYZE\) \{\s*fs\.writeFileSync\(\s*path\.join\(DIST, 'meta\.json'\)/);
  assert.match(metaWrite, /fs\.writeFileSync/);
});

test('mediasoup-client is loaded on demand, not in the first paint', () => {
  const sfu = read('client/js/webrtc-sfu.ts');
  assert.match(sfu, /loadMediasoupClient/);
  assert.match(sfu, /const \{ Device \} = await loadMediasoupClient\(\)/);
});

const BS_DOT = String.fromCharCode(92) + '.';
const BS_S = String.fromCharCode(92) + 's';

test('Helm chart advertises the shipped application version', () => {
  // ÖLÇÜLEN SÜRÜKLENME: ürün 1.125.0 iken chart `appVersion: "1.117.0"`
  // diyordu. Operatör `helm list` / `kubectl describe` ile YANLIŞ sürüm
  // görür; olay incelemesinde hangi kodun çalıştığı yanlış bilinir.
  const pkg = JSON.parse(read('package.json'));
  const chart = read('k8s/helm/bridge/Chart.yaml');
  const escaped = pkg.version.split('.').join(BS_DOT);
  assert.match(chart, new RegExp('appVersion:' + BS_S + '*"' + escaped + '"'),
    `Helm Chart.yaml appVersion, package.json version (${pkg.version}) ile aynı olmalı`);
});

test('server production dependency tree is free of known vulnerabilities at packaging time', () => {
  // Bu test denetimin KENDİSİNİ çalıştırmaz (ağ gerektirir); düzeltilen
  // sürümlerin GERİ ALINMADIĞINI sabitler. Ölçülen açıklar:
  //   multer <2.3.0        — DoS (4 advisory)
  //   nodemailer <=9.1.0   — alıcı alan adı doğrulama atlatma + DoS
  //   sharp <0.35.4        — libheif zafiyetleri
  const root = JSON.parse(read('package.json'));
  const server = JSON.parse(read('server/package.json'));
  const floor = { multer: 2, nodemailer: 10 };
  for (const [name, minMajor] of Object.entries(floor)) {
    for (const [label, pkg] of [['root', root], ['server', server]]) {
      const range = pkg.dependencies?.[name];
      if (!range) continue;
      const major = Number(String(range).replace(/^[^\d]*/, '').split('.')[0]);
      assert.ok(major >= minMajor, `${label}/${name} ${range} — yamalı ana sürüm ${minMajor}+ olmalı`);
    }
  }
  for (const [label, pkg] of [['root', root], ['server', server]]) {
    const sharp = pkg.dependencies?.sharp ?? pkg.optionalDependencies?.sharp;
    if (!sharp) continue;
    assert.match(String(sharp), /\^?0\.35\.(?:[4-9]|\d\d)/, `${label}/sharp ${sharp} — 0.35.4+ olmalı`);
  }
});

test('build-only OpenAPI tooling is not declared as a production dependency', () => {
  // `swagger-jsdoc` HİÇBİR yerde kullanılmıyordu (yalnız "kullanılmamalı"
  // diyen testler ve tarihsel dokümanlar); `js-yaml` ise yalnızca
  // `scripts/openapi-contract.js` içinde. İkisi de root `dependencies`
  // altındaydı ve `npm ci --omit=dev` ağacına yüksek önemli açıklar
  // taşıyordu. Sunucu çalışma zamanı ikisini de kullanmaz.
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies?.['swagger-jsdoc'], undefined,
    'swagger-jsdoc üretim bağımlılığı değildir (hiçbir çalışma zamanı tüketicisi yok)');
  assert.equal(pkg.dependencies?.['js-yaml'], undefined,
    'js-yaml yalnızca build/CI betiklerinde kullanılır');
  assert.ok(pkg.devDependencies?.['js-yaml'], 'js-yaml devDependency olarak BEYAN EDİLMELİ');
  assert.ok(pkg.devDependencies?.['@apidevtools/swagger-parser'],
    'validate-openapi.js doğrudan require ediyor; hayalet bağımlılık olmamalı');
});

test('hardcoded-copy gate sees untranslated branches next to t() and Svelte script sinks', () => {
  // Final21 Phase 14. The gate skipped any Svelte expression containing a t() call and
  // never scanned <script> blocks of .svelte files, so `: 'Kur'` beside two translated
  // branches (BotMarketplace) and `confirmLabel: 'Kur'` (SavedPanel) shipped to every
  // locale, together with four more Turkish aria-labels and version labels.
  const { scan } = require(path.join(ROOT, 'scripts/check-i18n-hardcoded.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-i18n-gate-'));
  try {
    const js = path.join(dir, 'js');
    fs.mkdirSync(js, { recursive: true });
    const write = (name, source) => fs.writeFileSync(path.join(js, name), source);
    write('Branch.svelte', `<button>{busy ? t("busy") : installed ? t("remove") : 'Kur'}</button>\n`);
    write('Dialog.svelte', `<script>\n  confirmProductAction({ title: t('x'), confirmLabel: 'Kaydet' });\n</script>\n<p>{t('ok')}</p>\n`);
    write('Label.svelte', '<div aria-label={`Sürüm ${index + 1}`}></div>\n');
    // Nested braces (Final21 Phase 15): an object argument inside t() is not text; text after a nested mustache is.
    write('Nested.svelte', "<p>{t('k', 'Kaydet', { count: 1 })}</p>\n<p>{ { a: 1 }.a } Kaydet</p>\n");
    // Negative controls: translated fallbacks, state tokens, a property read in a ternary.
    write('Translated.svelte', `<script>\n  const label = t('save', 'Kaydet');\n</script>\n<p>{t('save', 'Kaydet')}</p>\n{#if asama === 'yenile'}<span></span>{/if}\n`);
    write('Ternary.ts', `export const text = (data: { message?: string }) => typeof data.message === 'string'\n  ? data.message\n  : 'Ses kanalına katılım tamamlanamadı.';\n`);
    // Final21 Phase 16: Turkish written with ASCII letters only was invisible to the detector
    // ("Yeni ileti", "Webhook silindi" shipped to every locale). Positive fixtures:
    write('AsciiBranch.svelte', `<button>{open ? t("cancel") : 'Yeni ileti'}</button>\n`);
    write('AsciiToast.ts', `export const done = () => toast('Webhook silindi', 'success');\n`);
    // Negative controls: a CSS custom property (the word "var" is deliberately NOT a Turkish
    // word here — it produced 3 false positives in the trial) and an English label.
    write('CssVar.svelte', `<span style={active ? 'var(--brand)' : 'var(--bg-4)'}>{t('x')}</span>\n`);
    write('English.svelte', `<button>{busy ? t('busy') : 'Trending'}</button>\n`);
    // Final21 Phase 19: INFLECTED ASCII Turkish ("Silinemedi" = could not delete) matched no whole
    // word and shipped in six toasts. Negative control: English words near the suffixes.
    write('InflectedToast.ts', `export const fail = () => toast('Silinemedi', 'error');\n`);
    write('EnglishSuffixes.ts', `export const ok = () => toast('Remedied, building and landing now', 'success');\n`);
    // Final21 Phase 19: `activeLabel`/`idleLabel` reached aria-label in every locale.
    write('VoiceLabels.ts', `export const c = { activeLabel: 'Mikrofonu aç', buttonText: 'x' };\n`);
    // Final21 Phase 19: the static shell was never scanned. Unhooked Turkish attribute and text
    // are violations; a hooked fallback is not; a hook naming a key that does not exist is.
    fs.mkdirSync(path.join(js, 'core', 'i18n'), { recursive: true });
    fs.writeFileSync(path.join(js, 'core', 'i18n', 'en.ts'), "export default { 'servers': 'Servers', 'shell_server_menu': 'Server menu' };\n");
    fs.writeFileSync(path.join(dir, 'index.html'), [
      '<button aria-label="Sunucu menüsü"></button>',
      '<button data-i18n-aria-label="shell_server_menu" aria-label="Sunucu menüsü"></button>',
      '<span class="mnav-label">Kanallar</span>',
      '<span data-i18n="servers">Sunucular</span>',
      '<button data-tip-i18n="no_such_key" data-tip="Profile"></button>',
      '<button aria-label="Server menu"></button>',
    ].join('\n'));

    const hits = scan(dir);
    assert.equal(hits.length, 11, hits.join('\n'));
    assert.ok(hits.some((row) => /VoiceLabels\.ts:1 user-property: "Mikrofonu aç"/.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /index\.html:1 shell-attr:aria-label: "Sunucu menüsü"/.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /index\.html:3 shell-text: "Kanallar"/.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /index\.html:5 shell-missing-key: "no_such_key"/.test(row)), hits.join('\n'));
    assert.ok(!hits.some((row) => /index\.html:(2|4|6) /.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /InflectedToast\.ts:1 user-call: "Silinemedi"/.test(row)), hits.join('\n'));
    assert.ok(!hits.some((row) => /EnglishSuffixes/.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /AsciiBranch\.svelte:1 expression: "Yeni ileti"/.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /AsciiToast\.ts:1 user-call: "Webhook silindi"/.test(row)), hits.join('\n'));
    assert.ok(!hits.some((row) => /CssVar|English/.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /Nested\.svelte:2 text: "Kaydet"/.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /Branch\.svelte:1 expression: "Kur"/.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /Dialog\.svelte:2 user-property: "Kaydet"/.test(row)), hits.join('\n'));
    assert.ok(hits.some((row) => /Label\.svelte:1 expression: "Sürüm/.test(row)), hits.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The shipped client is clean under the tightened rules.
  assert.deepEqual(scan(), []);
});

test('opt-in live database commands refuse to run without their address instead of passing vacuously', () => {
  const { spawnSync } = require('node:child_process');
  const scripts = JSON.parse(read('server/package.json')).scripts;
  // Each command names the SAME variable its suites read; a mismatch would skip every test.
  const commands = [
    ['test:pg', 'PG_TEST_URL', read('server/tests/pg-integration/setup.ts')],
    ['test:search-it', 'SEARCH_IT_DATABASE_URL', read('server/tests/unified-search.integration.test.ts')],
  ];
  for (const [name, variable, suite] of commands) {
    assert.ok(scripts[name].startsWith(`node scripts/require-env.cjs ${variable} && jest `), `${name}: ${scripts[name]}`);
    assert.ok(suite.includes(`process.env.${variable}`), `${name} suite does not read ${variable}`);
  }

  const guard = path.join(ROOT, 'server/scripts/require-env.cjs');
  const run = (env, ...names) => {
    const clean = { ...process.env };
    delete clean.PG_TEST_URL; delete clean.SEARCH_IT_DATABASE_URL;
    return spawnSync(process.execPath, [guard, ...names], { env: { ...clean, ...env }, encoding: 'utf8' });
  };
  const missing = run({}, 'SEARCH_IT_DATABASE_URL');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /SEARCH_IT_DATABASE_URL/);
  assert.equal(run({ SEARCH_IT_DATABASE_URL: '   ' }, 'SEARCH_IT_DATABASE_URL').status, 1);
  assert.equal(run({ PG_TEST_URL: 'postgresql://x' }, 'PG_TEST_URL', 'SEARCH_IT_DATABASE_URL').status, 1);
  assert.equal(run({ PG_TEST_URL: 'postgresql://x' }, 'PG_TEST_URL').status, 0);
  assert.equal(run({}).status, 2);

  // CI runs the live search suite after the pg suite has built the schema, with the right variable.
  const workflow = read('.github/workflows/quality-gate.yml');
  const pgStep = workflow.indexOf('run: cd server && npm run test:pg');
  const searchStep = workflow.indexOf('run: cd server && npm run test:search-it');
  assert.ok(pgStep > 0 && searchStep > pgStep, 'search-it must run after test:pg in CI');
  assert.match(
    workflow.slice(searchStep, searchStep + 260),
    /SEARCH_IT_DATABASE_URL:\s+(?:\$\{\{ env\.DATABASE_URL \}\}|postgresql:\/\/[^\s]+)/,
    'search-it CI step must set a non-empty PostgreSQL address through the exact variable the suite reads',
  );
});

// ── Final21 Faz 22 (19-40) ───────────────────────────────────────────────────
// Sunucu BOŞ veritabanında şema kurulumu bitene dek DİNLEMEZ (runtime.ts: _initSchema → seed →
// listen); bu makinede 20–81 sn ölçüldü (db-chaos açılış süresi). startupProbe yokken Helm liveness'ı
// (30 sn + 3 × 15 sn) ilk kurulumda pod'u ~60 sn'de yeniden başlatırdı. Ölçüt koşumdan ÖNCE:
// iki dağıtım da liveness yolunda startupProbe taşır, bütçe ≥ 180 sn (ölçülen en kötünün 2 katından
// fazla) ve ≤ 600 sn; Helm şablonu onu gerçekten işler.
test('Kubernetes deployments defer liveness until the first successful start (empty-DB schema bootstrap)', () => {
  const yaml = require(path.join(ROOT, 'node_modules/js-yaml'));
  const budget = (probe, where) => {
    assert.ok(probe, `${where}: startupProbe`);
    assert.equal(probe.httpGet?.path, '/api/health/live', `${where}: startupProbe path`);
    const seconds = Number(probe.periodSeconds) * Number(probe.failureThreshold);
    assert.ok(seconds >= 180 && seconds <= 600, `${where}: startup budget ${seconds}s`);
  };
  const deploy = yaml.loadAll(read('k8s/bridge.yaml')).find((d) => d && d.kind === 'Deployment');
  budget(deploy.spec.template.spec.containers[0].startupProbe, 'k8s/bridge.yaml');
  budget(yaml.load(read('k8s/helm/bridge/values.yaml')).startupProbe, 'helm values');
  assert.match(read('k8s/helm/bridge/templates/deployment.yaml'),
    /\{\{-\s*with \.Values\.startupProbe \}\}\s*\n\s*startupProbe:/, 'helm template renders startupProbe');
});
