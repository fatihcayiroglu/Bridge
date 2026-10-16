import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicationExits, parseDependencyKillLine, parseActivityManagerAnrs, parseAnrCpuPressure, parseWebViewDevToolsSockets, inspectBridgeEmojiFontProvider, parseNativeEmojiStartupProbe } from './exit-diagnostics.mjs';

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


test('native EmojiCompat class-presence diagnostic parses fixed-shape Boolean state only', () => {
  const raw = [
    '10-17 I/BridgeEmojiStartupProbe( 5304): stage=before-super classPresent=false',
    '10-17 I/BridgeEmojiStartupProbe( 5304): stage=after-super classPresent=false',
    '10-17 I/BridgeEmojiStartupProbe( 5304): stage=resumed classPresent=true',
    '10-17 I/BridgeEmojiStartupProbe( 5304): token=secret@example.com stage=wild classPresent=false',
    '10-17 I/OtherTag( 5304): stage=resumed classPresent=false',
    '10-17 I/BridgeEmojiStartupProbe( 5304): stage=resumed configured=true',
    'PRIVATE phone contact=secret@example.com',
  ].join('\n');
  const result = parseNativeEmojiStartupProbe(raw);
  assert.deepEqual(result, {
    available: true, samples: 3, anyClassPresent: true,
    beforeSuper: false, afterSuper: false, lastResume: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /5304|contact|email|token|PRIVATE|configured/);
  assert.deepEqual(parseNativeEmojiStartupProbe(''), {
    available: false, samples: 0, anyClassPresent: false,
    beforeSuper: null, afterSuper: null, lastResume: null,
  });
});
