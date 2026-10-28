import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseSubmitIndex } from '../scripts/ios-signin-select.mjs';

const R = (y, h = 44) => ({ x: 20, y, width: 300, height: h });
const PASSWORD = R(300, 44); // bottom edge at 344

test('picks the Sign In control BELOW the password field, not the tab above the form', () => {
  const tab = R(120), submit = R(420);
  assert.equal(chooseSubmitIndex([tab, submit], PASSWORD), 1);
  assert.equal(chooseSubmitIndex([submit, tab], PASSWORD), 0, 'order in the accessibility tree does not matter');
});
test('regression: "the first Sign In" (the old behaviour) is the tab, which is the wrong control', () => {
  const rects = [R(120), R(420)];
  assert.notEqual(chooseSubmitIndex(rects, PASSWORD), 0);
});
test('not rendered yet is -1 (keep waiting); two candidates below the field is ambiguous and fatal', () => {
  assert.equal(chooseSubmitIndex([R(120)], PASSWORD), -1);
  assert.equal(chooseSubmitIndex([], PASSWORD), -1);
  assert.throws(() => chooseSubmitIndex([R(420), R(500)], PASSWORD), /AMBIGUOUS_SIGN_IN_SUBMIT/);
});
test('degenerate geometry never selects: zero-size or non-numeric rects are ignored; a bad password rect is fatal', () => {
  assert.equal(chooseSubmitIndex([{ x: 0, y: 500, width: 0, height: 0 }, { x: 'a', y: 500, width: 5, height: 5 }, null], PASSWORD), -1);
  for (const bad of [null, undefined, { x: 1, y: 2, width: 0, height: 10 }, { x: NaN, y: 1, width: 1, height: 1 }]) assert.throws(() => chooseSubmitIndex([R(420)], bad), /PASSWORD_FIELD_RECT_REQUIRED/);
});
test('a control that overlaps the password field is not "below" it', () => {
  assert.equal(chooseSubmitIndex([R(320)], PASSWORD), -1);
  assert.equal(chooseSubmitIndex([R(344)], PASSWORD), 0, 'directly under the field counts');
});
test('the premise is true in the repository: the page has the tab first and the submit button after it, both named "Sign In"', () => {
  const html = readFileSync(new URL('../../client/index.html', import.meta.url), 'utf8');
  const tab = html.indexOf('data-auth-tab="login"'), submit = html.indexOf('data-auth-action="login"');
  assert.ok(tab > 0 && submit > tab, 'tab precedes the submit button');
  const label = (i) => /<button[^>]*>([^<]*)<\/button>/.exec(html.slice(html.lastIndexOf('<button', i)))?.[1];
  assert.equal(label(tab), 'Sign In'); assert.equal(label(submit), 'Sign In');
});
test('the driver submits through the chooser and never clicks "the first Sign In" again', () => {
  const js = readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(js, /await clickSignInSubmit\(secrets\[0\]\)/);
  assert.doesNotMatch(js, /clickName\('Sign In'\)/);
  assert.match(js, /chooseSubmitIndex\(rects, passwordRect\)/);
  assert.match(js, /facts\.signInMatches = all\.length/);
});
