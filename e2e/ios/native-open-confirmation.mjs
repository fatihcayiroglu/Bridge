// A real OS hand-off, driven through native XCUITest. No synthetic web event or
// navigation API is accepted as delivery evidence. Call with alerts NOT auto-accepted.
import assert from 'node:assert/strict';

export async function verifyNativeOpenConfirmation({ command, native, nativeContext, webContext, js, until, openUrl, channelId, facts }) {
  const bundle = 'com.bridge.app';
  facts.initialChannelDifferent = await js(cid => {
    const active = document.querySelector('.ch-item.active')?.dataset.id;
    return typeof active === 'string' && active !== cid;
  }, channelId);
  assert.equal(facts.initialChannelDifferent, true, 'I07 must start on a different channel');
  await nativeContext();
  const before = await native('activeAppInfo');
  assert.equal(before.bundleId, bundle, 'Bridge must be the foreground native app');
  assert(Number.isSafeInteger(before.pid) && before.pid > 0, 'Native process identity required');
  facts.startedInBridge = true;
  // Pinned XCUITest setting: include SpringBoard's system alert hierarchy even
  // while XCTest still reports the app as foreground. Do not accept other alerts.
  await command('POST', '/appium/settings', { settings: { respectSystemAlerts: true } });
  const alerts = () => command('POST', '/elements', {
    using: '-ios predicate string', value: 'type == "XCUIElementTypeAlert"',
  });
  assert.deepEqual(await alerts(), [], 'No pre-existing alert may be mistaken for URL confirmation');
  await openUrl(`com.bridge.app://channel/${encodeURIComponent(channelId)}`);
  facts.osOpenRequested = true;
  await until(async () => {
    const found = await alerts();
    assert(Array.isArray(found), 'Native alert lookup must return an array');
    assert(found.length <= 1, 'Ambiguous native alert hierarchy');
    return found.length === 1;
  }, 'native OS open-confirmation alert', 30_000);
  facts.nativeAlertObserved = true;
  const text = await command('GET', '/alert/text');
  facts.alertNamesBridge = typeof text === 'string' && /\bBridge\b/.test(text);
  assert.equal(facts.alertNamesBridge, true, 'System confirmation must name Bridge');
  const buttons = await native('alert', { action: 'getButtons' });
  facts.expectedButtons = Array.isArray(buttons) && buttons.length === 2 &&
    buttons.filter(value => value === 'Open').length === 1 && buttons.includes('Cancel');
  assert.equal(facts.expectedButtons, true, 'Expected English simulator Open/Cancel OS confirmation');
  await native('alert', { action: 'accept', buttonLabel: 'Open' });
  facts.openButtonAccepted = true;
  await until(async () => {
    const active = await native('activeAppInfo');
    if (active.bundleId !== bundle) return false;
    assert.equal(active.pid, before.pid, 'A cold restart cannot satisfy a HOT deep link');
    return true;
  }, 'same Bridge process after native confirmation', 30_000);
  facts.sameProcessResumed = true;
  await webContext();
  await until(() => js(cid => document.querySelector('.ch-item.active')?.dataset.id === cid, channelId),
    'OS-requested channel active in the actual WKWebView', 30_000);
  facts.targetChannelActive = true;
  // Recheck after WebView discovery/navigation, which can itself take time.
  await nativeContext();
  const after = await native('activeAppInfo');
  assert.equal(after.bundleId, bundle);
  assert.equal(after.pid, before.pid, 'The final active channel must belong to the original HOT process');
  facts.finalProcessMatches = true;
}
