import { nativeServerOptions } from '../src/network';
import { normalizeServerUrl } from '@bridge/core';

test.each([
  [
    'HTTPS://Chat.Example.com:443/path',
    { ok: true, origin: 'https://chat.example.com' },
  ],
  ['http://[::1]:3000', { ok: true, origin: 'http://[::1]:3000' }],
  [
    'https://bücher.example',
    { ok: true, origin: 'https://xn--bcher-kva.example' },
  ],
  ['https://name:secret@chat.example', { ok: false, reason: 'credentials' }],
  ['http://127.0.0.1.evil.example', { ok: false, reason: 'insecure' }],
])(
  'native WHATWG adapter preserves the shared origin contract for %s',
  (input, expected) => {
    expect(
      normalizeServerUrl(input, nativeServerOptions('ios', false)),
    ).toEqual(expected);
  },
);

test.each([
  ['android', true, true],
  ['android', false, false],
  ['ios', true, false],
  ['ios', false, false],
] as const)(
  'emulator HTTP is restricted to development Android (%s, %s)',
  (platform, development, allowed) => {
    expect(
      normalizeServerUrl(
        'http://10.0.2.2:3000',
        nativeServerOptions(platform, development),
      ).ok,
    ).toBe(allowed);
  },
);

test.each(['https://xn--.example', 'https://a\u200db.example'])(
  'invalid IDNA hosts remain rejected: %s',
  input => {
    expect(
      normalizeServerUrl(input, nativeServerOptions('android', false)),
    ).toEqual({ ok: false, reason: 'invalid' });
  },
);
