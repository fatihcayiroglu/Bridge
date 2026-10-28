import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const preferences = 'shared_prefs/com.bridge.nativepilot_preferences.xml';
const xml = '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map><string name="debug_http_host">127.0.0.1:8081</string></map>\n';
const request = "printf 'GET /status HTTP/1.0\\r\\nHost: 127.0.0.1:8081\\r\\nConnection: close\\r\\n\\r\\n'";
const netcat = 'toybox nc -w 5 -W 5 -q 5 127.0.0.1 8081';
const eofControl = `${request} | ${netcat}`;
// Toybox shuts down the socket's write side on stdin EOF; adb then closes its
// peer stream, so a printf-only pipe can discard the HTTP reply. Keep the input
// open for the existing 5s network bound. Connection: close terminates the read.
const probe = `{ ${request}; sleep 5; } | ${netcat}`;

// Only the disposable, freshly cleared debug fixture is configured. RN's
// PackagerConnectionSettings reads debug_http_host before its emulator default.
export function configureAndroidMetroRoute({ adb = (args, options) => spawnSync('adb', args, options), evidence = {} } = {}) {
  evidence.endpoint = 'http://127.0.0.1:8081';
  evidence.operations = [];
  function command(stage, args, input) {
    evidence.stage = stage;
    const start = performance.now();
    const result = adb(args, { input, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
    evidence.operations.push({ stage, exit: result.status ?? null, signal: result.signal ?? null,
      error: result.error?.code ?? null, bytes: Buffer.byteLength(result.stdout ?? ''), stderr_bytes: Buffer.byteLength(result.stderr ?? ''), elapsed_ms: Math.max(0, Math.round(performance.now() - start)) });
    if (result.error || result.status !== 0) throw new Error(`METRO_ROUTE_${stage.toUpperCase()}_FAILED`);
    return (result.stdout ?? '').replace(/\r/g, '');
  }
  const reverse = command('reverse-check', ['reverse', '--list']);
  if (!/\btcp:8081\s+tcp:8081(?:\s|$)/.test(reverse)) throw new Error('METRO_REVERSE_MAPPING_REQUIRED');
  command('preference-write', ['shell', '-T', `run-as com.bridge.nativepilot sh -c 'mkdir -p shared_prefs && cat > ${preferences}'`], xml);
  const readback = command('preference-read', ['shell', 'run-as', 'com.bridge.nativepilot', 'cat', preferences]);
  if (readback.trim() !== xml.trim()) throw new Error('METRO_ROUTE_PREFERENCE_MISMATCH');
  // A protocol control, not a retry/fallback: retain the old EOF response next
  // to the held-input response under the SAME host/emulator conditions. Only
  // the complete HTTP exchange below can satisfy readiness.
  const control = command('eof-control', ['shell', '-T', eofControl]);
  evidence.eof_control_bytes = Buffer.byteLength(control);
  const response = command('http-check', ['shell', '-T', probe]);
  const boundary = response.indexOf('\n\n');
  const status = response.split('\n', 1)[0];
  const body = boundary < 0 ? '' : response.slice(boundary + 2);
  evidence.http_status = status.slice(0, 100);
  evidence.status_body_matches = body === 'packager-status:running';
  if (!/^HTTP\/1\.[01] 200(?: |$)/.test(status) || !evidence.status_body_matches) throw new Error('METRO_ROUTE_STATUS_REJECTED');
  evidence.verdict = 'PASS';
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = {};
  try { configureAndroidMetroRoute({ evidence }); }
  catch (error) { evidence.verdict = 'FAIL'; evidence.failure = error.message; process.exitCode = 1; }
  mkdirSync('native-evidence', { recursive: true });
  writeFileSync('native-evidence/metro-route.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(`NATIVE_ANDROID_METRO_ROUTE ${JSON.stringify(evidence)}`);
}
