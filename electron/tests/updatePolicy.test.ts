// electron/tests/updatePolicy.test.ts

import { feedRequiresSignature, resolveUpdatePolicy } from '../updatePolicy';

const UNSIGNED_FEED = 'provider: generic\nurl: https://updates.example.com/win\nupdaterCacheDirName: bridge-electron-updater\n';
const SIGNED_FEED = 'owner: example\nrepo: bridge\nprovider: github\npublisherName:\n  - Bridge Contributors\nupdaterCacheDirName: bridge-electron-updater\n';

describe('feedRequiresSignature', () => {
  it('detects a publisher list and an inline publisher', () => {
    expect(feedRequiresSignature(SIGNED_FEED)).toBe(true);
    expect(feedRequiresSignature('provider: generic\npublisherName: Bridge Contributors\n')).toBe(true);
  });

  it('treats a missing or empty publisher as unsigned', () => {
    expect(feedRequiresSignature(UNSIGNED_FEED)).toBe(false);
    expect(feedRequiresSignature('provider: generic\npublisherName: []\n')).toBe(false);
    expect(feedRequiresSignature('provider: generic\npublisherName:\nupdaterCacheDirName: x\n')).toBe(false);
  });
});

describe('resolveUpdatePolicy', () => {
  const base = { isPackaged: true, forceInDevelopment: false, appUpdateYml: SIGNED_FEED, allowUnsignedUpdates: false };

  it('enables a signed feed in a packaged build', () => {
    expect(resolveUpdatePolicy(base)).toEqual({ enabled: true, signed: true });
  });

  it('stays off in development unless explicitly forced', () => {
    expect(resolveUpdatePolicy({ ...base, isPackaged: false })).toEqual({ enabled: false, reason: 'development' });
    expect(resolveUpdatePolicy({ ...base, isPackaged: false, forceInDevelopment: true })).toEqual({ enabled: true, signed: true });
  });

  it('stays off when the build carries no feed', () => {
    expect(resolveUpdatePolicy({ ...base, appUpdateYml: null })).toEqual({ enabled: false, reason: 'no-feed' });
    expect(resolveUpdatePolicy({ ...base, appUpdateYml: '  \n' })).toEqual({ enabled: false, reason: 'no-feed' });
  });

  it('refuses an unsigned feed unless the build was made as an explicit unsigned channel', () => {
    expect(resolveUpdatePolicy({ ...base, appUpdateYml: UNSIGNED_FEED })).toEqual({ enabled: false, reason: 'unsigned' });
    expect(resolveUpdatePolicy({ ...base, appUpdateYml: UNSIGNED_FEED, allowUnsignedUpdates: true }))
      .toEqual({ enabled: true, signed: false });
  });
});
