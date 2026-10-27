// A real OS hand-off, driven through native XCUITest. No synthetic web event or
// navigation API is accepted as delivery evidence. Call with alerts NOT auto-accepted.
import assert from 'node:assert/strict';

/**
 * Bounded category of a system alert's text. The text itself is never
 * recorded: it can name the app, a host or an account. Categories only.
 */
export function classifySystemAlert(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (/^Open in “Bridge”\?$|^Open in "Bridge"\?$/.test(text.trim())) return 'open-confirmation-bridge';
  if (/^Open in\b/i.test(text)) return 'open-confirmation-other';
  if (/send you notifications/i.test(text)) return 'notifications';
  if (/local network/i.test(text)) return 'local-network';
  if (/track your activity/i.test(text)) return 'tracking';
  if (/access (?:the|your) (?:microphone|camera|photos|contacts|location)|use your location/i.test(text)) return 'permission-other';
  return 'other';
}

// GET /alert/text sees SpringBoard's alert while respectSystemAlerts is on.
// No alert is a WebDriver error, recorded as null. Never accepts or dismisses.
async function alertCategory(command) {
  try {
    return classifySystemAlert(await command('GET', '/alert/text'));
  } catch {
    return null;
  }
}

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
  // A system alert raised earlier (e.g. a launch-time permission prompt) can
  // hold the OS confirmation back without appearing in the element query.
  facts.systemAlertBeforeRequest = await alertCategory(command);
  assert.equal(facts.systemAlertBeforeRequest, null,
    `A ${facts.systemAlertBeforeRequest} system alert was already up before the OS request`);
  await openUrl(`com.bridge.app://channel/${encodeURIComponent(channelId)}`);
  facts.osOpenRequested = true;
  try {
    await until(async () => {
      const found = await alerts();
      assert(Array.isArray(found), 'Native alert lookup must return an array');
      assert(found.length <= 1, 'Ambiguous native alert hierarchy');
      return found.length === 1;
    }, 'native OS open-confirmation alert', 30_000);
  } catch (error) {
    facts.systemAlertAtTimeout = await alertCategory(command);
    throw error;
  }
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
