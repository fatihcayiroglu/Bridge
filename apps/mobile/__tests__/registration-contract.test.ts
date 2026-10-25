import {
  PASSWORD_MIN,
  PASSWORD_MAX,
  USERNAME_MIN,
  USERNAME_MAX,
  registrationProblem,
} from '@bridge/core/registration';

test('native registration consumes the same server-aligned product limits', () => {
  expect([USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN, PASSWORD_MAX]).toEqual([
    3, 32, 8, 128,
  ]);
});

test.each([
  ['ab', '12345678', 'username_length'],
  ['ali veli', '12345678', 'username_chars'],
  ['abc', '1234567', 'password_short'],
  ['abc', 'p'.repeat(129), 'password_long'],
  ['abc', '12345678', null],
  ['a'.repeat(32), 'p'.repeat(128), null],
] as const)(
  'shared registration rejects or accepts the same boundaries',
  (username, password, expected) => {
    expect(registrationProblem(username, password)).toBe(expected);
  },
);
