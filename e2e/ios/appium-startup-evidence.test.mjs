import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAppiumStartup } from './appium-startup-evidence.mjs';

test('records fixed native-startup stages and counts without serializing log payloads', async () => {
  const facts = await summarizeAppiumStartup([
    '[HTTP] --> POST /session',
    '[deadbeef][XCUITestDriver@abc] Starting WebDriverAgent initialization',
    "[Xcode] Test Suite 'WebDriverAgentRunner.xctest' started at private-time",
    '[Xcode] ServerURLHere->http://127.0.0.1:8100<-ServerURLHere',
    '[WD Proxy] Proxying [GET /status] to [GET http://private-host]',
    '[WD Proxy] Got response with status 200: private-body',
    '[RemoteDebugger] Connecting to remote debugger through private-socket',
    '[HTTP] <-- POST /session 200 123ms - private-response',
  ]);
  assert.equal(facts.sessionRequests, 1); assert.equal(facts.sessionResponses, 1);
  assert.equal(facts.wdaInitializationStarted, true); assert.equal(facts.wdaRunnerStarted, true);
  assert.equal(facts.wdaServerMarker, true); assert.equal(facts.inspectorConnected, true);
  assert.equal(facts.proxyRequests, 1); assert.equal(facts.proxyResponses, 1);
  assert(!JSON.stringify(facts).includes('private'));
  assert(!JSON.stringify(facts).includes('8100'));
});

test('does not mistake command arguments or unknown namespaces for startup events', async () => {
  const facts = await summarizeAppiumStartup([
    '[HTTP] {"script":"--> POST /session", "password":"secret"}',
    '[Unknown] ** TEST FAILED **',
    '[HTTP] --> POST /session/private-session/execute/sync',
    '[Xcode] a filename containing BUILD FAILED is not a build result',
    '[RemoteDebugger] {"body":"Connecting to remote debugger"}',
    'secret [Xcode] ** TEST FAILED **',
  ]);
  assert.equal(facts.sessionRequests, 0); assert.equal(facts.xcodeTestFailed, false);
  assert.equal(facts.xcodeBuildFailed, false); assert.equal(facts.inspectorConnected, false);
});

test('retains failed native build classification without raw compiler errors or identifiers', async () => {
  const facts = await summarizeAppiumStartup([
    '[Xcode] ** BUILD FAILED ** private-path',
    '[Xcode] ** TEST FAILED ** private-device',
    '[XCUITestDriver@a1] Unable to launch WebDriverAgent: secret-body',
  ]);
  assert.equal(facts.xcodeBuildFailed, true); assert.equal(facts.xcodeTestFailed, true);
  assert.equal(facts.wdaInitializationFailed, true);
  assert.equal(facts.inspectorConnected, false);
  assert(!JSON.stringify(facts).includes('secret'));
});

test('ignores oversized private lines and explicitly marks bounded truncation', async () => {
  async function* lines() {
    yield 'x'.repeat(16_385);
    for (let i = 0; i < 200_000; i++) yield '[Unknown] secret';
  }
  const facts = await summarizeAppiumStartup(lines());
  assert.equal(facts.oversizedLines, 1); assert.equal(facts.truncated, true);
  assert.equal(facts.sessionRequests, 0); assert(!JSON.stringify(facts).includes('secret'));
});
