// server/tests/upload-release.test.ts
//
// Final21 Faz 19 — lib/uploadRelease.ts: sahibi silinen kalıcı dosyaların bırakılması.
// Gerçek dosya sistemi (geçici yükleme kökü) ve gerçek yerel depolama adaptörü kullanılır;
// yalnızca başvuru denetiminin veritabanı sorgusu ikizlenir.

import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-release-'));
const savedEnv = { BRIDGE_UPLOAD_ROOT: process.env.BRIDGE_UPLOAD_ROOT, CDN_PROVIDER: process.env.CDN_PROVIDER };
process.env.BRIDGE_UPLOAD_ROOT = ROOT;
delete process.env.CDN_PROVIDER;

import { locateAsset, memberProfileAssetUrls, releaseUnreferencedUploads } from '../lib/uploadRelease';
import type { UploadReferenceQueryable } from '../lib/uploadReferenceSafety';

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const put = (sub: string, name: string) => {
  fs.mkdirSync(path.join(ROOT, sub), { recursive: true });
  fs.writeFileSync(path.join(ROOT, sub, name), 'x');
  return path.join(ROOT, sub, name);
};
/** Başvuru denetimi: `referenced` kümesindeki kanonik anahtarlar için TRUE döner. */
const queryable = (referenced: string[] = []) => {
  const calls = jest.fn(async (_sql: string, params?: unknown[]) => ({ rows: [{ referenced: referenced.includes(String(params?.[0])) }] }));
  return { query: calls as unknown as UploadReferenceQueryable['query'], calls };
};

describe('locateAsset — only recognised persistent asset paths are ever released', () => {
  it('recognises local profile/server asset subdirectories', () => {
    expect(locateAsset('/uploads/avatars/avatar_1.png')).toEqual({
      kind: 'local', canonicalKey: 'uploads/avatars/avatar_1.png', filePath: path.join(ROOT, 'avatars', 'avatar_1.png'),
    });
    for (const sub of ['banners', 'member-profiles', 'emojis', 'soundboard', 'recordings']) {
      expect(locateAsset(`/uploads/${sub}/f.bin`)?.kind).toBe('local');
    }
  });

  it('routes adapter-backed server assets and GIFs through the storage adapter', () => {
    expect(locateAsset('/uploads/server-assets/sa_1.png')).toEqual({ kind: 'adapter', canonicalKey: 'uploads/server-assets/sa_1.png', storageKey: 'server-assets/sa_1.png' });
    expect(locateAsset('/uploads/server-gifs/g.gif')?.kind).toBe('adapter');
  });

  it('refuses everything else: stickers, root attachments, traversal, foreign URLs, non-strings', () => {
    for (const bad of [
      '/uploads/stickers/s.png', '/uploads/attachment.png', '/uploads/avatars/../../etc', '/uploads/avatars/a..b.png',
      'https://cdn.example/x.png', '/uploads/other/x.png', '', null, 42, undefined,
    ]) expect({ bad, loc: locateAsset(bad) }).toEqual({ bad, loc: null });
  });
});

describe('releaseUnreferencedUploads', () => {
  it('removes unreferenced files, keeps referenced ones, counts absent files, skips unknown paths, de-duplicates', async () => {
    const gone = put('avatars', 'gone.png');
    const kept = put('emojis', 'kept.png');
    const adapter = put('server-assets', 'icon.png');
    const q = queryable(['uploads/emojis/kept.png']);
    const onError = jest.fn();
    const result = await releaseUnreferencedUploads(q, [
      '/uploads/avatars/gone.png', '/uploads/avatars/gone.png', '/uploads/emojis/kept.png',
      '/uploads/banners/never-existed.png', '/uploads/server-assets/icon.png', 'https://cdn.example/x.png',
    ], onError);
    expect(result).toEqual({ removed: 2, alreadyAbsent: 1, stillReferenced: 1, failed: 0 });
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(adapter)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(q.calls).toHaveBeenCalledTimes(4);          // duplicate + foreign URL never queried
    expect(onError).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: without a database pool nothing is deleted and each file is reported', async () => {
    const file = put('avatars', 'nopool.png');
    const onError = jest.fn();
    const result = await releaseUnreferencedUploads(null, ['/uploads/avatars/nopool.png'], onError);
    expect(result).toEqual({ removed: 0, alreadyAbsent: 0, stillReferenced: 0, failed: 1 });
    expect(fs.existsSync(file)).toBe(true);
    expect(onError).toHaveBeenCalledWith('/uploads/avatars/nopool.png', expect.any(Error));
  });

  it('an unlink failure other than ENOENT is reported, not swallowed', async () => {
    fs.mkdirSync(path.join(ROOT, 'avatars', 'a-directory.png'), { recursive: true });   // unlink(dir) -> EPERM/EISDIR
    const onError = jest.fn();
    const result = await releaseUnreferencedUploads(queryable(), ['/uploads/avatars/a-directory.png'], onError);
    expect(result.failed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('memberProfileAssetUrls', () => {
  it('reads avatar and banner from object and JSON-string profiles, ignoring everything else', () => {
    expect(memberProfileAssetUrls([
      { serverProfile: { avatarUrl: '/uploads/member-profiles/a.webp', bannerUrl: '/uploads/member-profiles/b.webp', bio: 'x' } },
      { serverProfile: JSON.stringify({ avatarUrl: '/uploads/member-profiles/c.webp' }) },
      { serverProfile: '{not json' },
      { serverProfile: null },
      { serverProfile: { avatarUrl: '', bannerUrl: 7 } },
      {},
    ])).toEqual(['/uploads/member-profiles/a.webp', '/uploads/member-profiles/b.webp', '/uploads/member-profiles/c.webp']);
  });
});
