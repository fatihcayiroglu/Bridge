import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Logical viewports only; their names do not claim exact physical inch sizes.
export const androidProfiles = Object.freeze([
  { id: 'compact_320dp', width: 720, height: 1440, dpi: 360 },
  { id: 'phone_393dp', width: 1080, height: 2340, dpi: 440 },
  { id: 'large_411dp', width: 1440, height: 3200, dpi: 560 },
  { id: 'tablet_800dp', width: 1600, height: 2560, dpi: 320 },
]);

export const iosProfiles = Object.freeze([
  { id: 'small_iphone', candidates: ['iPhone 16e', 'iPhone SE (3rd generation)', 'iPhone 13 mini'] },
  { id: 'standard_iphone', candidates: ['iPhone 16', 'iPhone 17', 'iPhone 15'] },
  { id: 'large_iphone', candidates: ['iPhone 16 Pro Max', 'iPhone 17 Pro Max', 'iPhone 15 Pro Max'] },
  { id: 'ipad', candidates: ['iPad (A16)', 'iPad Air 11-inch (M3)', 'iPad Air 11-inch (M2)', 'iPad Pro 11-inch (M4)'] },
]);

export function chooseIosDeviceTypes(deviceTypes, profiles = iosProfiles) {
  if (!Array.isArray(deviceTypes)) throw new Error('IOS_DEVICE_INVENTORY_INVALID');
  return profiles.map(p => {
    const device = p.candidates.map(name => deviceTypes.find(d => d.name === name && d.identifier)).find(Boolean);
    return { id: p.id, deviceType: device?.name ?? null, identifier: device?.identifier ?? null };
  });
}

export function decodeXml(value) {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);|&(quot|apos|lt|gt|amp);/gi, (m, num, named) => {
    if (num) { const code = num.toLowerCase().startsWith('x') ? parseInt(num.slice(1), 16) : Number(num); return String.fromCodePoint(code); }
    return { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[named.toLowerCase()] ?? m;
  });
}

export function parseUiNodes(xml) {
  if (!/<hierarchy\b/.test(xml)) throw new Error('UI_HIERARCHY_MISSING');
  return [...xml.matchAll(/<node\s+([^>]*?)\/?\s*>/g)].map(match => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, decodeXml(v)]));
    const b = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds ?? '');
    return { text: attrs.text ?? '', description: attrs['content-desc'] ?? '',
      clickable: attrs.clickable === 'true', bounds: b ? b.slice(1).map(Number) : null };
  });
}

export function verifyAndroidUi(xml, viewport) {
  const nodes = parseUiNodes(xml);
  const labels = nodes.map(n => `${n.text} ${n.description}`.trim());
  if (labels.some(s => /catalyst_redbox_title|runtime not ready|Unable to load script|NATIVE_ACCEPTANCE_FAILED/i.test(s)))
    throw new Error('ANDROID_RUNTIME_ERROR_SCREEN');
  const title = nodes.find(n => n.text === 'Bridge' || n.description === 'Bridge');
  const session = nodes.find(n => /\bSession:\s*signed-out\b/i.test(`${n.text} ${n.description}`));
  const action = nodes.find(n => n.text === 'Sign in with your browser' || n.description === 'Sign in with your browser');
  for (const [name, node] of [['BRIDGE_TITLE', title], ['SESSION_STATE', session], ['SIGN_IN_ACTION', action]]) {
    if (!node) throw new Error(`${name}_MISSING`);
    if (!node.bounds) throw new Error(`${name}_BOUNDS_MISSING`);
    const [x1, y1, x2, y2] = node.bounds;
    if (!(x1 >= 0 && y1 >= 0 && x2 > x1 && y2 > y1 && x2 <= viewport.width && y2 <= viewport.height))
      throw new Error(`${name}_CLIPPED`);
  }
  return { verdict: 'PASS', matched: ['Bridge', 'Session', 'Sign in with your browser'], viewport };
}

export function initialEvidence(platform) {
  const profiles = platform === 'android' ? androidProfiles : platform === 'ios' ? iosProfiles : null;
  if (!profiles) throw new Error('UNKNOWN_PLATFORM');
  return { platform, scope: 'signed-out-native-ui-layout-smoke', physicalHardware: false,
    fullCompatibility: false, profiles: Object.fromEntries(profiles.map(p => [p.id, { result: 'NOT_EXECUTED' }])) };
}

export function recordEvidence(evidence, id, result, reason = '') {
  if (!Object.hasOwn(evidence.profiles, id) || !['PASS', 'FAIL', 'NOT_EXECUTED'].includes(result)) throw new Error('INVALID_PROFILE_RESULT');
  if (result !== 'PASS' && !reason) throw new Error('FAILURE_REASON_REQUIRED');
  if (evidence.profiles[id].result !== 'NOT_EXECUTED') throw new Error('PROFILE_ALREADY_EXECUTED');
  evidence.profiles[id] = { result, ...(reason ? { reason } : {}) };
  return evidence;
}

export function assertComplete(evidence) {
  const entries = Object.values(evidence.profiles);
  if (!entries.length || entries.some(x => x.result !== 'PASS')) throw new Error('LAYOUT_NOT_ALL_PROFILES_PASSED');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'android-tsv') {
      for (const p of androidProfiles) console.log(`${p.id}\t${p.width}\t${p.height}\t${p.dpi}`);
    } else if (command === 'ios-device-types') {
      const inventory = JSON.parse(readFileSync(args[0], 'utf8'));
      for (const p of chooseIosDeviceTypes(inventory.devicetypes)) console.log(`${p.id}\t${p.identifier ?? 'UNAVAILABLE'}\t${p.deviceType ?? 'UNAVAILABLE'}`);
    } else if (command === 'verify-android') {
      console.log(JSON.stringify(verifyAndroidUi(readFileSync(args[0], 'utf8'), { width: Number(args[1]), height: Number(args[2]) })));
    } else if (command === 'init') {
      writeFileSync(args[1], JSON.stringify(initialEvidence(args[0]), null, 2) + '\n');
    } else if (command === 'set') {
      const evidence = JSON.parse(readFileSync(args[0], 'utf8'));
      recordEvidence(evidence, args[1], args[2], args[3]);
      writeFileSync(args[0], JSON.stringify(evidence, null, 2) + '\n');
    } else if (command === 'assert-complete') {
      assertComplete(JSON.parse(readFileSync(args[0], 'utf8')));
    } else throw new Error('UNKNOWN_COMMAND');
  } catch (err) { console.error(`NATIVE_LAYOUT_ERROR: ${err.message}`); process.exitCode = 1; }
}
