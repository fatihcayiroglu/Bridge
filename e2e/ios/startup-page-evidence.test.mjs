import test from 'node:test';
import assert from 'node:assert/strict';
import { startupPageFacts } from './startup-page-evidence.mjs';

test('distinguishes a complete empty packaged page from a loaded Bridge document without private content', () => {
  const realm = { location: { pathname: '/' }, __BRIDGE_EARLY_ERRORS__: [
    { type: 'resource', message: 'private-token', source: 'https://private-host', stack: 'private-stack' },
  ] };
  realm.top = realm;
  const doc = { readyState: 'complete', contentType: 'text/html', body: { childElementCount: 0 },
    scripts: [], getElementById: () => null, title: 'private-title' };
  const facts = startupPageFacts(doc, realm);
  assert.equal(facts.readyState, 'complete'); assert.equal(facts.topLevelFrame, true);
  assert.equal(facts.bodyElementCount, 0); assert.equal(facts.authRootPresent, false);
  assert.equal(facts.earlyResourceErrorCount, 1);
  assert(!JSON.stringify(facts).includes('private'));
  assert.equal(startupPageFacts({ ...doc, getElementById: () => ({}) }, realm).authRootPresent, true);
});

test('does not equate missing early-error state with zero errors or serialize unknown path/state', () => {
  const facts = startupPageFacts({ readyState: 'private', getElementById: () => null },
    { location: { pathname: '/private-account' }, top: {} });
  assert.equal(facts.readyState, 'unknown'); assert.equal(facts.earlyErrorCount, null);
  assert.equal(facts.earlyResourceErrorCount, null); assert.equal(facts.topLevelFrame, false);
  assert.equal(facts.canonicalIndexPath, false); assert.equal(facts.scriptCount, null);
  assert(!JSON.stringify(facts).includes('private'));
});

test('bounds counts from the existing early-error buffer', () => {
  const facts = startupPageFacts(undefined, { __BRIDGE_EARLY_ERRORS__: Array(100).fill({ type: 'resource', message: 'secret' }) });
  assert.equal(facts.earlyErrorCount, 20); assert.equal(facts.earlyResourceErrorCount, 20);
  assert(!JSON.stringify(facts).includes('secret'));
});
