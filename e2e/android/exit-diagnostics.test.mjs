import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseApplicationExits, parseDependencyKillLine, parseActivityManagerAnrs, parseAnrCpuPressure, parseWebViewDevToolsSockets, summarizeWebViewAttachEvidence, classifyWebViewDevToolsTargets, inspectBridgeEmojiFontProvider, parseNativeEmojiStartupProbe } from './exit-diagnostics.mjs';

test('keeps only allow-listed exit fields and redacts descriptions and credentials', () => {
  const raw = [
    'ApplicationExitInfo #0:',
    ' timestamp=2026-10-15 13:51:53.377',
    ' pid=6654 process=com.bridge.app.debug reason=12 (DEPENDENCY DIED)',
    ' subreason=0 (UNKNOWN) status=0 importance=100',
    ' description=secret token=do-not-publish owner@example.com',
    'ApplicationExitInfo #1:',
    ' pid=1426 process=com.google.android.gms.persistent reason=2 (SIGNALED)',
    ' subreason=0 (UNKNOWN) status=9 importance=100',
  ].join('\n');
  const parsed = parseApplicationExits(raw);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    at: '2026-10-15 13:51:53.377',
    pid: 6654, process: 'com.bridge.app.debug',
    reason: '12 (DEPENDENCY DIED)', subreason: '0 (UNKNOWN)',
    status: 0, importance: 100,
  });
  assert.equal(parsed[1].reason, '2 (SIGNALED)');
  assert.equal(parsed[1].status, 9);
  assert.doesNotMatch(JSON.stringify(parsed), /secret|token|example\.com/);
  assert.equal(parseApplicationExits(raw, 1).length, 1);
  assert.equal(parseApplicationExits(raw, 100).length, 2);
});

test('only reports provider and process names from ActivityManager kill logs', () => {
  const log = 'Killing 6654:com.bridge.app.debug (adj 0): depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.persistent; uid=private-id';
  assert.deepEqual(parseDependencyKillLine(log, 6654), {
    provider: 'com.google.android.gms/.fonts.provider.FontsProvider',
    dyingProcess: 'com.google.android.gms.persistent',
  });
  assert.equal(parseDependencyKillLine(log, '6654;id'), null);
  assert.deepEqual(parseDependencyKillLine('other line', 6654), {
    provider: null, dyingProcess: null, killLineFound: false,
  });
  assert.doesNotMatch(JSON.stringify(parseDependencyKillLine(log, 6654)), /private-id/);
});


test('categorizes Bridge ANRs while stripping raw intent, window and user data', () => {
  const text = [
    'E ActivityManager: ANR in com.bridge.app.debug (com.bridge.app.debug/.MainActivity)',
    'E ActivityManager: PID: 1234 token=never-export',
    'E ActivityManager: Reason: Input dispatching timed out (FocusEvent(hasFocus=false) account=private@example.com)',
    'E ActivityManager: ANR in com.other.app',
    'E ActivityManager: Reason: executing service secret=other-process',
    'E ActivityManager: ANR in com.bridge.app.debug',
    'E ActivityManager: Reason: Broadcast of Intent { act=private.password.RESET token=topsecret }',
    'E ActivityManager: ANR in com.bridge.app.debug.evil',
    'E ActivityManager: Reason: ContentProvider not responding',
    'E ActivityManager: ANR in com.bridge.app.debug',
    'E ActivityManager: Reason: unexpected private/path/user/id',
  ].join('\n');
  const facts = parseActivityManagerAnrs(text, 'com.bridge.app.debug');
  assert.deepEqual(facts, [
    { category: 'input_dispatch_timeout', focusEvent: true },
    { category: 'broadcast_timeout', focusEvent: false },
    { category: 'unknown', focusEvent: false },
  ]);
  assert.doesNotMatch(JSON.stringify(facts),
    /private|secret|token|password|email|example\.com|reset|1234|\/path/i);
  assert.deepEqual(parseActivityManagerAnrs(text, 'com.bridge.app.debug', 1), [
    { category: 'input_dispatch_timeout', focusEvent: true },
  ]);
});

test('rejects unsafe process selectors and safely bounds unknown ANR records', () => {
  assert.deepEqual(parseActivityManagerAnrs('ANR in com.bridge.app.debug', 'com.bridge.app.debug; cat /secrets'), []);
  const raw = Array.from({ length: 20 }, () => 'ANR in com.bridge.app.debug\nReason: executing service').join('\n');
  const facts = parseActivityManagerAnrs(raw, 'com.bridge.app.debug', 1000);
  assert.equal(facts.length, 10);
  assert.ok(facts.every((item) => item.category === 'service_timeout'));
});

const AM = (line) => `E/ActivityManager(  512): ${line}`;
const anrCpuLog = [
  AM('ANR in com.other.app (com.other.app/.Main)'),
  AM('Load: 1.0 / 1.0 / 1.0'),
  AM('CPU usage from 0ms to 5000ms later:'),
  AM('  99% 777/com.other.app: 90% user + 9% kernel'),
  AM('99% TOTAL: 90% user + 9% kernel'),
  AM('ANR in com.bridge.app.debug (com.bridge.app.debug/com.bridge.app.MainActivity)'),
  AM('PID: 9136'),
  AM('Reason: Input dispatching timed out (owner@example.com secret-token FocusEvent)'),
  AM('Parent: com.bridge.app.debug/com.bridge.app.MainActivity'),
  AM('Load: 26.68 / 7.72 / 2.66'),
  AM('----- Output from /proc/pressure/memory -----'),
  AM('some avg10=12.00 avg60=3.00 avg300=1.00 total=123'),
  AM('CPU usage from 6100ms to 0ms ago (2026-10-16 01:19:33.800 to 01:19:39.900):'),
  AM('  148% 512/system_server: 90% user + 58% kernel / faults: 100 minor'),
  AM('  61% 3011/com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0: 50% user + 11% kernel'),
  AM('  9.1% 9136/com.bridge.app.debug: 7% user + 2.1% kernel'),
  AM('  40% 233/surfaceflinger: 20% user + 20% kernel'),
  AM('  33% 4321/com.google.android.gms.persistent: 30% user + 3% kernel'),
  AM('198% TOTAL: 120% user + 70% kernel + 3% iowait + 5% irq'),
  AM('CPU usage from 40ms to 5000ms later (2026-10-16 01:19:39.940 to 01:19:44.900):'),
  AM('  80% 512/system_server: 50% user + 30% kernel'),
  AM('  2% 9136/com.bridge.app.debug: 1% user + 1% kernel'),
  AM('120% TOTAL: 80% user + 40% kernel'),
  AM('CPU usage from 9ms to 10ms later:'),
  AM('  5% 1/init: 5% user'),
].join('\n');

test('ANR CPU pressure keeps only numbers and fixed categories for the expected process', () => {
  const [record, ...rest] = parseAnrCpuPressure(anrCpuLog, 'com.bridge.app.debug');
  assert.equal(rest.length, 0, 'another app\'s ANR is not attributed to Bridge');
  assert.deepEqual(record.load, [26.68, 7.72, 2.66]);
  assert.equal(record.cpu.length, 2, 'at most the before and after windows');
  assert.deepEqual(record.cpu[0], {
    window: 'before', totalPct: 198, appPct: 9.1, webviewRendererPct: 61, systemServerPct: 148,
    topPct: 148, topClass: 'system_server',
  });
  assert.deepEqual(record.cpu[1], {
    window: 'after', totalPct: 120, appPct: 2, webviewRendererPct: 0, systemServerPct: 80,
    topPct: 80, topClass: 'system_server',
  });
  const json = JSON.stringify(record);
  assert.doesNotMatch(json, /example\.com|secret|token|gms|com\.google|sandboxed|chromium|other\.app|9136|FocusEvent|avg10/);
});

test('ANR CPU pressure rejects malformed input and bounds its output', () => {
  assert.deepEqual(parseAnrCpuPressure(anrCpuLog, 'bad process; rm -rf'), []);
  assert.deepEqual(parseAnrCpuPressure('', 'com.bridge.app.debug'), []);
  const many = Array.from({ length: 8 }, () => AM('ANR in com.bridge.app.debug (x)')).join('\n');
  assert.equal(parseAnrCpuPressure(many, 'com.bridge.app.debug').length, 3);
  assert.equal(parseAnrCpuPressure(many, 'com.bridge.app.debug', 100).length, 5);
  const odd = [AM('ANR in com.bridge.app.debug (x)'), AM('Load: NaN / 1 / 1'),
    AM('CPU usage from 0ms to 1ms later:'), AM('  999999% 1/com.bridge.app.debug: x'), AM('7% TOTAL: 7% user')].join('\n');
  const [r] = parseAnrCpuPressure(odd, 'com.bridge.app.debug');
  assert.equal(r.load, null);
  assert.deepEqual(r.cpu[0], { window: 'after', totalPct: 7, appPct: 0, webviewRendererPct: 0, systemServerPct: 0, topPct: 0, topClass: null });
});


test('WebView attach diagnostics distinguish Activity PID from actual DevTools socket without leaking names', () => {
  const raw = [
    'Num RefCount Protocol Flags Type St Inode Path',
    '00000: 00000002 00000000 00010000 0001 01 54321 @webview_devtools_remote_8792',
    '00001: 00000002 00000000 00010000 0001 01 54322 @webview_devtools_remote_9999',
    '00002: 00000002 00000000 00010000 0001 01 54323 @webview_devtools_remote_8792',
    'PRIVATE-USERNAME@example.com secret-token=not-for-logs',
  ].join('\n');
  const visible = parseWebViewDevToolsSockets(raw, '8792');
  assert.deepEqual(visible, { socketCount: 2, appPidHasSocket: true });
  assert.deepEqual(parseWebViewDevToolsSockets(raw, '1234'), { socketCount: 2, appPidHasSocket: false });
  assert.deepEqual(parseWebViewDevToolsSockets('', '8792'), { socketCount: 0, appPidHasSocket: false });
  assert.deepEqual(parseWebViewDevToolsSockets(raw, '8792;rm /'), { socketCount: 2, appPidHasSocket: false });
  assert.doesNotMatch(JSON.stringify(visible), /PRIVATE|secret|token|example|9999|8792/);
});


test('font-provider probe isolates the Bridge PID and removes raw identity-bearing data', () => {
  const raw = [
    'ProcessRecord{... account=private@example.com}',
    '    Connected Providers:',
    '      - abcd1234/com.android.providers.settings/.SettingsProvider->5304:com.bridge.app.debug/123 s1/1 u0/0 +5s',
    '      - aabc1234/com.google.android.gms/.fonts.provider.FontsProvider->5304:com.bridge.app.debug/123 s1/1 u0/1 +3s',
    '      - bbcc1234/com.google.android.gms/.fonts.provider.FontsProvider->6400:another.app/555 s1/1 u0/1 +3s',
  ].join('\n');
  const present = inspectBridgeEmojiFontProvider(raw, '5304');
  assert.deepEqual(present, {
    appPidValid: true, providerSections: 1, parsedConnections: 3,
    unparsedConnections: 0, fontProviderConnected: true,
    fontProviderConnections: 1, fontProviderStableRefs: 1,
    fontProviderUnstableRefs: 0, fontProviderRefCountsKnown: true,
    fontProviderWaiting: false, fontProviderDead: false,
  });
  assert.equal(inspectBridgeEmojiFontProvider(raw, '4200').fontProviderConnected, false);
  const invalid = inspectBridgeEmojiFontProvider(raw, '5304;id');
  assert.equal(invalid.appPidValid, false);
  assert.equal(invalid.fontProviderConnected, false);
  assert.doesNotMatch(JSON.stringify(present), /private|example|FontsProvider|5304|6400/);
});

test('malformed Android provider records produce explicit uncertainty, not false success', () => {
  const malformed = 'Connected Providers:\n  - unknown format; secret=example.com\nnot-a-connection';
  const result = inspectBridgeEmojiFontProvider(malformed, '5304');
  assert.equal(result.unparsedConnections, 1);
  assert.equal(result.fontProviderConnected, false);
});


test('font-provider strength distinguishes stable OS dependency from unstable-only usage', () => {
  const raw = [
    'Connected Providers:',
    '  - abcde/com.google.android.gms/.fonts.provider.FontsProvider->9021:com.bridge.app.debug/123 s0/2 u1/3 +6s',
    '  - ef012/com.google.android.gms/.fonts.provider.FontsProvider->9022:some.other.app/456 s9/9 u8/8 +6s',
    '  - 123ab/com.android.providers.settings/.SettingsProvider->9021:com.bridge.app.debug/123 s1/1 u0/0 +5s',
  ].join('\n');
  const result = inspectBridgeEmojiFontProvider(raw, '9021');
  assert.equal(result.fontProviderConnected, true);
  assert.equal(result.fontProviderConnections, 1);
  assert.equal(result.fontProviderStableRefs, 0);
  assert.equal(result.fontProviderUnstableRefs, 1);
  assert.equal(result.fontProviderRefCountsKnown, true);
  assert.equal(result.unparsedConnections, 0);
  assert.doesNotMatch(JSON.stringify(result), /some.other|9021|9022|FontsProvider/);
});

test('font-provider probe exposes uncertain reference strength rather than silently treating it as zero', () => {
  const raw = 'Connected Providers:\n  - aabbcc/com.google.android.gms/.fonts.provider.FontsProvider->8901:com.bridge.app.debug/123 exotic_format\nend';
  const result = inspectBridgeEmojiFontProvider(raw, '8901');
  assert.equal(result.fontProviderConnected, true);
  assert.equal(result.fontProviderRefCountsKnown, false);
  assert.equal(result.fontProviderStableRefs, 0);
});


test('native EmojiCompat diagnostic distinguishes initialized, uninitialized and unknown', () => {
  const raw = [
    '10-17 I/BridgeEmojiStartupProbe( 5304): stage=before-super classPresent=true configured=false',
    '10-17 I/BridgeEmojiStartupProbe( 5304): stage=after-super classPresent=true configured=true',
    '10-17 I/BridgeEmojiStartupProbe( 5304): stage=resumed classPresent=true configured=unknown',
    '10-17 I/BridgeEmojiStartupProbe( 5304): token=secret@example.com stage=wild classPresent=false configured=false',
    '10-17 I/OtherTag( 5304): stage=resumed classPresent=false configured=false',
    'PRIVATE phone contact=secret@example.com',
  ].join('\n');
  const result = parseNativeEmojiStartupProbe(raw);
  assert.deepEqual(result, {
    available: true, samples: 3, anyClassPresent: true, anyConfigured: true,
    beforeSuper: false, afterSuper: true, lastResume: null,
    unknownConfigured: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /5304|contact|email|token|PRIVATE/);
  assert.deepEqual(parseNativeEmojiStartupProbe(''), {
    available: false, samples: 0, anyClassPresent: false, anyConfigured: false,
    beforeSuper: null, afterSuper: null, lastResume: null, unknownConfigured: 0,
  });
});

test('native EmojiCompat missing class is not mistaken for confirmed uninitialized font client', () => {
  const result = parseNativeEmojiStartupProbe(
    'I/BridgeEmojiStartupProbe( 22): stage=before-super classPresent=false configured=unknown');
  assert.equal(result.anyClassPresent, false);
  assert.equal(result.beforeSuper, null);
  assert.equal(result.unknownConfigured, 1);
});

test('tag-filtered EmojiCompat logcat fallback accepts only exact target PID', () => {
  const raw = [
    'I/BridgeEmojiStartupProbe( 5304): stage=before-super classPresent=true configured=false',
    'I/BridgeEmojiStartupProbe( 8888): stage=after-super classPresent=true configured=true',
    '10-17 01:24:18.123  5304  5305 I BridgeEmojiStartupProbe: stage=after-super classPresent=true configured=true',
    'BridgeEmojiStartupProbe stage=resumed classPresent=true configured=true',
    'I/BridgeEmojiStartupProbe( 53040): stage=resumed classPresent=true configured=true',
    'I/BridgeEmojiStartupProbe( 5304): stage=resumed classPresent=true configured=unknown',
  ].join('\n');
  const evidence = parseNativeEmojiStartupProbe(raw, '5304');
  assert.equal(evidence.samples, 3);
  assert.equal(evidence.beforeSuper, false);
  assert.equal(evidence.afterSuper, true);
  assert.equal(evidence.lastResume, null);
  assert.equal(evidence.unknownConfigured, 1);
  assert.equal(parseNativeEmojiStartupProbe(raw, 'not-a-pid').available, false);
  assert.equal(parseNativeEmojiStartupProbe('BridgeEmojiStartupProbe stage=before-super classPresent=true configured=true', '5304').available, false);
  assert.doesNotMatch(JSON.stringify(evidence), /5304|8888/);
});

test('Android CI never persists raw device logcat in uploaded emulator evidence', () => {
  const runner = readFileSync(new URL('./run-emulator-journeys.sh', import.meta.url), 'utf8');
  // The runner may use allowlisted, bounded native diagnostics in the main JS
  // harness, but must never dump unredacted device-wide output into the
  // results/ artifact directory, whether the journeys PASS or FAIL.
  assert.doesNotMatch(runner, /\badb\s+logcat\b/);
  assert.doesNotMatch(runner, /\blogcat\.txt\b/);
  const workflow = readFileSync(
    new URL('../../.github/workflows/mobile-android.yml', import.meta.url), 'utf8');
  assert.match(workflow, /e2e\/android\/results\//,
    'the runner result directory is uploaded, so raw capture here is sensitive');
});

test('Android failure-only DOM evidence excludes user text, URL paths, channel identifiers and arbitrary error strings', () => {
  const journeys = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const begin = journeys.indexOf('async function domSummary() {');
  const end = journeys.indexOf('\n/** Measurement-only probe:', begin);
  assert.ok(begin >= 0 && end > begin, 'actual production failure summary must exist');
  const summary = journeys.slice(begin, end);
  for (const unsafe of ['innerText', 'textContent', 'location.href', 'location.pathname',
    'getAttribute', '.className', 'error.message', 'JSON.stringify(err)']) {
    assert.equal(summary.includes(unsafe), false,
      `unsafe user-controllable field ${unsafe} must not leave failure summary`);
  }
  for (const required of ['packagedOrigin', 'appVisible', 'authVisible', 'activeChannelPresent',
    'dialogCount', 'alertCount', 'dmPanelVisible']) {
    assert.ok(summary.includes(required), `allowlisted diagnostic ${required} required`);
  }
  assert.ok(summary.includes("catch(() => 'unavailable')"),
    'Playwright exception text must not be copied verbatim to CI output');
});


test('L03 failure evidence proves only OS state and redacts all free-text and device paths', () => {
  const sample = {
    pid: '8460',
    activity: [
      'topResumedActivity=ActivityRecord{8424cb u0 com.bridge.app.debug/com.bridge.app.MainActivity t13}',
      '  Intent { url=https://private.example/secret?token=xyz }',
      '  baseDir=/data/app/customer-private',
    ].join('\n'),
    processes: [
      '*APP* UID 10192 ProcessRecord{c57864f 8460:com.bridge.app.debug/u0a192}',
      '  account=owner@example.com',
    ].join('\n'),
    sockets: '000000 @webview_devtools_remote_8460\nsecretSocket=@other-private-id',
    crash: 'Caused by: user=alice@example.com; token=my-secret',
  };
  const facts = summarizeWebViewAttachEvidence(sample);
  assert.deepEqual(facts, {
    appPidValid: true,
    activityRecordAvailable: true,
    mainActivityResumed: true,
    processRecordAvailable: true,
    appProcessMatched: true,
    devtools: { socketCount: 1, appPidHasSocket: true },
    crashBufferHasFatalMarker: false,
    cdpPageResponsive: 'unverified',
  });
  assert.doesNotMatch(JSON.stringify(facts), /secret|alice|owner|private|8460|10192|https:|token|\/data\/app/);
  // PID-specific attribution: a socket may belong to a previous process.
  const wrongPid = summarizeWebViewAttachEvidence({ ...sample, pid: '1234' });
  assert.equal(wrongPid.devtools.appPidHasSocket, false);
  assert.equal(wrongPid.appProcessMatched, false);
  assert.equal(wrongPid.mainActivityResumed, true);
  assert.equal(wrongPid.cdpPageResponsive, 'unverified');
  // No record is never a proven healthy WebView or evidence of an ANR.
  assert.deepEqual(summarizeWebViewAttachEvidence(), {
    appPidValid: false, activityRecordAvailable: false,
    mainActivityResumed: false, processRecordAvailable: false,
    appProcessMatched: false,
    devtools: { socketCount: 0, appPidHasSocket: false },
    crashBufferHasFatalMarker: false,
    cdpPageResponsive: 'unverified',
  });
  assert.equal(summarizeWebViewAttachEvidence({
    crash: 'Fatal signal 6 in another process',
  }).crashBufferHasFatalMarker, true);
});

test('L03 WebView attach failure path cannot archive raw Android dump or transport exception', () => {
  const code = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const begin = code.indexOf('async function webViewAttachEvidence() {');
  const end = code.indexOf('\nasync function attachPage(', begin);
  assert.ok(begin >= 0 && end > begin);
  const actual = code.slice(begin, end);
  assert.ok(actual.includes('summarizeWebViewAttachEvidence(inputs, PKG)'));
  assert.doesNotMatch(actual, /slice\(0,\s*1200\)|probe failed:|JSON.stringify\(inputs\)/);
  const failure = code.slice(end, code.indexOf('\nasync function pid()', end));
  assert.ok(failure.includes('safe device evidence'));
  assert.doesNotMatch(failure, /String\(err\?\.message\s*\?\?\s*err\)/);
});


test('DevTools HTTP targets are counted without leaking page titles, URLs or websocket endpoints', () => {
  const targets = [
    { type: 'page', title: 'Private DM with user', url: 'https://private.example/?token=secret',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/page/secret' },
    { type: 'background_page', url: 'https://private.example/background' },
    { type: 'page', url: 'https://private.example/other' },
  ];
  const safe = classifyWebViewDevToolsTargets(targets);
  assert.deepEqual(safe, { listValid: true, targetCount: 3, pageTargetCount: 2 });
  assert.doesNotMatch(JSON.stringify(safe), /secret|token|private|localhost|ws:/);
  assert.deepEqual(classifyWebViewDevToolsTargets(null),
    { listValid: false, targetCount: 0, pageTargetCount: 0 });
  assert.deepEqual(classifyWebViewDevToolsTargets([{ type: 'other' }]),
    { listValid: true, targetCount: 1, pageTargetCount: 0 });
  assert.equal(classifyWebViewDevToolsTargets(Array(1000).fill({ type: 'page' })).pageTargetCount, 100);
});

test('failure-only CDP probing preserves strict L03 failures and removes ADB forwards', () => {
  const src = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const begin = src.indexOf('async function devToolsHttpProbe(');
  const end = src.indexOf('\nasync function webViewAttachEvidence()', begin);
  assert.ok(begin >= 0 && end > begin);
  const fn = src.slice(begin, end);
  assert.ok(fn.includes("['-s', serial, 'forward', '--remove'"));
  assert.ok(fn.includes("http://127.0.0.1:"));
  assert.ok(fn.includes('classifyWebViewDevToolsTargets'));
  assert.doesNotMatch(fn, /console\.(?:log|error)|log\(raw\)|JSON\.stringify\(raw\)/);
  const l03 = src.slice(src.indexOf("await check('L03'"), src.indexOf("await check('L04'"));
  assert.ok(l03.includes('await attachPage()'));
  assert.doesNotMatch(l03, /\.catch\(\(\)\s*=>\s*(?:true|false)\)/);
});


// Debug-only experiment must separate construction from navigation and keep
// strict FD01/L01/L03/ANR01/CS01 acceptance intact; the control is MEASURED.
test('Android WebView constructor baseline never attaches or loads content', () => {
  const src = readFileSync(new URL('../../mobile/android/app/src/debug/java/com/bridge/app/WebViewConstructorBaselineActivity.java',
    import.meta.url), 'utf8');
  assert.match(src, /new android\.webkit\.WebView\(this\)/);
  assert.doesNotMatch(src, /\.loadUrl\s*\(|setContentView\s*\(|setJavaScriptEnabled\s*\(/);
  const overlay = readFileSync(new URL('../../mobile/android/app/src/debug/AndroidManifest.xml',
    import.meta.url), 'utf8');
  assert.match(overlay, /android:name="com\.bridge\.app\.WebViewConstructorBaselineActivity"/);
  const release = readFileSync(new URL('../../mobile/android/app/src/main/AndroidManifest.xml',
    import.meta.url), 'utf8');
  assert.doesNotMatch(release, /WebViewConstructorBaselineActivity/);

  const harness = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  assert.match(harness, /await measure\('FD00C'/);
  for (const gate of ['FD01', 'L01', 'L03', 'ANR01', 'CS01']) {
    assert.ok(harness.includes("await check('" + gate + "'"),
      `required Android assertion ${gate} was removed`);
  }
});


test('debug-only attached WebView control does not load a page or relax FD01', () => {
  const attached = readFileSync(new URL('../../mobile/android/app/src/debug/java/com/bridge/app/WebViewAttachedBaselineActivity.java',
    import.meta.url), 'utf8');
  assert.match(attached, /new android\.webkit\.WebView\(this\)/);
  assert.match(attached, /setContentView\(view\)/);
  assert.doesNotMatch(attached, /\.loadUrl\s*\(|\.loadData\s*\(|\.loadDataWithBaseURL\s*\(|setJavaScriptEnabled\s*\(/);
  const manifest = readFileSync(new URL('../../mobile/android/app/src/debug/AndroidManifest.xml',
    import.meta.url), 'utf8');
  assert.match(manifest, /android:name="com\.bridge\.app\.WebViewAttachedBaselineActivity"/);
  const release = readFileSync(new URL('../../mobile/android/app/src/main/AndroidManifest.xml',
    import.meta.url), 'utf8');
  assert.doesNotMatch(release, /WebViewAttachedBaselineActivity/);
  const harness = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  assert.match(harness, /await measure\('FD00A'/);
  for (const gate of ['FD01', 'L01', 'L03', 'ANR01', 'CS01']) {
    assert.ok(harness.includes("await check('" + gate + "'"),
      `required asserting check ${gate} was removed`);
  }
});


test('debug-only unattached navigation WebView isolates loadUrl without setContentView', () => {
  const source = readFileSync(new URL(
    '../../mobile/android/app/src/debug/java/com/bridge/app/WebViewUnattachedNavigationBaselineActivity.java',
    import.meta.url), 'utf8');
  assert.match(source, /new android\.webkit\.WebView\(this\)/);
  assert.match(source, /view\.loadUrl\("about:blank"\)/);
  assert.doesNotMatch(source, /setContentView\s*\(|setJavaScriptEnabled\s*\(|loadData\s*\(/);
  const debug = readFileSync(new URL('../../mobile/android/app/src/debug/AndroidManifest.xml',
    import.meta.url), 'utf8');
  assert.match(debug, /android:name="com\.bridge\.app\.WebViewUnattachedNavigationBaselineActivity"/);
  const release = readFileSync(new URL('../../mobile/android/app/src/main/AndroidManifest.xml',
    import.meta.url), 'utf8');
  assert.doesNotMatch(release, /WebViewUnattachedNavigationBaselineActivity/);
  const harness = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  assert.match(harness, /await measure\('FD00N'/);
  for (const gate of ['FD01', 'CS01', 'L01', 'L03', 'ANR01']) {
    assert.ok(harness.includes("await check('" + gate + "'"),
      `strict Android check ${gate} must remain an assertion`);
  }
});
