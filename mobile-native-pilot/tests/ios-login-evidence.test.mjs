import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loginEvidence } from '../scripts/ios-login-evidence.mjs';

const USER = 'and_A_388ccb9f', PASS = 'S3cret-PASSWORD-value';
const el = (type, attrs) => `<XCUIElementType${type} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`;
const page = (userValue, passValue, extra = '') => `<AppiumAUT>${[
  el('Button', { name: 'Sign In', label: 'Sign In', visible: 'true', y: '210', height: '40' }),
  el('Button', { name: 'Create Account', label: 'Create Account', visible: 'true', y: '210', height: '40' }),
  el('TextField', { name: 'USERNAME', value: userValue, visible: 'true', y: '300' }),
  el('SecureTextField', { name: 'PASSWORD', value: passValue, visible: 'true', y: '380' }),
  el('Button', { name: 'Sign In', label: 'Sign In', visible: 'true', y: '460', height: '48' }),
].join('')}${extra}</AppiumAUT>`;

test('reports both Sign In controls with their vertical position', () => {
  const e = loginEvidence(page(USER, '••••'), USER);
  assert.deepEqual(e.signInControls.map((c) => c.y), [210, 460]);
  assert.ok(e.labelsPresent.includes('Sign In') && e.labelsPresent.includes('Create Account'));
});

test('a username field holding exactly the username is told apart from one with the password appended', () => {
  const ok = loginEvidence(page(USER, '••••'), USER);
  assert.equal(ok.textFields[0].valueIsUsername, true);
  const bad = loginEvidence(page(USER + PASS, ''), USER);
  assert.equal(bad.textFields[0].valueIsUsername, false);
  assert.equal(bad.textFields[0].valueContainsUsername, true);
  assert.equal(bad.secureFields[0].valueLength, 0);
});

test('the required-fields message is detected from the allow-list only', () => {
  const e = loginEvidence(page(USER, '', el('StaticText', { name: 'All fields are required', label: 'All fields are required' }) + el('StaticText', { name: 'something else entirely' })), USER);
  assert.ok(e.labelsPresent.includes('All fields are required'));
  assert.ok(!JSON.stringify(e).includes('something else'));
});

test('no value, username or password text ever appears in the evidence', () => {
  const out = JSON.stringify(loginEvidence(page(USER + PASS, PASS), USER));
  for (const secret of [USER, PASS]) assert.ok(!out.includes(secret), secret);
  assert.deepEqual(loginEvidence('', USER).textFields, []);
  assert.equal(loginEvidence(page(USER, 'x'), undefined).textFields[0].valueIsUsername, false);
});

test('the iOS driver records the evidence on failure from the page source, not from argument values', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /import \{ loginEvidence \} from '\.\/ios-login-evidence\.mjs'/);
  assert.match(s, /facts\.failureUi\.login = loginEvidence\(s, activeUsername\)/);
});

test('the evidence is printed to the job log (artifacts are not downloadable) from the closed shape only', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(s, /console\.log\(`IOS_LOGIN_EVIDENCE \$\{JSON\.stringify\(\{ stage: facts\.stage \?\? null, failure: facts\.failure, login: facts\.failureUi\.login \}\)\}`\)/);
});
