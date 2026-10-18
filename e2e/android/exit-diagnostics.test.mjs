import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyDependencyDeathDescription, parseFinalizationProbeMarkers, parseAnrTraceProbeMarkers, parseFontRefReleaseMarkers, parseApplicationExits, parseDependencyKillLine, parseActivityManagerAnrs, parseAnrCpuPressure, parseWebViewDevToolsSockets, summarizeWebViewAttachEvidence, classifyWebViewDevToolsTargets, inspectBridgeEmojiFontProvider, parseNativeEmojiStartupProbe, summarizeControlProcessExit, summarizeFreshControlProcessExit, summarizeAndroidColdLaunch, classifyAndroidDependencyDeath, classifyFreshAndroidDependencyDeath, summarizeAndroidWebViewProvider, summarizeAndroidWebViewAlternatives } from './exit-diagnostics.mjs';

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
    dependencyDescription: { kind: 'unrecognized', providerClass: 'unknown',
      dyingProcessClass: 'unknown', dependencyPackageClass: 'unknown' },
  });
  assert.equal(parsed[1].dependencyDescription, null);
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


test('FD02 remains measurement-only after strict FD01 and rejects missing provider facts', () => {
  const code = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const fd01 = code.indexOf("await check('FD01'");
  const fd02 = code.indexOf("await measure('FD02'");
  const pn01 = code.indexOf("await check('PN01'");
  assert.ok(fd01 >= 0 && fd02 > fd01 && pn01 > fd02);
  const gate = code.slice(fd01, fd02);
  assert.ok(gate.includes('assert(!evidence.fontProviderConnected'));
  const measure = code.slice(fd02, pn01);
  assert.ok(gate.includes('fd01Pid = await pid()'));
  assert.match(measure, /const startingPid = await pid\(\)/);
  assert.ok(measure.includes('startingPid === fd01Pid'));
  assert.ok(measure.includes('facts.fontProviderDecay = { sameAppProcess: true, complete: false, samples }'));
  assert.ok(measure.includes('facts.fontProviderDecay.complete = true'));
  assert.ok(measure.includes('facts.fontProviderDecay.sameAppProcess = false'));
  assert.match(measure, /assert\(stablePid/);
  assert.match(measure, /info\.unparsedConnections === 0 && info\.fontProviderRefCountsKnown/);
  assert.match(measure, /const samples = \[\]/);
  assert.ok(measure.includes('[1500, 4000, 8000]'));
  assert.doesNotMatch(measure, /await check\('FD02'|return \{.*status:\s*'PASS'/);
});


test('CS00 compares repeated real native and WebView-only cold starts without waiving CS01', () => {
  const code = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const c = code.indexOf("await measure('CS00'");
  const a = code.indexOf("await check('A01'");
  const cs = code.indexOf("await check('CS01'");
  assert.ok(c >= 0 && c < a && a < cs);
  const body = code.slice(c, a);
  for (const literal of ["kind: 'native-only'", "kind: 'blank-webview'",
    "for (let attempt = 1; attempt <= 3; attempt++)",
    "await sh('am force-stop ' + PKG)",
    'pidStable: firstPid === finalPid',
    'assert(count === previousAnrs',
    'facts.androidControlColdStarts = { complete: false, samples }']) {
    assert.ok(body.includes(literal), 'CS00 missing contract: ' + literal);
  }
  assert.doesNotMatch(body, /await check\('CS00'|console\.log\(raw\)/);
  for (const gate of ['FD01', 'CS01', 'L01', 'L03', 'ANR01']) {
    assert.ok(code.includes("await check('" + gate + "'"),
      'original strict Android assertion missing: ' + gate);
  }
});


test('A01 original 45s gate records only safe failure-only app/CDP evidence, never retries', () => {
  const code = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const a01 = code.slice(code.indexOf("await check('A01'"), code.indexOf("await check('CS01'"));
  assert.match(a01, /await attachPage\(\)/);
  assert.match(a01, /timeout: 45_000/);
  assert.match(a01, /throw new Error\('A01 auth\/app screen was not reachable/);
  assert.doesNotMatch(a01, /(?:platform\.coldLaunch|attachPage)\(\).*\b(?:retry|second)/);
  const failBlock = code.slice(code.indexOf("async function check(id,"), code.indexOf("async function domSummary()"));
  assert.match(failBlock, /id === 'A01'/);
  assert.match(failBlock, /await webViewAttachEvidence\(\)/);
  assert.match(failBlock, /facts\.androidA01FailureEvidence = a01/);
  assert.match(failBlock, /pageHandlePresent: Boolean\(page\), pageClosed, osEvidence/);
  assert.doesNotMatch(failBlock, /log\([^\n]*(?:page\.url|err\.stack|err\.cause)/);
});


test('FD00W blank-WebView font reference decay is measured on the original PID without waiving FD01', () => {
  const code = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const start = code.indexOf("await measure('FD00W'");
  const end = code.indexOf("await measure('CS00'", start);
  assert.ok(start >= 0 && end > start);
  const control = code.slice(start, end);
  assert.match(control, /facts\.fontProviderPlainWebViewDecay = decay/);
  assert.match(control, /\[1500, 4000, 8000\]/);
  assert.match(control, /currentPid === baselinePid/);
  // A vanished foreground WebView control is now a real FAIL, not a
  // silently incomplete MEASURED control or a second-PID success.
  assert.match(control, /if \(!samePid\) \{/);
  assert.match(control, /summarizeFreshControlProcessExit\(/);
  assert.match(control, /throw new Error\('FD00W original foreground process disappeared/);
  assert.doesNotMatch(control, /if \(!samePid\) break/);
  assert.match(control, /inspectBridgeEmojiFontProvider\(snapshot, currentPid\)/);
  assert.match(control, /decay\.complete = decay\.sameAppProcess/);
  assert.doesNotMatch(control, /await check\('FD00W'|await check\('FD01'/);
  const fd01 = code.indexOf("await check('FD01'");
  const fd02 = code.indexOf("await measure('FD02'", fd01);
  assert.ok(fd01 > end && fd02 > fd01, 'strict FD01 must precede FD02');
  assert.match(code.slice(fd01, fd02), /assert\(!evidence\.fontProviderConnected/);
  assert.ok(code.includes("await check('A01'"));
  assert.ok(code.includes("await check('ANR01'"));
});


test('CS00 PID-specific failure evidence contains numeric Android exit codes only', () => {
  const exits = [{
    pid: 6812, process: 'com.bridge.app.debug', reason: '6 (ANR)',
    subreason: '0 (UNKNOWN)', status: 9, importance: 100,
    at: 'private-time', dependency: { provider: 'private.example/path' },
    description: 'token=secret-user@example.com',
  }, {
    pid: 8701, process: 'com.google.android.gms.persistent',
    reason: '12 (DEPENDENCY DIED)', subreason: null,
    description: 'hidden=another-account',
  }];
  const result = summarizeControlProcessExit(exits, '6812');
  assert.deepEqual(result, {
    evidenceValid: true, matchingExit: true, reasonCode: 6, subreasonCode: 0,
  });
  assert.doesNotMatch(JSON.stringify(result),
    /6812|8701|secret|private|example|token|android|gms|process|path/i);
  assert.deepEqual(summarizeControlProcessExit(exits, '9000'), {
    evidenceValid: true, matchingExit: false, reasonCode: null, subreasonCode: null,
  });
  assert.deepEqual(summarizeControlProcessExit(exits, '6812; echo leak'), {
    evidenceValid: false, matchingExit: false, reasonCode: null, subreasonCode: null,
  });
  assert.deepEqual(summarizeControlProcessExit(null, '6812'), {
    evidenceValid: false, matchingExit: false, reasonCode: null, subreasonCode: null,
  });
  assert.deepEqual(summarizeControlProcessExit([
    { pid: 6812, reason: '6 (ANR) token=secret', subreason: 'not-valid' },
  ], '6812'), {
    evidenceValid: true, matchingExit: true, reasonCode: null, subreasonCode: null,
  });
});


test('A01 launch summary is a bounded, identity-free projection of am start -W', () => {
  const sample = [
    'Starting: Intent { secret-token=never-export-private@example.com }',
    'Status: ok',
    'LaunchState: COLD',
    'Activity: com.bridge.app.debug/com.bridge.app.MainActivity',
    'TotalTime: 2472',
    'WaitTime: 2549',
    'Complete',
  ].join('\n');
  const clean = summarizeAndroidColdLaunch(sample);
  assert.deepEqual(clean, { status: 'ok', launchState: 'COLD', totalTimeMs: 2472 });
  assert.doesNotMatch(JSON.stringify(clean), /secret|token|@|bridge|MainActivity|Activity|private/i);
  assert.deepEqual(summarizeAndroidColdLaunch(
    'Status: internal_error\nLaunchState: HOT\nTotalTime: 125000',
  ), { status: 'not-ok', launchState: 'HOT', totalTimeMs: null });
  assert.deepEqual(summarizeAndroidColdLaunch(
    'Activity: com.private.secret/Main\nTotalTime: NaN',
  ), { status: 'unknown', launchState: 'unknown', totalTimeMs: null });
  assert.deepEqual(summarizeAndroidColdLaunch(null),
    { status: 'unknown', launchState: 'unknown', totalTimeMs: null });
});


test('A01 same-PID dependency death identifies Google FontsProvider with fixed enums only', () => {
  const exits = [{
    pid: 12345, reason: '12 (DEPENDENCY DIED)', subreason: '0 (UNKNOWN)',
    process: 'com.bridge.app.debug', description: 'private-token=secret@example.com',
    dependency: {
      provider: 'com.google.android.gms/.fonts.provider.FontsProvider',
      dyingProcess: 'com.google.android.gms.persistent',
      raw: 'secret pathname /private',
    },
  }];
  const evidence = classifyAndroidDependencyDeath(exits, 12345);
  assert.deepEqual(evidence, {
    exitMatched: true, isDependencyDeath: true, dependencyKind: 'provider-death',
    providerClass: 'gms-fonts', dyingProcessClass: 'gms-persistent',
    dependencyPackageClass: 'unknown', attribution: 'matched-kill-line',
  });
  assert.doesNotMatch(JSON.stringify(evidence),
    /12345|private|token|secret|example|com\.google|FontsProvider|pathname|processName/);
});

test('A01 dependency attribution fails closed on missing kill lines, other PIDs and other providers', () => {
  const base = { pid: 77, reason: '12 (DEPENDENCY DIED)', subreason: '0 (UNKNOWN)' };
  const unavailable = {
    exitMatched: true, isDependencyDeath: true, dependencyKind: 'unknown',
    providerClass: 'unknown', dyingProcessClass: 'unknown',
    dependencyPackageClass: 'unknown', attribution: 'unavailable',
  };
  assert.deepEqual(classifyAndroidDependencyDeath([{ ...base }], 77), unavailable);
  assert.deepEqual(classifyAndroidDependencyDeath([{
    ...base, dependency: { provider: null, dyingProcess: null, killLineFound: true },
  }], 77), unavailable);
  assert.deepEqual(classifyAndroidDependencyDeath([{
    ...base, dependency: { provider: 'com.some.other/Provider', dyingProcess: 'com.other.service' },
  }], '77'), {
    exitMatched: true, isDependencyDeath: true, dependencyKind: 'provider-death',
    providerClass: 'other-provider', dyingProcessClass: 'other-process',
    dependencyPackageClass: 'unknown', attribution: 'matched-kill-line',
  });
  assert.deepEqual(classifyAndroidDependencyDeath([{
    ...base, reason: '6 (ANR)', dependency: {
      provider: 'com.google.android.gms/.fonts.provider.FontsProvider',
      dyingProcess: 'com.google.android.gms.persistent',
    },
  }], 77), {
    exitMatched: true, isDependencyDeath: false, dependencyKind: 'unknown',
    providerClass: 'unknown', dyingProcessClass: 'unknown',
    dependencyPackageClass: 'unknown', attribution: 'not-dependency-death',
  });
  const missing = { exitMatched: false, isDependencyDeath: null, dependencyKind: 'unknown',
    providerClass: 'unknown', dyingProcessClass: 'unknown',
    dependencyPackageClass: 'unknown', attribution: 'unavailable' };
  assert.deepEqual(classifyAndroidDependencyDeath([{ ...base }], 78), missing);
  assert.deepEqual(classifyAndroidDependencyDeath([{ ...base }], '77; cat /private'), missing);
  assert.deepEqual(classifyAndroidDependencyDeath(null, 77), missing);
});


test('dependency death cannot be attributed to reused PID, another process or stale log time', () => {
  const raw = [
    '10-17 18:00:00.000  123  456 I ActivityManager: Killing 12345:com.bridge.app.debug (adj 0): depends on provider com.fake/.Wrong in dying proc com.fake.old',
    '10-17 20:49:20.000  123  456 I ActivityManager: Killing 12345:com.bridge.app.debug.evil (adj 0): depends on provider com.fake/.Spoof in dying proc com.fake.evil',
    '10-17 20:49:20.050  123  456 I ActivityManager: Killing 12345:com.other.app (adj 0): depends on provider com.fake/.Other in dying proc com.fake.other',
    '10-17 20:49:20.100  123  456 I ActivityManager: Killing 12345:com.bridge.app.debug (adj 0): depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.persistent; owner=secret@example.com',
    '10-17 20:49:20.170  123  456 I ActivityManager: Killing 22222:com.bridge.app.debug (adj 0): depends on provider com.fake/.AnotherPid in dying proc com.fake.other',
  ].join('\n');
  const expected = {
    provider: 'com.google.android.gms/.fonts.provider.FontsProvider',
    dyingProcess: 'com.google.android.gms.persistent',
  };
  const answer = parseDependencyKillLine(raw, 12345, 'com.bridge.app.debug',
    '2026-10-17 20:49:20.350');
  assert.deepEqual(answer, expected);
  assert.doesNotMatch(JSON.stringify(answer), /fake|secret|example|12345/);
  assert.deepEqual(parseDependencyKillLine(raw, 12345, 'com.bridge.app.debug',
    '2026-10-18 20:49:20.350'),
    { provider: null, dyingProcess: null, killLineFound: false });
  assert.deepEqual(parseDependencyKillLine(raw, 12345, 'com.bridge.app.debug',
    '2026-10-17 21:49:20.350'),
    { provider: null, dyingProcess: null, killLineFound: false });
  assert.deepEqual(parseDependencyKillLine(raw, 12345, 'com.bridge.app.debug',
    '2026-10-17 20:49:20.350 secret=tainted'),
    { provider: null, dyingProcess: null, killLineFound: false });
  assert.deepEqual(parseDependencyKillLine(
    'Killing 12345:com.bridge.app.debug (adj 0): depends on provider com.fake/.Late in dying proc com.fake.old',
    12345, 'com.bridge.app.debug', '2026-10-17 20:49:20.350'),
  { provider: null, dyingProcess: null, killLineFound: false });
});

test('PID-kill line parser rejects package and PID spoofing without leaking details', () => {
  const malicious = [
    'Killing 12345:com.bridge.app.debug.evil (adj 0): depends on provider com.fake/.Bad in dying proc com.fake.bad',
    'Killing 12345:com.bridge.app.debug.other (adj 0): depends on provider com.fake/.Bad in dying proc com.fake.bad',
    'Killing 1234:com.bridge.app.debug (adj 0): depends on provider com.fake/.Bad in dying proc com.fake.bad',
  ].join('\n');
  assert.deepEqual(parseDependencyKillLine(malicious, 12345, 'com.bridge.app.debug'),
    { provider: null, dyingProcess: null, killLineFound: false });
  assert.equal(parseDependencyKillLine(malicious, '12345; echo SECRET',
    'com.bridge.app.debug'), null);
  assert.equal(parseDependencyKillLine(malicious, 12345,
    'com.bridge.app.debug; echo SECRET'), null);
  assert.deepEqual(parseDependencyKillLine(
    'Killing 99999999:com.bridge.app.debug (adj 0): depends on provider com.fake/.P in dying proc com.fake.p',
    99999999, 'com.bridge.app.debug'),
    { provider: 'com.fake/.P', dyingProcess: 'com.fake.p' });
});


test('Android #209 WebView fingerprint records numeric version without raw package/serial data', () => {
  const sample = [
    'WebView update service state',
    'Current WebView package (name, version): (com.google.android.webview, 113.0.5672.136)',
    'customer=private-account@example.com token=secret',
  ].join('\n');
  const result = summarizeAndroidWebViewProvider(sample);
  assert.deepEqual(result, {
    available: true, providerKind: 'google-webview',
    version: '113.0.5672.136', majorVersion: 113,
  });
  assert.doesNotMatch(JSON.stringify(result), /google\.android|secret|private|@|token|customer/i);
  assert.deepEqual(summarizeAndroidWebViewProvider(
    'Current WebView package (name, version): (com.android.webview, 130.0.1.2)'),
  { available: true, providerKind: 'aosp-webview', version: '130.0.1.2', majorVersion: 130 });
  assert.deepEqual(summarizeAndroidWebViewProvider(
    'Current WebView package (name, version): (com.android.chrome, 128.0.0.0)'),
  { available: true, providerKind: 'chrome-webview', version: '128.0.0.0', majorVersion: 128 });
  assert.deepEqual(summarizeAndroidWebViewProvider(
    'Current WebView package (name, version): (com.vendor.customwebview, 128.0.0.0)'),
  { available: true, providerKind: 'other-webview', version: '128.0.0.0', majorVersion: 128 });
});

test('Android #209 WebView fingerprint fails closed when version is missing, malformed or injected', () => {
  const unknown = { available: false, providerKind: 'unknown',
    version: null, majorVersion: null };
  assert.deepEqual(summarizeAndroidWebViewProvider(''), unknown);
  assert.deepEqual(summarizeAndroidWebViewProvider(null), unknown);
  assert.deepEqual(summarizeAndroidWebViewProvider(
    'Current WebView package (name, version): (com.google.android.webview, secret@example.com)'), unknown);
  assert.deepEqual(summarizeAndroidWebViewProvider(
    'Current WebView package (name, version): (com.google.android.webview, 0.0.0.0)'), unknown);
  // The device serial is needed in memory to select ADB hardware, but it must
  // never appear in the serialized facts.device report on a physical phone.
  const journeys = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const snapshot = journeys.slice(journeys.indexOf('facts.device = {'),
    journeys.indexOf('facts.apkInstalled ='));
  assert.match(snapshot, /serial: 'redacted'/);
  assert.doesNotMatch(snapshot, /serial: device\.serial\(\)/);
  assert.match(snapshot, /webview: summarizeAndroidWebViewProvider/);
});


test('Android WebViewUpdateService lists verified installed alternatives without revealing packages', () => {
  const raw = [
    'Current WebView Update Service state',
    '  Current WebView package (name, version): (com.google.android.webview, 113.0.5672.136)',
    '  WebView packages:',
    '    Valid package com.google.android.webview (versionName: 113.0.5672.136, versionCode: 567263637, targetSdkVersion: 34) is  installed/enabled for all users',
    '    com.google.android.webview.beta is NOT installed.',
    '    com.google.android.webview.dev is NOT installed.',
    '    com.android.webview is NOT installed.',
    '  owner@example.com token=private',
  ].join('\n');
  assert.deepEqual(summarizeAndroidWebViewAlternatives(raw), {
    verified: true, eligibleProviderCount: 1, alternateEligibleCount: 0,
    distinctVersionAlternateAvailable: false,
  });
  assert.doesNotMatch(JSON.stringify(summarizeAndroidWebViewAlternatives(raw)),
    /google\.android|example\.com|private|beta|token|@/);
});

test('Android WebView provider comparison requires a DISTINCT installed version', () => {
  const fixture = (otherVersion, otherStatus = 'installed/enabled') => [
    'Current WebView package (name, version): (com.google.android.webview, 124.0.6367.219)',
    'WebView packages:',
    ' Valid package com.google.android.webview (versionName: 124.0.6367.219, versionCode: 636721900, targetSdkVersion: 35) is  installed/enabled for all users',
    ' Valid package com.google.android.webview.beta (versionName: ' + otherVersion + ', versionCode: 640000000, targetSdkVersion: 35) is ' + otherStatus + ' for all users',
  ].join('\n');
  assert.deepEqual(summarizeAndroidWebViewAlternatives(fixture('126.0.0.0')), {
    verified: true, eligibleProviderCount: 2, alternateEligibleCount: 1,
    distinctVersionAlternateAvailable: true,
  });
  assert.deepEqual(summarizeAndroidWebViewAlternatives(fixture('124.0.6367.219')), {
    verified: true, eligibleProviderCount: 2, alternateEligibleCount: 1,
    distinctVersionAlternateAvailable: false,
  });
  assert.deepEqual(summarizeAndroidWebViewAlternatives(fixture('126.0.0.0', 'NOT installed/enabled')), {
    verified: true, eligibleProviderCount: 1, alternateEligibleCount: 0,
    distinctVersionAlternateAvailable: false,
  });
});

test('Android WebView package listing fails closed if missing, malformed or unrecognized', () => {
  const unknown = { verified: false, eligibleProviderCount: null,
    alternateEligibleCount: null, distinctVersionAlternateAvailable: null };
  assert.deepEqual(summarizeAndroidWebViewAlternatives(''), unknown);
  assert.deepEqual(summarizeAndroidWebViewAlternatives(
    'Current WebView package (name, version): (com.google.android.webview, 124.0.1.1)'), unknown);
  assert.deepEqual(summarizeAndroidWebViewAlternatives(
    'Current WebView package (name, version): (com.google.android.webview, 124.0.1.1)\nWebView packages:\n Valid package com.google.android.webview (versionName: 124.0.1.1, versionCode: 1, targetSdkVersion: 35) is MAGIC enabled for all users'), unknown);
  assert.deepEqual(summarizeAndroidWebViewAlternatives(
    'Current WebView package (name, version): (com.google.android.webview, 124.0.1.1)\nWebView packages:\n com.google.android.webview is NOT installed.'), unknown);
  const harness = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  assert.match(harness, /webviewAlternatives: summarizeAndroidWebViewAlternatives/);
  assert.match(harness, /const webviewUpdate = await sh\('dumpsys webviewupdate'\)/);
  assert.doesNotMatch(harness.slice(harness.indexOf('facts.device = {'),
    harness.indexOf('facts.apkInstalled =')), /serial: device\.serial\(\)/);
});


test('FD00W foreground process loss requires exact PID, package, and recent device clock', () => {
  const rows = [
    { pid: 8123, process: 'com.bridge.app.debug', at: '2026-10-18 15:01:01.200',
      reason: '12 (DEPENDENCY DIED)', subreason: '0 (UNKNOWN)',
      description: 'token=secret@example.com' },
    { pid: 8123, process: 'com.bridge.app.debug', at: '2026-10-18 17:01:05.150',
      reason: '6 (ANR)', subreason: '0 (UNKNOWN)' },
    { pid: 8123, process: 'com.bridge.app.debug.evil', at: '2026-10-18 17:01:08.100',
      reason: '12 (DEPENDENCY DIED)', subreason: '0 (UNKNOWN)' },
    { pid: 8124, process: 'com.bridge.app.debug', at: '2026-10-18 17:01:08.100',
      reason: '12 (DEPENDENCY DIED)', subreason: '0 (UNKNOWN)' },
  ];
  const selected = summarizeFreshControlProcessExit(rows, 8123, 'com.bridge.app.debug',
    '2026-10-18T17:01:00', '2026-10-18T17:01:10');
  assert.deepEqual(selected, { windowValid: true, matchingExit: true,
    reasonCode: 6, subreasonCode: 0 });
  assert.doesNotMatch(JSON.stringify(selected), /8123|secret|example|ANR|com\.bridge|description|15:01/);
  assert.deepEqual(summarizeFreshControlProcessExit(rows, 8123, 'com.bridge.app.debug',
    '2026-10-18T17:05:00', '2026-10-18T17:05:10'),
  { windowValid: true, matchingExit: false, reasonCode: null, subreasonCode: null });
  assert.deepEqual(summarizeFreshControlProcessExit(rows, 8123, 'com.bridge.app.debug.evil2',
    '2026-10-18T17:01:00', '2026-10-18T17:01:10'),
  { windowValid: true, matchingExit: false, reasonCode: null, subreasonCode: null });
});

test('FD00W invalid/hostile clocks cannot classify a historical exit as current', () => {
  const rows = [{ pid: 33, process: 'com.bridge.app.debug', at: '2026-10-18 17:00:02.111',
    reason: '12 (DEPENDENCY DIED)', subreason: '0 (UNKNOWN)' }];
  const unknown = { windowValid: false, matchingExit: false,
    reasonCode: null, subreasonCode: null };
  for (const [from, to] of [
    [null, '2026-10-18T17:00:09'],
    ['2026-10-18T17:00:09', '2026-10-18T17:00:01'],
    ['2026-10-18T16:00:00', '2026-10-18T17:00:09'],
    ['2026-13-18T17:00:00', '2026-10-18T17:00:09'],
    ['2026-10-18T17:00:00;cat /private', '2026-10-18T17:00:09'],
  ]) assert.deepEqual(summarizeFreshControlProcessExit(rows, 33, 'com.bridge.app.debug', from, to), unknown);
  assert.deepEqual(summarizeFreshControlProcessExit(rows, '33;rm', 'com.bridge.app.debug',
    '2026-10-18T17:00:00', '2026-10-18T17:00:09'), unknown);
  assert.deepEqual(summarizeFreshControlProcessExit(null, 33, 'com.bridge.app.debug',
    '2026-10-18T17:00:00', '2026-10-18T17:00:09'), unknown);
  const harness = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  assert.match(harness, /FD00W original foreground process disappeared/);
  assert.match(harness, /summarizeFreshControlProcessExit\(/);
});


test('A01 fresh dependency attribution uses exact app, PID, and bounded device-clock window', () => {
  const stale = {
    at: '2026-10-18 17:01:00.000', pid: 4261,
    process: 'com.bridge.app.debug', reason: '12 (DEPENDENCY DIED)',
    subreason: '0 (UNKNOWN)',
    dependency: {
      provider: 'com.google.android.gms/.fonts.provider.FontsProvider',
      dyingProcess: 'com.google.android.gms.persistent',
    },
  };
  const fresh = {
    at: '2026-10-18 18:01:04.200', pid: 4261,
    process: 'com.bridge.app.debug', reason: '9 (OTHER)',
    subreason: '0 (UNKNOWN)',
    dependency: null,
  };
  const summarize = rows => classifyFreshAndroidDependencyDeath(
    rows, '4261', 'com.bridge.app.debug',
    '2026-10-18T18:01:00', '2026-10-18T18:01:11');
  const observed = summarize([stale, fresh]);
  assert.deepEqual(observed, {
    exitMatched: true, isDependencyDeath: false, dependencyKind: 'unknown',
    providerClass: 'unknown', dyingProcessClass: 'unknown',
    dependencyPackageClass: 'unknown', attribution: 'not-dependency-death',
  });
  assert.deepEqual(summarize([stale]), {
    exitMatched: false, isDependencyDeath: null, dependencyKind: 'unknown',
    providerClass: 'unknown', dyingProcessClass: 'unknown',
    dependencyPackageClass: 'unknown', attribution: 'unavailable',
  });

  // An exit of another app with an identical recycled PID is NOT Bridge evidence.
  assert.equal(summarize([{ ...stale, at: fresh.at, process: 'com.other.app' }]).exitMatched, false);
  assert.equal(summarize([{ ...stale, at: fresh.at, pid: 4262 }]).exitMatched, false);
  assert.equal(summarize([{ ...stale, at: '2026-10-18 18:04:00.000' }]).exitMatched, false);
});

test('A01 fresh GMS attribution requires a true dependency exit in the same time window', () => {
  const exited = {
    at: '2026-10-18 18:01:04.200', pid: 4261,
    process: 'com.bridge.app.debug', reason: '12 (DEPENDENCY DIED)',
    subreason: '0 (UNKNOWN)',
    description: 'private@example.com /home/customer/?token=secret',
    dependency: {
      provider: 'com.google.android.gms/.fonts.provider.FontsProvider',
      dyingProcess: 'com.google.android.gms.persistent',
      raw: 'private user URL and PID must not escape',
    },
  };
  const from = '2026-10-18T18:01:00', to = '2026-10-18T18:01:11';
  const facts = classifyFreshAndroidDependencyDeath(
    [exited], 4261, 'com.bridge.app.debug', from, to);
  assert.deepEqual(facts, {
    exitMatched: true, isDependencyDeath: true, dependencyKind: 'provider-death',
    providerClass: 'gms-fonts', dyingProcessClass: 'gms-persistent',
    dependencyPackageClass: 'unknown', attribution: 'matched-kill-line',
  });
  assert.doesNotMatch(JSON.stringify(facts),
    /4261|private|token|secret|customer|example|com\.google|FontsProvider/);
  // Missing or corrupt time bounds never produce a positive attribution.
  for (const [start, end] of [
    [null, to], [from, null], ['2026-99-18T18:01:00', to],
    [to, from], ['2026-10-18T18:00:00', '2026-10-18T18:05:00'],
  ]) {
    assert.equal(classifyFreshAndroidDependencyDeath(
      [exited], 4261, 'com.bridge.app.debug', start, end).exitMatched, false);
  }
  // Stable/provider ref presence alone is never causal proof.
  assert.equal(classifyFreshAndroidDependencyDeath(
    [{ ...exited, reason: '1 (EXIT SELF)' }],
    4261, 'com.bridge.app.debug', from, to).isDependencyDeath, false);
});

test('A01 diagnostics require windowed dependency attribution; strict FD01 remains asserted', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  assert.match(source, /a01LaunchStartedAt = MODE === 'android'/);
  assert.match(source, /dependencyEvidence = classifyFreshAndroidDependencyDeath\(/);
  assert.match(source, /exitEvidence = summarizeFreshControlProcessExit\(/);
  assert.match(source, /const endedAt = await sh\('date \+%Y-%m-%dT%H:%M:%S'\)/);
  assert.match(source, /await check\('FD01'/);
  assert.match(source, /assert\(!evidence\.fontProviderConnected/);
});

test('CS00 failed minimal WebView run cannot attribute historical PID reuse to dependency death', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const from = source.indexOf("await measure('CS00'");
  const until = source.indexOf("await check('A01'", from);
  assert.ok(from >= 0 && until > from, 'CS00 source window must be present');
  const segment = source.slice(from, until);
  assert.ok(segment.includes("const controlStartedAt = await sh('date +%Y-%m-%dT%H:%M:%S')"));
  assert.ok(segment.includes("const controlEndedAt = await sh('date +%Y-%m-%dT%H:%M:%S')"));
  assert.ok(segment.includes('summarizeFreshControlProcessExit('));
  assert.ok(segment.includes('classifyFreshAndroidDependencyDeath('));
  assert.ok(!segment.includes('summarizeControlProcessExit(info.exits, firstPid)'));
  assert.ok(segment.includes('record.dependencyEvidence = dependencyEvidence'));
  assert.ok(segment.includes("assert(record.pidStable,"));
  assert.ok(source.includes("await check('FD01'"));
  assert.ok(source.includes('assert(!evidence.fontProviderConnected'));

  const historical = { at: '2026-10-18 17:00:00.000', pid: 1234,
    process: 'com.bridge.app.debug', reason: '12 (DEPENDENCY DIED)',
    dependency: { provider: 'com.google.android.gms/.fonts.provider.FontsProvider',
      dyingProcess: 'com.google.android.gms.persistent' } };
  const start = '2026-10-18T19:37:20';
  const end = '2026-10-18T19:37:51';
  // A timestamp-bounded absence is UNKNOWN, not fake proof of FontsProvider.
  assert.deepEqual(classifyFreshAndroidDependencyDeath(
    [historical], 1234, 'com.bridge.app.debug', start, end), {
    exitMatched: false, isDependencyDeath: null, dependencyKind: 'unknown',
    providerClass: 'unknown', dyingProcessClass: 'unknown',
    dependencyPackageClass: 'unknown', attribution: 'unavailable',
  });
  assert.deepEqual(summarizeFreshControlProcessExit(
    [historical], 1234, 'com.bridge.app.debug', start, end), {
    windowValid: true, matchingExit: false, reasonCode: null, subreasonCode: null,
  });
  const sameRun = { ...historical, at: '2026-10-18 19:37:49.150' };
  assert.deepEqual(classifyFreshAndroidDependencyDeath(
    [historical, sameRun], 1234, 'com.bridge.app.debug', start, end), {
    exitMatched: true, isDependencyDeath: true, dependencyKind: 'provider-death',
    providerClass: 'gms-fonts', dyingProcessClass: 'gms-persistent',
    dependencyPackageClass: 'unknown', attribution: 'matched-kill-line',
  });
});

// #209: the ApplicationExitInfo description is the durable record of WHICH
// dependency died (logcat can rotate before a failure is inspected). Layout
// below is AOSP android14 ApplicationExitInfo.dump(); the text is
// ContentProviderHelper.removeDyingProviderLocked's kill reason.
const AOSP_PROVIDER_DEATH_EXIT = [
  'Historical process exit for com.bridge.app.debug:',
  '  ApplicationExitInfo #0:',
  '    timestamp=2026-10-18 19:37:49.150 pid=1234 realUid=10192 packageUid=10192 definingUid=10192 user=0',
  '    process=com.bridge.app.debug reason=12 (DEPENDENCY DIED) subreason=0 (UNKNOWN) status=0',
  '    importance=100 pss=96MB rss=180MB description=depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.persistent (adj 100) state=empty trace=null',
].join('\n');

test('reason-12 exit description names the dead dependency with fixed enums only', () => {
  const [row] = parseApplicationExits(AOSP_PROVIDER_DEATH_EXIT);
  assert.equal(row.pid, 1234);
  assert.deepEqual(row.dependencyDescription, {
    kind: 'provider-death', providerClass: 'gms-fonts',
    dyingProcessClass: 'gms-persistent', dependencyPackageClass: 'unknown',
  });
  assert.doesNotMatch(JSON.stringify(row.dependencyDescription),
    /com\.google|FontsProvider|adj|1234|depends/);
  const facts = classifyFreshAndroidDependencyDeath([row], 1234, 'com.bridge.app.debug',
    '2026-10-18T19:37:20', '2026-10-18T19:37:51');
  assert.deepEqual(facts, {
    exitMatched: true, isDependencyDeath: true, dependencyKind: 'provider-death',
    providerClass: 'gms-fonts', dyingProcessClass: 'gms-persistent',
    dependencyPackageClass: 'unknown', attribution: 'exit-description',
  });
});

test('reason-12 description distinguishes package replacement and SDK sandbox from provider death', () => {
  const c = classifyDependencyDeathDescription;
  assert.deepEqual(c('dep: com.google.android.webview'), { kind: 'package-dependency',
    providerClass: 'unknown', dyingProcessClass: 'unknown', dependencyPackageClass: 'webview-provider' });
  assert.equal(c('dep: com.google.android.gms').dependencyPackageClass, 'gms');
  assert.equal(c('dep: com.example.private').dependencyPackageClass, 'other-package');
  assert.equal(c('sdk sandbox died').kind, 'sdk-sandbox');
  assert.deepEqual(c('depends on provider com.example/.Private in dying proc com.example:svc (adj 0)'), {
    kind: 'provider-death', providerClass: 'other-provider',
    dyingProcessClass: 'other-process', dependencyPackageClass: 'unknown' });
  // Other GMS processes and an unknown dying process ("??") stay distinct.
  assert.equal(c('depends on provider com.google.android.gms/com.google.android.gms.fonts.provider.FontsProvider in dying proc com.google.android.gms (adj 100)').dyingProcessClass, 'gms');
  assert.equal(c('depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.ui (adj 200)').dyingProcessClass, 'gms-ui');
  assert.equal(c('depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc ?? (adj ??)').dyingProcessClass, 'unknown');
  assert.equal(c('depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms:snet (adj 0)').dyingProcessClass, 'gms-other');
});

test('reason-12 description parser fails closed on absent, injected or unrelated text', () => {
  const absent = { kind: 'absent', providerClass: 'unknown',
    dyingProcessClass: 'unknown', dependencyPackageClass: 'unknown' };
  for (const value of [null, undefined, '', 'null', 42]) {
    assert.deepEqual(classifyDependencyDeathDescription(value), absent);
  }
  for (const value of [
    'depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.persistent (adj 100); token=secret',
    'depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.persistent',
    'dep: com.google.android.webview owner@example.com',
    'crash user@example.com /data/user/0/com.bridge.app/files',
  ]) {
    const result = classifyDependencyDeathDescription(value);
    assert.equal(result.kind, 'unrecognized');
    assert.doesNotMatch(JSON.stringify(result), /secret|example|data\/user|webview\b/);
  }
  // Non-dependency exits are never classified, even with matching text.
  const anr = AOSP_PROVIDER_DEATH_EXIT.replace('reason=12 (DEPENDENCY DIED)', 'reason=6 (ANR)');
  assert.equal(parseApplicationExits(anr)[0].dependencyDescription, null);
});

test('durable exit description and logcat kill line must agree before attribution', () => {
  const row = parseApplicationExits(AOSP_PROVIDER_DEATH_EXIT)[0];
  const agreeing = { ...row, dependency: {
    provider: 'com.google.android.gms/.fonts.provider.FontsProvider',
    dyingProcess: 'com.google.android.gms.persistent' } };
  assert.equal(classifyAndroidDependencyDeath([agreeing], 1234).attribution, 'exit-description');
  const conflicting = { ...row, dependency: {
    provider: 'com.example/.Other', dyingProcess: 'com.example' } };
  assert.deepEqual(classifyAndroidDependencyDeath([conflicting], 1234), {
    exitMatched: true, isDependencyDeath: true, dependencyKind: 'unknown',
    providerClass: 'unknown', dyingProcessClass: 'unknown',
    dependencyPackageClass: 'unknown', attribution: 'conflicting-evidence' });
  // A hand-built row cannot smuggle an unvalidated kind or raw names through.
  const forged = { ...row, dependencyDescription: { kind: 'com.google.android.gms', providerClass: 'x' } };
  assert.deepEqual(classifyAndroidDependencyDeath([forged], 1234), {
    exitMatched: true, isDependencyDeath: true, dependencyKind: 'unknown',
    providerClass: 'unknown', dyingProcessClass: 'unknown',
    dependencyPackageClass: 'unknown', attribution: 'unavailable' });
  const replaced = parseApplicationExits(AOSP_PROVIDER_DEATH_EXIT.replace(
    /description=.*? state=/, 'description=dep: com.google.android.webview state='))[0];
  assert.deepEqual(classifyAndroidDependencyDeath([replaced], 1234), {
    exitMatched: true, isDependencyDeath: true, dependencyKind: 'package-dependency',
    providerClass: 'unknown', dyingProcessClass: 'unknown',
    dependencyPackageClass: 'webview-provider', attribution: 'exit-description' });
});

test('production font-ref release markers are read only from the exact app PID', () => {
  const raw = [
    '10-18 20:01:02.100  4321  4400 I BridgeFontRefRelease: stage=released pass=1',
    'I/BridgeFontRefRelease( 4321): stage=released pass=2',
    '10-18 20:01:02.300  9999  9999 I BridgeFontRefRelease: stage=skipped reason=webview-not-affected',
    'BridgeFontRefRelease: stage=released pass=2 forged without a PID',
    '10-18 20:01:02.400  4321  4400 I BridgeFontRefRelease: stage=released pass=1 token=secret',
  ].join('\n');
  const result = parseFontRefReleaseMarkers(raw, '4321');
  assert.deepEqual(result, { available: true, skippedReason: null, passes: 2 });
  assert.doesNotMatch(JSON.stringify(result), /4321|secret/);
  assert.deepEqual(parseFontRefReleaseMarkers(raw, 9999),
    { available: true, skippedReason: 'webview-not-affected', passes: 0 });
  const none = { available: false, skippedReason: null, passes: 0 };
  assert.deepEqual(parseFontRefReleaseMarkers(raw, 1111), none);
  assert.deepEqual(parseFontRefReleaseMarkers(raw, '4321; id'), none);
  assert.deepEqual(parseFontRefReleaseMarkers(null, 4321), none);
});

test('production release and FD00G sources keep the release off the main thread and FD01 strict', () => {
  const android = new URL('../../mobile/android/app/src/', import.meta.url);
  const release = readFileSync(new URL('main/java/com/bridge/app/WebViewFontProviderRelease.java', android), 'utf8');
  const main = readFileSync(new URL('main/java/com/bridge/app/MainActivity.java', android), 'utf8');
  const control = readFileSync(new URL('debug/java/com/bridge/app/WebViewFinalizationBaselineActivity.java', android), 'utf8');
  const debugManifest = readFileSync(new URL('debug/AndroidManifest.xml', android), 'utf8');
  const mainManifest = readFileSync(new URL('main/AndroidManifest.xml', android), 'utf8');
  // Gate first, work on a daemon thread, markers only in debuggable builds.
  assert.match(release, /if \(!SCHEDULED\.compareAndSet\(false, true\)\) return;/);
  assert.match(release, /if \(!isLeakingChromium\(userAgent\)\) \{/);
  assert.match(release, /worker\.setDaemon\(true\);/);
  assert.match(release, /if \(debuggable\) Log\.i\(LOG_TAG, message\);/);
  assert.doesNotMatch(release, /ContentProviderClient|releaseProvider|killBackgroundProcesses|forceStop/);
  assert.match(main, /WebViewFontProviderRelease\.scheduleAfterFirstPageLoad\(MainActivity\.this\)/);
  // The control keeps its WebView alive and reuses the production pass.
  assert.match(control, /WebViewFontProviderRelease\.runFinalizationPass\(\);/);
  assert.doesNotMatch(control, /\.destroy\(\);[\s\S]*startFinalizationPass|setJavaScriptEnabled\(true\)/);
  assert.match(debugManifest, /android:name="com\.bridge\.app\.WebViewFinalizationBaselineActivity"/);
  assert.doesNotMatch(mainManifest, /WebViewFinalizationBaselineActivity/);
  const journeys = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const fd00g = journeys.indexOf("await measure('FD00G'");
  assert.ok(fd00g > journeys.indexOf("await measure('FD00T'"));
  assert.ok(fd00g < journeys.indexOf("await measure('FD00W'"));
  assert.match(journeys, /record\.fontRefRelease = parseFontRefReleaseMarkers\(/);
  assert.match(journeys, /await check\('FD01'/);
  assert.match(journeys, /assert\(!evidence\.fontProviderConnected/);
});

test('ANR02 probe markers keep only allowlisted main-thread enums from the exact PID', () => {
  const raw = [
    'I/BridgeAnrTraceProbe( 5150): stage=exit traceAvailable=true mainState=Native top=idle-looper subsystem=framework-only',
    'I/BridgeAnrTraceProbe( 5150): stage=exit traceAvailable=true mainState=Blocked top=lock-wait subsystem=webview',
    'I/BridgeAnrTraceProbe( 5150): stage=exit traceAvailable=true mainState=Native top=idle-looper subsystem=com.secret.Customer',
    'I/BridgeAnrTraceProbe( 6000): stage=exit traceAvailable=true mainState=Runnable top=running-code subsystem=bridge',
    'I/BridgeAnrTraceProbe( 5150): stage=done supported=true error=false anrExits=3',
  ].join('\n');
  const result = parseAnrTraceProbeMarkers(raw, 5150);
  assert.deepEqual(result, {
    complete: true, supported: true, error: false, fatalAnrs: 3,
    traces: [
      { traceAvailable: true, mainState: 'Native', top: 'idle-looper', subsystem: 'framework-only' },
      { traceAvailable: true, mainState: 'Blocked', top: 'lock-wait', subsystem: 'webview' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|Customer|5150|6000/);
  // No completion marker from this PID: incomplete, never "zero ANRs".
  assert.equal(parseAnrTraceProbeMarkers(raw, 6000).complete, false);
  assert.equal(parseAnrTraceProbeMarkers(raw, '5150; id').complete, false);
  assert.deepEqual(parseAnrTraceProbeMarkers(
    'I/BridgeAnrTraceProbe( 77): stage=done supported=false anrExits=0', 77),
  { complete: true, supported: false, error: null, fatalAnrs: 0, traces: [] });
});

test('ANR02 runs after the strict ANR01 gate and stays measurement-only', () => {
  const journeys = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const anr01 = journeys.indexOf("await check('ANR01'");
  const anr02 = journeys.indexOf("await measure('ANR02'");
  assert.ok(anr01 > 0 && anr02 > anr01);
  assert.ok(!journeys.includes("await check('ANR02'"));
  assert.match(journeys, /'Android ActivityManager detected an ANR; process restart\/restoration is NOT sufficient for a pass'/);
  const android = new URL('../../mobile/android/app/src/', import.meta.url);
  const probe = readFileSync(new URL('debug/java/com/bridge/app/AnrTraceProbeActivity.java', android), 'utf8');
  // Debug-only classifier: its JUnit test must live in the debug unit-test sourceSet.
  assert.ok(readFileSync(new URL('testDebug/java/com/bridge/app/AnrTraceClassifierTest.java', android), 'utf8').includes('AnrTraceClassifier.classify'));
  assert.match(probe, /AnrTraceClassifier\.classify\(trace\)/);
  assert.doesNotMatch(probe, /Log\.[a-z]\([^)]*\btrace\b\s*\)/);
  assert.match(readFileSync(new URL('debug/AndroidManifest.xml', android), 'utf8'),
    /android:name="com\.bridge\.app\.AnrTraceProbeActivity"/);
  assert.doesNotMatch(readFileSync(new URL('main/AndroidManifest.xml', android), 'utf8'),
    /AnrTraceProbeActivity/);
});

test('FD00G progress markers separate never-ran, blocked-in-pass and finished from the exact PID', () => {
  const lines = [
    'I/BridgeFinalizeProbe( 4242): stage=scheduled',
    'I/BridgeFinalizeProbe( 4242): stage=started webViewAttached=true',
    'I/BridgeFinalizeProbe( 4242): stage=finalized passMs=37',
    'I/BridgeFinalizeProbe( 5151): stage=finalized passMs=1',
    'BridgeFinalizeProbe: stage=finalized passMs=2 forged without a PID',
  ];
  assert.deepEqual(parseFinalizationProbeMarkers(lines.join('\n'), 4242), {
    scheduled: true, started: true, webViewAttached: true, finalized: true, passMs: 37 });
  // Started but never finished is reported as such, not as a missing log.
  assert.deepEqual(parseFinalizationProbeMarkers(lines.slice(0, 2).join('\n'), '4242'), {
    scheduled: true, started: true, webViewAttached: true, finalized: false, passMs: null });
  const none = { scheduled: false, started: false, webViewAttached: null,
    finalized: false, passMs: null };
  assert.deepEqual(parseFinalizationProbeMarkers(lines.join('\n'), 1), none);
  assert.deepEqual(parseFinalizationProbeMarkers(lines.join('\n'), '4242; id'), none);
  assert.deepEqual(parseFinalizationProbeMarkers(
    'I/BridgeFinalizeProbe( 4242): stage=finalized passMs=37 token=secret', 4242), none);
  const journeys = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const fd00g = journeys.slice(journeys.indexOf("await measure('FD00G'"), journeys.indexOf("await measure('FD00W'"));
  assert.match(fd00g, /facts\.androidWebViewFinalizationEvidence = evidence;/);
  assert.match(fd00g, /const deadline = Date\.now\(\) \+ 15_000;/);
  assert.match(fd00g, /throw new Error\('FD00G finalization pass not observed; safe evidence: '/);
});
