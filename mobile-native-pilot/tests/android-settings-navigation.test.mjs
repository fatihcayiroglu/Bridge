import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigateSettings, MAX_SETTINGS_SWIPES } from '../scripts/android-settings-navigation.mjs';
import { failureReport } from '../scripts/android-auth-failure.mjs';

const row = (text, extra = {}) => ({ text, package: 'com.android.settings', class: 'android.widget.TextView',
  enabled: 'true', clickable: 'true', bounds: '[10,200][400,280]', ...extra });
const source = row('Encryption & credentials'), destination = row('Install a certificate');
function harness(screens, { pin = () => false, failRead } = {}) {
  let index = 0; const taps = [], proofs = []; let swipes = 0;
  return { taps, proofs, get swipes() { return swipes; }, ports: {
    readUi: async () => { if (failRead) throw failRead; return screens[Math.min(index, screens.length - 1)]; },
    answerPin: pin, tap: async n => taps.push(n), swipe: async () => { swipes++; }, record: p => proofs.push(p),
    until: async (probe, label) => {
      for (let i = 0; i < 12; i++) { if (await probe()) return; index++; }
      throw Error('MOBILE_AUTH_DEADLINE:' + label);
    },
  } };
}
test('a swallowed source tap cannot advance: only the next OS screen completes the hop', async () => {
  const h = harness([[source], [source], [destination]]);
  await navigateSettings('credentials', h.ports);
  assert.equal(h.taps.length, 2); assert.equal(h.proofs.at(-1).destinationSeen, true);
  assert.deepEqual(h.proofs.map(p => p.destinationSeen), [false, false, true]);
});
test('repeated successful tap calls without navigation remain a deadline failure', async () => {
  const h = harness([[source]]);
  await assert.rejects(navigateSettings('credentials', h.ports), /MOBILE_AUTH_DEADLINE:settings-credentials/);
  assert.equal(h.proofs.some(p => p.destinationSeen), false); assert.equal(h.taps.length, 12);
});
test('a nonclickable heading is scrolled, while a label with a real clickable row uses that row', async () => {
  const heading = row('Encryption & credentials', { clickable: 'false', bounds: '[0,0][400,50]' });
  const h = harness([[heading], [destination]]); await navigateSettings('credentials', h.ports);
  assert.equal(h.swipes, 1); assert.equal(h.taps.length, 0);
  const label = { ...source, clickable: 'false' }, container = row('', { class: 'android.view.ViewGroup', bounds: '[0,180][420,300]' });
  const h2 = harness([[label, container], [destination]]); await navigateSettings('credentials', h2.ports);
  assert.equal(h2.taps[0], container);
});
test('missing or disabled source controls fail within the existing seven swipe budget', async () => {
  for (const nodes of [[], [{ ...source, enabled: 'false' }], [{ ...source, package: 'com.evil.overlay' }]]) {
    const h = harness([nodes]); await assert.rejects(navigateSettings('credentials', h.ports), /SETTINGS_CONTROL_UNAVAILABLE/);
    assert.equal(h.swipes, MAX_SETTINGS_SWIPES); assert.equal(h.taps.length, 0);
  }
});
test('foreign, disabled or clipped destination labels cannot count as navigation', async () => {
  for (const extra of [{ package: 'com.evil.overlay' }, { enabled: 'false' }, { bounds: '[0,0][0,0]' }]) {
    const h = harness([[{ ...destination, ...extra }]]);
    await assert.rejects(navigateSettings('credentials', h.ports), /SETTINGS_CONTROL_UNAVAILABLE/);
    assert.equal(h.proofs.some(p => p.destinationSeen), false);
  }
  const wrongCase = harness([[row('INSTALL A CERTIFICATE')]]);
  await assert.rejects(navigateSettings('credentials', wrongCase.ports), /SETTINGS_CONTROL_UNAVAILABLE/);
});
test('PIN handling suspends navigation; ambiguous controls and protected-ANR errors propagate', async () => {
  let prompted = false; const h = harness([[source], [destination]], { pin: () => { if (prompted) return false; prompted = true; return true; } });
  await navigateSettings('credentials', h.ports); assert.equal(h.taps.length, 0); assert.equal(h.proofs.at(-1).pinPrompts, 1);
  const ambiguous = harness([[source, { ...source, bounds: '[10,400][400,480]' }]]);
  await assert.rejects(navigateSettings('credentials', ambiguous.ports), /AMBIGUOUS_NATIVE_CONTROL/);
  const broken = harness([[]], { failRead: Error('APP_OR_BROWSER_ANR') });
  await assert.rejects(navigateSettings('credentials', broken.ports), /APP_OR_BROWSER_ANR/);
});
test('the final CA warning keeps exact OS-package scoping and case-insensitive button handling', async () => {
  const h = harness([[row('INSTALL ANYWAY')]]); await navigateSettings('ca-warning', h.ports);
  assert.equal(h.proofs.at(-1).destinationSeen, true); assert.equal(h.taps.length, 0);
  await assert.rejects(navigateSettings('untrusted text', h.ports), /INVALID_SETTINGS_TRANSITION/);
  await assert.rejects(navigateSettings('constructor', h.ports), /INVALID_SETTINGS_TRANSITION/);
});
test('failure evidence is reconstructed from fixed step names and numeric/boolean fields only', () => {
  const report = failureReport({ facts: { settingsNavigation: {
    credentials: { probes: 2, taps: 1, swipes: 0, pinPrompts: 0, destinationSeen: false, secret: 'fixture-secret' },
    'fixture-secret': { probes: 1 },
  } } });
  assert.deepEqual(report.settingsNavigation, [{ step: 'credentials', probes: 2, taps: 1, swipes: 0, pinPrompts: 0, destinationSeen: false }]);
  assert.equal(JSON.stringify(report).includes('fixture-secret'), false);
});
