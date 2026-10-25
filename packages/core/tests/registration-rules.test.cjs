const test = require('node:test');
const assert = require('node:assert/strict');
const {registrationProblem, USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN, PASSWORD_MAX} = require('@bridge/core/registration');

test('shared registration retains the server-aligned boundaries and error precedence', () => {
  assert.deepEqual([USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN, PASSWORD_MAX], [3, 32, 8, 128]);
  for (const [username, password, expected] of [
    ['', '', 'username_length'], ['ab', '12345678', 'username_length'],
    ['a'.repeat(33), '12345678', 'username_length'],
    ['abc', '1234567', 'password_short'], ['a'.repeat(32), 'p'.repeat(128), null],
    ['abc', 'p'.repeat(129), 'password_long'], ['abc', '12345678', null],
    ['a b', '', 'username_chars'], ['a'.repeat(33) + '!', '', 'username_length'],
  ]) assert.equal(registrationProblem(username, password), expected);
});

test('usernames cannot acquire Unicode confusables, whitespace or path/control characters', () => {
  for (const username of ['ali veli', 'ali\nveli', 'аlice', 'ali/veli', 'a@b', 'a\u0000b', 'a.b', 'ali😀', 'abc ']) {
    assert.equal(registrationProblem(username, '12345678'), 'username_chars', JSON.stringify(username));
  }
  for (const username of ['ABC', 'a_b', 'a0Z', '_a_']) assert.equal(registrationProblem(username, '12345678'), null);
});

test('passwords retain existing UTF-16 length semantics and are never trimmed or normalized', () => {
  assert.equal(registrationProblem('abc', ' '.repeat(8)), null);
  assert.equal(registrationProblem('abc', '😀'.repeat(4)), null);
  assert.equal(registrationProblem('abc', 'e\u0301'.repeat(4)), null);
  assert.equal(registrationProblem('abc', '😀'.repeat(65)), 'password_long');
});
