import { describe, expect, it } from 'vitest';
import { resolveLocalAssetUrl } from '../js/core/local-asset-url.js';

describe('resolveLocalAssetUrl', () => {
  const origin = 'https://bridge.example';

  it('resolves server-owned absolute paths against the configured API origin', () => {
    expect(resolveLocalAssetUrl('/uploads/server-assets/icon.png', 'https://api.bridge.example', origin))
      .toBe('https://api.bridge.example/uploads/server-assets/icon.png');
    expect(resolveLocalAssetUrl('/uploads/banner%20one.png', '/api', origin))
      .toBe('https://bridge.example/uploads/banner%20one.png');
  });

  it.each([
    ['https://attacker.example/tracker.png'],
    ['//attacker.example/tracker.png'],
    ['javascript:alert(1)'],
    ['/uploads/x&quot;);background-image:url(javascript:alert(1))'],
    ['/uploads/x\";onload=alert(1)'],
    ['data:text/html,<svg onload=alert(1)>'],
    ['uploads/no-leading-slash.png'],
    [''],
    [null],
    [42],
  ])('rejects hostile or non-local persisted asset value %p', (value) => {
    expect(resolveLocalAssetUrl(value, 'https://api.bridge.example', origin)).toBe('');
  });

  it('fails closed for an unsafe configured API base', () => {
    expect(resolveLocalAssetUrl('/uploads/a.png', 'javascript:alert(1)', origin)).toBe('');
  });
});
