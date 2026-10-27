// Unit controls for evidence classification. These are NOT simulator evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySystemAlert, verifyNativeOpenConfirmation } from './native-open-confirmation.mjs';

function scenario(options = {}) {
  const facts = {};
  const actions = [];
  let lookups = 0, processReads = 0, pageReads = 0;
  return {
    facts, actions,
    deps: {
      channelId: 'private-target-id', facts,
      command: async (method, route, body) => {
        actions.push([method, route, body]);
        if (route === '/appium/settings') return null;
        if (route === '/elements') {
          lookups += 1;
          if (options.preexisting || (lookups > 1 && !options.noAlert)) return [{ ELEMENT: 'native-alert' }];
          return [];
        }
        if (route === '/alert/text') {
          // A launch-time alert the element query does not report.
          if (options.hiddenAlert) return options.hiddenAlert;
          const shown = options.preexisting || (lookups > 1 && !options.noAlert);
          if (!shown) throw new Error('no such alert');
          return options.wrongApp ? 'Open in another app?' : 'Open in “Bridge”?';
        }
        throw new Error('Unexpected native command');
      },
      native: async (name, args) => {
        actions.push([name, args]);
        if (name === 'activeAppInfo') {
          processReads += 1;
          return { bundleId: options.foreignProcess ? 'other.bundle' : 'com.bridge.app',
            pid: options.missingPid ? null : (options.coldRestart && processReads > 1) ||
              (options.lateRestart && processReads > 2) ? 200 : 100 };
        }
        if (name === 'alert' && args.action === 'getButtons') return options.wrongButtons ? ['OK', 'Cancel'] : ['Open', 'Cancel'];
        if (name === 'alert' && args.action === 'accept') {
          assert.deepEqual(args, { action: 'accept', buttonLabel: 'Open' });
          return null;
        }
        throw new Error('Unexpected native method');
      },
      nativeContext: async () => { actions.push(['native-context']); },
      webContext: async () => { actions.push(['actual-webview']); },
      js: async () => ++pageReads === 1 ? !options.alreadyActive : !options.wrongTarget,
      until: async (check, label) => {
        if (!await check()) throw new Error(`Unverified: ${label}`);
      },
      openUrl: async url => {
        assert.equal(url, 'com.bridge.app://channel/private-target-id');
        actions.push(['OS-openurl']);
        if (options.osFailure) throw new Error('OS open request failed');
      },
    },
  };
}

test('requires observed native confirmation and explicit Open before same-process actual-channel evidence', async () => {
  const run = scenario();
  await verifyNativeOpenConfirmation(run.deps);
  assert.equal(run.facts.nativeAlertObserved, true);
  assert.equal(run.facts.openButtonAccepted, true);
  assert.equal(run.facts.sameProcessResumed, true);
  assert.equal(run.facts.targetChannelActive, true);
  assert.equal(run.facts.finalProcessMatches, true);
  assert(run.actions.findIndex(a => a[0] === 'OS-openurl') <
    run.actions.findIndex(a => a[0] === 'alert' && a[1].action === 'accept'));
  const serialized = JSON.stringify(run.facts);
  assert(!serialized.includes('private-target-id'));
  assert(!serialized.includes('com.bridge.app'));
  assert(!serialized.includes('Open in'));
});

test('classifies system alerts into bounded categories only', () => {
  assert.equal(classifySystemAlert('Open in “Bridge”?'), 'open-confirmation-bridge');
  assert.equal(classifySystemAlert('Open in another app?'), 'open-confirmation-other');
  assert.equal(classifySystemAlert('“Bridge” Would Like to Send You Notifications'), 'notifications');
  assert.equal(classifySystemAlert('“Bridge” would like to find and connect to devices on your local network.'), 'local-network');
  assert.equal(classifySystemAlert('“Bridge” Would Like to Access the Microphone'), 'permission-other');
  assert.equal(classifySystemAlert('Something private: alice@example.com'), 'other');
  assert.equal(classifySystemAlert(''), null);
  assert.equal(classifySystemAlert(undefined), null);
});

test('a hidden launch-time alert fails before the OS request and records only its category', async () => {
  const run = scenario({ hiddenAlert: '“Bridge” Would Like to Send You Notifications' });
  await assert.rejects(verifyNativeOpenConfirmation(run.deps), /notifications system alert was already up/);
  assert.equal(run.facts.systemAlertBeforeRequest, 'notifications');
  assert(!run.actions.some(a => a[0] === 'OS-openurl'));
  assert(!run.actions.some(a => a[0] === 'alert'));
  assert(!JSON.stringify(run.facts).includes('Would Like'));
});

test('a missing confirmation records the category of whatever alert is up, without acting on it', async () => {
  const run = scenario({ noAlert: true });
  await assert.rejects(verifyNativeOpenConfirmation(run.deps), /native OS open-confirmation alert/);
  assert.equal(run.facts.systemAlertBeforeRequest, null);
  assert.equal(run.facts.systemAlertAtTimeout, null);
  assert(!run.actions.some(a => a[0] === 'alert'));
});

for (const [name, options] of [
  ['a channel already active before the link', { alreadyActive: true }],
  ['an unrelated foreground app', { foreignProcess: true }],
  ['missing native process identity', { missingPid: true }],
  ['an alert that predates the OS request', { preexisting: true }],
  ['no observed system confirmation', { noAlert: true }],
  ['a confirmation naming another app', { wrongApp: true }],
  ['an unknown native confirmation action', { wrongButtons: true }],
  ['a cold restart immediately after Open', { coldRestart: true }],
  ['a restart during WebView discovery', { lateRestart: true }],
  ['a visible but incorrect target channel', { wrongTarget: true }],
  ['a failed OS request', { osFailure: true }],
]) {
  test(`refuses ${name}`, async () => {
    const run = scenario(options);
    await assert.rejects(verifyNativeOpenConfirmation(run.deps));
    assert.notEqual(run.facts.finalProcessMatches, true);
    if (options.wrongApp || options.wrongButtons || options.preexisting || options.noAlert) {
      assert(!run.actions.some(a => a[0] === 'alert' && a[1].action === 'accept'));
    }
  });
}
