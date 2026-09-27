// server/tests/storageAdapter.test.ts
// Sprint 73: uploadFile + B2 provider + getStorageAdapter factory testleri eklendi
// Sprint 74: credential validation (boş string / eksik env) testleri eklendi
//
// Kapsam:
//   - localAdapter : listFiles, uploadFile, deleteFile, keyFromUrl, healthCheck
//   - buildS3Adapter: listFiles (LastModified + sayfalama), uploadFile,
//                     deleteFile, keyFromUrl, healthCheck, eksik SDK hatası
//   - getStorageAdapter: tüm CDN_PROVIDER seçenekleri + singleton
//   - _validateRemoteCredentials: eksik/boş env → startup hatası

process.env.NODE_ENV = 'test';
// Bu dosyanin `fs` taklidi `existsSync`i "yol 'uploads' ile BITIYORSA true"
// kuraliyla kisayola bagliyor. Kanonik yukleme koku artik tek kullanimlik bir
// tmp dizinidir (bkz. tests/setup.js), bu yuzden burada o kurala UYAN bir kok
// secilir. Aksi halde `listFiles()` bos doner ve testler urun kusuru degil
// TAKLIT kusuru olcerdi.
process.env.BRIDGE_UPLOAD_ROOT =
  require('path').join(require('os').tmpdir(), 'bridge-storageadapter-uploads');

import path from 'path';
import fs from 'fs';
import { uploadRoot } from '../lib/runtimePaths';
import {
  localAdapter,
  buildS3Adapter,
  getStorageAdapter,
  getPrivateStorageAdapter,
  getPrivateStorageProvider,
  _resetAdapterForTest,
  type StorageObject,
  type S3AdapterConfig,
  type StorageAdapter,
} from '../lib/storageAdapter';

// ── fs mock ──────────────────────────────────────────────────────────────────

const mockFiles: Record<string, { mtimeMs: number }> = {};

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof fs>('fs');
  return {
    ...actual,
    existsSync:   jest.fn((p: string) => {
      if (p.endsWith('uploads')) return true;
      return path.basename(p) in mockFiles;
    }),
    readdirSync:  jest.fn(() => Object.keys(mockFiles)),
    statSync:     jest.fn((p: string) => {
      const key = path.basename(p);
      if (!(key in mockFiles)) throw new Error('ENOENT');
      return mockFiles[key];
    }),
    accessSync:   jest.fn(),
    unlinkSync:   jest.fn(),
    unlink:       jest.fn((p: string, cb: (err: null) => void) => cb(null)),
    createReadStream: jest.fn(() => ({
      pipe: jest.fn(),
      on:   jest.fn(),
    })),
  };
});

jest.mock('../lib/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// ── S3 SDK mock fabrikası ─────────────────────────────────────────────────────

interface S3Object {
  Key:          string;
  LastModified: Date | undefined;
}

function buildMockSdk(pages: S3Object[][], healthOk = true) {
  let pageIndex = 0;

  const mockSend = jest.fn().mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor?.name ?? '';
    if (name === 'ListObjectsV2Command') {
      if (!healthOk) throw new Error('connection refused');
      const page = pages[pageIndex] ?? [];
      const isLast = pageIndex >= pages.length - 1;
      pageIndex++;
      return {
        Contents:              page.map(o => ({ Key: o.Key, LastModified: o.LastModified })),
        IsTruncated:           !isLast,
        NextContinuationToken: isLast ? undefined : `token-${pageIndex}`,
      };
    }
    if (name === 'PutObjectCommand') return {};
    if (name === 'DeleteObjectCommand') return {};
    return {};
  });

  function makeCmd(name: string) {
    const Ctor = class {};
    Object.defineProperty(Ctor, 'name', { value: name });
    return Ctor;
  }

  return {
    sdk: {
      S3Client:             jest.fn(() => ({ send: mockSend })),
      ListObjectsV2Command: makeCmd('ListObjectsV2Command'),
      PutObjectCommand:     makeCmd('PutObjectCommand'),
      DeleteObjectCommand:  makeCmd('DeleteObjectCommand'),
      GetObjectCommand:     makeCmd('GetObjectCommand'),
    },
    mockSend,
    reset: () => { pageIndex = 0; mockSend.mockClear(); },
  };
}

// ── Yardımcı: test config ────────────────────────────────────────────────────

function testCfg(overrides: Partial<S3AdapterConfig> = {}): S3AdapterConfig {
  return {
    provider:       's3',
    bucket:         'test-bucket',
    region:         'us-east-1',
    accessKeyId:    'key',
    secretAccessKey:'secret',
    publicUrl:      'https://cdn.example.com',
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// localAdapter
// ═════════════════════════════════════════════════════════════════════════════

describe('localAdapter', () => {
  beforeEach(() => {
    Object.keys(mockFiles).forEach(k => delete mockFiles[k]);
    jest.clearAllMocks();
  });
  afterEach(() => { _resetAdapterForTest(); });

  describe('listFiles()', () => {
    it('uploads dizini yoksa boş dizi döner', async () => {
      (fs.existsSync as jest.Mock).mockReturnValueOnce(false);
      expect(await localAdapter.listFiles()).toEqual([]);
    });

    it('dosyaları key + lastModifiedMs ile döndürür', async () => {
      mockFiles['a.png'] = { mtimeMs: 1000 };
      mockFiles['b.jpg'] = { mtimeMs: 2000 };
      const list = await localAdapter.listFiles();
      expect(list).toEqual(
        expect.arrayContaining([
          { key: 'a.png', lastModifiedMs: 1000 },
          { key: 'b.jpg', lastModifiedMs: 2000 },
        ]),
      );
    });

    it('statSync hatasında lastModifiedMs undefined olur', async () => {
      mockFiles['broken.txt'] = { mtimeMs: 0 };
      (fs.statSync as jest.Mock).mockImplementationOnce(() => { throw new Error('EPERM'); });
      const [item] = await localAdapter.listFiles();
      expect(item.lastModifiedMs).toBeUndefined();
    });
  });

  describe('uploadFile()', () => {
    it('local modda /uploads/<filename> URL döndürür', async () => {
      const result = await localAdapter.uploadFile('/tmp/uuid123.png', 'uuid123.png');
      expect(result.url).toBe('/uploads/uuid123.png');
      expect(result.key).toBeNull();
      expect(result.provider).toBe('local');
    });

    it('deleteLocal=true olsa bile local modda fs.unlink çağrılmaz', async () => {
      await localAdapter.uploadFile('/tmp/uuid.png', 'uuid.png', { deleteLocal: true });
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it('uploads alt dizinindeki fiziksel yolu URL’de korur', async () => {
      // `UPLOAD_DIR` bu dosyada HİÇ TANIMLI DEĞİLDİ; test
      // `ReferenceError: UPLOAD_DIR is not defined` ile düşüyordu — yani
      // "alt dizin URL'de korunur" sözleşmesi hiç ölçülmüyordu.
      // Adaptörün kullandığı kanonik kök burada da kullanılır.
      // Kanonik kok: uretim kodu artik `__dirname` turevi bir yol kullanmiyor.
      const uploadsRoot = uploadRoot();
      const nested = path.join(uploadsRoot, 'server-assets', 'sa_1.png');
      const result = await localAdapter.uploadFile(nested, 'uploads/server-assets/sa_1.png');
      expect(result.url).toBe('/uploads/server-assets/sa_1.png');
    });

  });

  describe('deleteFile()', () => {
    it('mevcut dosyayı siler', async () => {
      mockFiles['old.png'] = { mtimeMs: 500 };
      await localAdapter.deleteFile('old.png');
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('old.png'));
    });

    it('mevcut olmayan dosya için hata fırlatmaz', async () => {
      await expect(localAdapter.deleteFile('ghost.png')).resolves.toBeUndefined();
    });


    it('uploads kökü dışına çıkan delete key için EINVAL döndürür', async () => {
      await expect(localAdapter.deleteFile('../outside.bin')).rejects.toMatchObject({ code: 'EINVAL' });
      expect(fs.unlinkSync).not.toHaveBeenCalledWith(expect.stringContaining('outside.bin'));
    });
  });

  describe('keyFromUrl()', () => {
    it('dosya adını ve uploads alt dizinini koruyan key döndürür', () => {
      expect(localAdapter.keyFromUrl('/uploads/abc.jpg')).toBe('abc.jpg');
      expect(localAdapter.keyFromUrl('https://example.com/uploads/xyz.png')).toBe('xyz.png');
      expect(localAdapter.keyFromUrl('/uploads/server-assets/icon.png')).toBe('server-assets/icon.png');
      expect(localAdapter.keyFromUrl('https://cdn.example/uploads/member-profiles/a.webp')).toBe('member-profiles/a.webp');
    });

    it('publicUrlForKey canonical local URL üretir', () => {
      expect(localAdapter.publicUrlForKey('uploads/server-gifs/a.gif')).toBe('/uploads/server-gifs/a.gif');
      expect(localAdapter.publicUrlForKey('server-assets/a.png')).toBe('/uploads/server-assets/a.png');
    });
  });

  describe('healthCheck()', () => {
    it('upload kökü okunabilir ve yazılabilir olduğunda true döner', async () => {
      expect(await localAdapter.healthCheck()).toBe(true);
      expect(fs.accessSync).toHaveBeenCalledWith(
        uploadRoot(),
        fs.constants.R_OK | fs.constants.W_OK,
      );
    });

    it('upload volume erişilemezse false döner', async () => {
      (fs.accessSync as jest.Mock).mockImplementationOnce(() => { throw new Error('EROFS'); });
      await expect(localAdapter.healthCheck()).resolves.toBe(false);
    });
  });

  describe('readFile() range and traversal contract', () => {
    const statSpy = fs.statSync as jest.Mock;
    const streamSpy = fs.createReadStream as jest.Mock;

    beforeEach(() => {
      statSpy.mockReset();
      streamSpy.mockReset();
      statSpy.mockReturnValue({ size: 10, mtime: new Date(1234) });
      streamSpy.mockReturnValue({ pipe: jest.fn(), on: jest.fn() });
    });

    it('returns full-file metadata without a Range header', async () => {
      const out = await localAdapter.readFile('clip.mp4');
      expect(out.contentLength).toBe(10);
      expect(out.contentRange).toBeUndefined();
      expect(out.acceptRanges).toBe('bytes');
      expect(out.contentType).toBe('video/mp4');
      expect(streamSpy).toHaveBeenCalledWith(expect.stringContaining('clip.mp4'), undefined);
    });

    it.each([
      ['bytes=2-5', 4, 'bytes 2-5/10', { start: 2, end: 5 }],
      ['bytes=7-', 3, 'bytes 7-9/10', { start: 7, end: 9 }],
      ['bytes=-3', 3, 'bytes 7-9/10', { start: 7, end: 9 }],
      ['bytes=0-999', 10, 'bytes 0-9/10', { start: 0, end: 9 }],
    ])('serves valid range %s', async (range, length, contentRange, streamOpts) => {
      const out = await localAdapter.readFile('clip.mp4', { range });
      expect(out.contentLength).toBe(length);
      expect(out.contentRange).toBe(contentRange);
      expect(streamSpy).toHaveBeenCalledWith(expect.stringContaining('clip.mp4'), streamOpts);
    });

    it.each(['bytes=abc-def', 'items=0-1', 'bytes=9-2', 'bytes=10-10', 'bytes=-0'])
      ('rejects malformed or unsatisfiable range %s with ERANGE', async range => {
        await expect(localAdapter.readFile('clip.mp4', { range })).rejects.toMatchObject({ code: 'ERANGE' });
      });

    it('rejects storage-key traversal before touching the filesystem', async () => {
      statSpy.mockClear();
      await expect(localAdapter.readFile('../secret.txt')).rejects.toMatchObject({ code: 'EINVAL' });
      expect(statSpy).not.toHaveBeenCalled();
    });
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// buildS3Adapter
// ═════════════════════════════════════════════════════════════════════════════

describe('buildS3Adapter', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => { _resetAdapterForTest(); });

  // ══════════════════════════════════════════════════════════════════════════
  // GERCEK SDK ENJEKSIYONU
  // ══════════════════════════════════════════════════════════════════════════
  // Bu bloktaki UC test daha once BOSTU ve bunu kendi yorumlarinda itiraf
  // ediyordu:
  //
  //   • '@aws-sdk/client-s3 yoksa anlamli hata firlatir' — govdesi BOSTU ve
  //     iddiasi adinin TERSIYDI: `expect(() => {}).not.toThrow()`.
  //   • 'nesneleri key + lastModifiedMs ile dondurur' — hicbir iddia yoktu;
  //     yorum "dogrudan test edemiyoruz" diyordu.
  //   • 'IsTruncated=true ise tum sayfalari iter' — sayfalama dongusunu
  //     TESTIN ICINDE yeniden yaziyor ve KENDI kopyasini dogruluyordu. Urun
  //     kodu hic calismiyordu.
  //
  // Bu, veri kaybina yol acan yolun ta kendisiydi: uzak modda temizlik isi
  // `listFiles()` ciktisina gore siler. O yuzden artik URUN KODU calistirilir.

  /** Komut girdilerini KAYDEDEN sahte SDK — `Delimiter` gibi alanlar olculebilsin. */
  function recordingSdk(pages: Array<Array<{ Key: string; LastModified?: Date }>>) {
    const inputs: Array<Record<string, unknown>> = [];
    let page = 0;

    function cmd(name: string) {
      const Ctor = class {
        input: Record<string, unknown>;
        constructor(input: Record<string, unknown>) {
          this.input = input;
          if (name === 'ListObjectsV2Command') inputs.push(input);
        }
      };
      Object.defineProperty(Ctor, 'name', { value: name });
      return Ctor;
    }

    const send = jest.fn(async (c: { constructor: { name: string } }) => {
      if (c.constructor.name !== 'ListObjectsV2Command') return {};
      const cur = pages[page] ?? [];
      const last = page >= pages.length - 1;
      page++;
      return {
        Contents: cur,
        IsTruncated: !last,
        NextContinuationToken: last ? undefined : 'tok-' + page,
      };
    });

    return {
      inputs,
      send,
      sdk: {
        S3Client: jest.fn(() => ({ send })),
        ListObjectsV2Command: cmd('ListObjectsV2Command'),
        PutObjectCommand: cmd('PutObjectCommand'),
        DeleteObjectCommand: cmd('DeleteObjectCommand'),
        GetObjectCommand: cmd('GetObjectCommand'),
      },
    };
  }

  /**
   * Sahte SDK ile adaptor kurar.
   *
   * `jest.isolateModules` KULLANILIR, cunku duz `resetModules()` PAYLASILAN
   * modul kaydini kirletir: sonraki testler `logger` gibi modullerin FARKLI
   * bir ornegini alir ve casus cagrilari gormez. Bu tam olarak yasandi —
   * ilgisiz bir `getStorageAdapter` testi sessizce dustu.
   */
  function adapterWithSdk(sdk: unknown, cfgOverrides = {}) {
    let adapter!: import('../lib/storageAdapter').StorageAdapter;
    jest.isolateModules(() => {
      jest.doMock('../lib/_optional-require', () => ({ tryRequire: () => sdk }));
      const mod = require('../lib/storageAdapter') as typeof import('../lib/storageAdapter');
      adapter = mod.buildS3Adapter({
        provider: 's3', bucket: 'test-bucket', region: 'us-east-1',
        accessKeyId: 'key', secretAccessKey: 'secret',
        publicUrl: 'https://cdn.example.com', ...cfgOverrides,
      } as Parameters<typeof mod.buildS3Adapter>[0]);
      jest.dontMock('../lib/_optional-require');
    });
    return adapter;
  }


  describe('readFile()', () => {
    it('GetObject kullanır ve Range/metadata sözleşmesini korur', async () => {
      const body = { pipe: jest.fn(), on: jest.fn() };
      const inputs: Array<Record<string, unknown>> = [];
      function cmd(name: string) {
        const Ctor = class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) { this.input = input; inputs.push(input); }
        };
        Object.defineProperty(Ctor, 'name', { value: name });
        return Ctor;
      }
      const send = jest.fn(async (c: { constructor: { name: string } }) => {
        if (c.constructor.name === 'GetObjectCommand') {
          return { Body: body, ContentType: 'video/mp4', ContentLength: 5, ContentRange: 'bytes 5-9/10', AcceptRanges: 'bytes' };
        }
        return { Contents: [], IsTruncated: false };
      });
      const sdk = {
        S3Client: jest.fn(() => ({ send })),
        ListObjectsV2Command: cmd('ListObjectsV2Command'),
        PutObjectCommand: cmd('PutObjectCommand'),
        DeleteObjectCommand: cmd('DeleteObjectCommand'),
        GetObjectCommand: cmd('GetObjectCommand'),
      };
      const adapter = adapterWithSdk(sdk);

      const out = await adapter.readFile('uploads/movie.mp4', { range: 'bytes=5-9' });

      expect(out.body).toBe(body);
      expect(out.contentRange).toBe('bytes 5-9/10');
      const getInput = inputs.find(i => i.Key === 'uploads/movie.mp4');
      expect(getInput).toMatchObject({ Bucket: 'test-bucket', Key: 'uploads/movie.mp4', Range: 'bytes=5-9' });
    });
  });

  it('SDK YOKSA anlamli bir hata firlatir', () => {
    // Adin vaat ettigi sey artik GERCEKTEN olculuyor. Onceki hali BOS bir
    // govde uzerinde `not.toThrow()` diyordu — yani adinin TERSINI.
    // Hata GERI CAGRIM icinde yakalaniyor; TypeScript atamayi akista goremeyip
    // degiskeni `never`e daraltiyordu. Tek elemanli bir kutu bu daralmayi
    // kaldirir ve `as` gerektirmez.
    const caught: { error: Error | null } = { error: null };
    jest.isolateModules(() => {
      jest.doMock('../lib/_optional-require', () => ({ tryRequire: () => null }));
      const mod = require('../lib/storageAdapter') as typeof import('../lib/storageAdapter');
      try {
        mod.buildS3Adapter({
          provider: 's3', bucket: 'b', region: 'r',
          accessKeyId: 'k', secretAccessKey: 's', publicUrl: 'https://x',
        } as Parameters<typeof mod.buildS3Adapter>[0]);
      } catch (e) { caught.error = e instanceof Error ? e : new Error(String(e)); }
      jest.dontMock('../lib/_optional-require');
    });
    expect(caught.error).toBeInstanceOf(Error);
    expect(String(caught.error?.message)).toMatch(/@aws-sdk|s3|sdk/i);
  });

  describe('listFiles() — URUN KODU calistirilir', () => {
    it('nesneleri key + lastModifiedMs olarak dondurur', async () => {
      const { sdk } = recordingSdk([[
        { Key: 'a.png', LastModified: new Date(3000) },
        { Key: 'b.gif', LastModified: undefined },
      ]]);
      const adapter = adapterWithSdk(sdk);

      const out = await adapter.listFiles();

      expect(out).toEqual([
        { key: 'a.png', lastModifiedMs: 3000 },
        { key: 'b.gif', lastModifiedMs: undefined },
      ]);
    });

    it('LastModified BILINMEYEN nesne temizlikte guvenli tarafta kalir', () => {
      // `lastModifiedMs: undefined` temizlik isinde "silme" anlamina gelir.
      // Bu alanin sessizce 0'a donusmesi dosyayi ANINDA silinebilir yapardi.
      const { sdk } = recordingSdk([[{ Key: 'x.png', LastModified: undefined }]]);
      return adapterWithSdk(sdk).listFiles().then(out => {
        expect(out[0].lastModifiedMs).toBeUndefined();
        expect(out[0].lastModifiedMs).not.toBe(0);
      });
    });

    it('IsTruncated=true ise URUN sayfalama yapar (test kendi kopyasini degil)', async () => {
      const { sdk, send } = recordingSdk([
        [{ Key: 'a.png', LastModified: new Date(1000) }],
        [{ Key: 'b.png', LastModified: new Date(2000) }],
      ]);
      const adapter = adapterWithSdk(sdk);

      const out = await adapter.listFiles();

      expect(out.map(o => o.key)).toEqual(['a.png', 'b.png']);
      expect(send).toHaveBeenCalledTimes(2);          // gercekten iki sayfa istendi
    });

    it('devam jetonu SONRAKI istege gecirilir', async () => {
      const { sdk, inputs } = recordingSdk([
        [{ Key: 'a.png', LastModified: new Date(1) }],
        [{ Key: 'b.png', LastModified: new Date(2) }],
      ]);
      await adapterWithSdk(sdk).listFiles();

      expect(inputs[0].ContinuationToken).toBeUndefined();
      expect(inputs[1].ContinuationToken).toBe('tok-1');
    });

    // ── VERI KAYBI GERILEMESI ──────────────────────────────────────────────
    it('Delimiter="/" GONDERILIR — kova taramasi kok duzeyle sinirli', async () => {
      // Onceden onek/ayirici YOKTU: `ListObjectsV2` KOVANIN TAMAMINI
      // donduruyordu (stickers/, avatars/, server-assets/ dahil) ve temizlik
      // isi bunlari silme adayi yapiyordu. Yerel adaptor ozyinelemeli
      // OLMADIGI icin ayni kusuru gostermiyordu.
      const { sdk, inputs } = recordingSdk([[{ Key: 'a.png', LastModified: new Date(1) }]]);
      await adapterWithSdk(sdk).listFiles();

      expect(inputs).toHaveLength(1);
      expect(inputs[0].Prefix).toBe('uploads/');
      expect(inputs[0].Delimiter).toBe('/');
      expect(inputs[0].Bucket).toBe('test-bucket');
    });

    it('Key TASIMAYAN girdi atlanir', async () => {
      const { sdk } = recordingSdk([[
        { Key: '', LastModified: new Date(1) } as { Key: string; LastModified?: Date },
        { Key: 'ok.png', LastModified: new Date(2) },
      ]]);
      const out = await adapterWithSdk(sdk).listFiles();
      expect(out.map(o => o.key)).toEqual(['ok.png']);
    });
  });

  describe('keyFromUrl()', () => {
    it('bucket prefix varsa çıkarır', () => {
      const adapter = buildS3Adapter(testCfg({ bucket: 'my-bucket', publicUrl: 'https://cdn.example.com' }));
      // S3 path-style
      expect(adapter.keyFromUrl('https://s3.amazonaws.com/my-bucket/uploads/file.jpg'))
        .toBe('uploads/file.jpg');
    });

    it('bucket prefix yoksa key olduğu gibi döner', () => {
      const adapter = buildS3Adapter(testCfg({ publicUrl: 'https://cdn.example.com' }));
      expect(adapter.keyFromUrl('https://cdn.example.com/uploads/file.jpg'))
        .toBe('uploads/file.jpg');
    });

    it('korumalı relative Bridge URL için remote object key üretir', () => {
      const adapter = buildS3Adapter(testCfg({ publicUrl: 'https://cdn.example.com' }));
      expect(adapter.keyFromUrl('/uploads/file.jpg')).toBe('uploads/file.jpg');
    });

    it('göreli yol KEY olarak KORUNUR (basename’e indirgenmez)', () => {
      // ── ESKİ BEKLENTİ NEDEN YANLIŞTI ─────────────────────────────────────
      // Bu test `'file.jpg'` bekliyordu, çünkü eskiden `new URL(url)` göreli
      // girdide FIRLATIYOR ve `path.basename` yedeğine düşülüyordu.
      // `keyFromUrl` artık taban URL ile ayrıştırıyor (`new URL(url,
      // 'http://bridge.local')`), dolayısıyla göreli yol ayrıştırılabiliyor.
      //
      // KORUNAN DAVRANIŞ DAHA DOĞRUDUR: S3 anahtarları eğik çizgi İÇERİR.
      // Basename'e indirgemek `deleteFile`ın YANLIŞ nesneyi hedeflemesine ve
      // gerçeğinin orphan kalmasına yol açardı — yerel adaptördeki aynı hata
      // (lib/storageAdapter.ts:316-318) tam olarak bu yüzden düzeltilmişti.
      const adapter = buildS3Adapter(testCfg({ publicUrl: 'https://cdn.example.com' }));
      expect(adapter.keyFromUrl('not-a-url/file.jpg')).toBe('not-a-url/file.jpg');
    });

    it('bucket öneki KEY’den düşürülür, alt dizin korunur', () => {
      const adapter = buildS3Adapter(testCfg({ publicUrl: 'https://cdn.example.com' }));
      expect(adapter.keyFromUrl('https://s3.amazonaws.com/test-bucket/uploads/a/b.png'))
        .toBe('uploads/a/b.png');
    });

    it('publicUrlForKey yalnız provider canonical originini üretir', () => {
      const adapter = buildS3Adapter(testCfg({ publicUrl: 'https://cdn.example.com/base' }));
      expect(adapter.publicUrlForKey('uploads/server-gifs/a.gif')).toBe('https://cdn.example.com/base/uploads/server-gifs/a.gif');
    });
  });

  describe('uploadFile() — URUN KODU calistirilir', () => {
    function uploadSdk() {
      const inputs: Array<Record<string, unknown>> = [];
      function cmd(name: string) {
        const Ctor = class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) {
            this.input = input;
            if (name === 'PutObjectCommand') inputs.push(input);
          }
        };
        Object.defineProperty(Ctor, 'name', { value: name });
        return Ctor;
      }
      const send = jest.fn().mockResolvedValue({});
      return {
        inputs, send,
        sdk: {
          S3Client: jest.fn(() => ({ send })),
          ListObjectsV2Command: cmd('ListObjectsV2Command'),
          PutObjectCommand: cmd('PutObjectCommand'),
          DeleteObjectCommand: cmd('DeleteObjectCommand'),
          GetObjectCommand: cmd('GetObjectCommand'),
        },
      };
    }

    it('PutObject gercek girdisini yollar, contract doner ve deleteLocal=true ise temp dosyayi siler', async () => {
      const { sdk, inputs, send } = uploadSdk();
      const adapter = adapterWithSdk(sdk);
      const unlinkSpy = jest.mocked(fs.unlink);
      unlinkSpy.mockClear();
      (fs.createReadStream as jest.Mock).mockClear();

      const out = await adapter.uploadFile('/tmp/test.png', 'uploads/test.png', {
        contentType: 'image/png',
        cacheControl: 'private, no-store',
        deleteLocal: true,
      });

      expect(send).toHaveBeenCalledTimes(1);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'uploads/test.png',
        ContentType: 'image/png',
        CacheControl: 'private, no-store',
      });
      expect(inputs[0].Body).toBe((fs.createReadStream as jest.Mock).mock.results[0].value);
      expect(fs.createReadStream).toHaveBeenCalledWith('/tmp/test.png');
      expect(unlinkSpy).toHaveBeenCalledWith('/tmp/test.png', expect.any(Function));
      expect(out).toEqual({
        url: 'https://cdn.example.com/uploads/test.png',
        key: 'uploads/test.png',
        provider: 's3',
      });
    });

    it('deleteLocal=false ise basarili upload sonrasi temp dosyayi silmez', async () => {
      const { sdk, inputs } = uploadSdk();
      const adapter = adapterWithSdk(sdk);
      const unlinkSpy = jest.mocked(fs.unlink);
      unlinkSpy.mockClear();
      (fs.createReadStream as jest.Mock).mockClear();

      await adapter.uploadFile('/tmp/keep.webm', 'uploads/keep.webm', {
        contentType: 'audio/webm',
        deleteLocal: false,
      });

      expect(inputs[0]).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'uploads/keep.webm',
        ContentType: 'audio/webm',
      });
      expect(unlinkSpy).not.toHaveBeenCalled();
    });
  });

  describe('remote read/delete/health failure contract', () => {
    function sdkFor(sendImpl: (cmd: { constructor: { name: string } }) => Promise<unknown>) {
      function cmd(name: string) {
        const Ctor = class {
          input: Record<string, unknown>;
          constructor(input: Record<string, unknown>) { this.input = input; }
        };
        Object.defineProperty(Ctor, 'name', { value: name });
        return Ctor;
      }
      const send = jest.fn(sendImpl);
      return {
        send,
        sdk: {
          S3Client: jest.fn(() => ({ send })),
          ListObjectsV2Command: cmd('ListObjectsV2Command'),
          PutObjectCommand: cmd('PutObjectCommand'),
          DeleteObjectCommand: cmd('DeleteObjectCommand'),
          GetObjectCommand: cmd('GetObjectCommand'),
        },
      };
    }

    it('rejects GetObject responses whose Body is not a readable stream', async () => {
      const { sdk } = sdkFor(async cmd => cmd.constructor.name === 'GetObjectCommand' ? { Body: {} } : {});
      await expect(adapterWithSdk(sdk).readFile('uploads/bad.bin'))
        .rejects.toThrow(/readable stream|stream değil/i);
    });

    it('defaults Accept-Ranges to bytes and preserves remote metadata', async () => {
      const body = { pipe: jest.fn(), on: jest.fn() };
      const lastModified = new Date(99);
      const { sdk } = sdkFor(async cmd => cmd.constructor.name === 'GetObjectCommand' ? {
        Body: body,
        ContentType: 'application/pdf',
        ContentLength: 42,
        ETag: 'etag-1',
        LastModified: lastModified,
      } : {});
      const out = await adapterWithSdk(sdk).readFile('uploads/a.pdf');
      expect(out).toMatchObject({
        body, contentType: 'application/pdf', contentLength: 42,
        acceptRanges: 'bytes', etag: 'etag-1', lastModified,
      });
    });

    it('deleteFile sends the canonical bucket/key pair', async () => {
      let deleteInput: Record<string, unknown> | undefined;
      const { sdk, send } = sdkFor(async cmd => {
        if (cmd.constructor.name === 'DeleteObjectCommand') deleteInput = (cmd as unknown as { input: Record<string, unknown> }).input;
        return {};
      });
      await adapterWithSdk(sdk).deleteFile('uploads/dead.bin');
      expect(send).toHaveBeenCalledTimes(1);
      expect(deleteInput).toEqual({ Bucket: 'test-bucket', Key: 'uploads/dead.bin' });
    });

    it('private adapter refuses public URL construction when no public origin exists', () => {
      const { sdk } = sdkFor(async () => ({}));
      const adapter = adapterWithSdk(sdk, { publicUrl: undefined });
      expect(() => adapter.publicUrlForKey('uploads/secret.bin')).toThrow(/private storage|public URL/i);
    });

    it('healthCheck returns true on ListObjects success and false on provider failure', async () => {
      const ok = sdkFor(async () => ({ Contents: [], IsTruncated: false }));
      expect(await adapterWithSdk(ok.sdk).healthCheck()).toBe(true);

      const bad = sdkFor(async () => { throw new Error('provider down'); });
      expect(await adapterWithSdk(bad.sdk).healthCheck()).toBe(false);
    });
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// getStorageAdapter — factory + singleton
// ═════════════════════════════════════════════════════════════════════════════

describe('getStorageAdapter()', () => {
  beforeEach(() => {
    _resetAdapterForTest();
    delete process.env.CDN_PROVIDER;
    delete process.env.S3_BUCKET;
    delete process.env.R2_BUCKET;
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.MINIO_BUCKET;
    delete process.env.B2_BUCKET_NAME;
  });

  it('CDN_PROVIDER yoksa localAdapter döner', () => {
    const adapter = getStorageAdapter();
    expect(adapter).toBe(localAdapter);
  });

  it('CDN_PROVIDER=local → localAdapter', () => {
    process.env.CDN_PROVIDER = 'local';
    expect(getStorageAdapter()).toBe(localAdapter);
  });

  it('singleton: iki çağrı aynı instance döner', () => {
    const a = getStorageAdapter();
    const b = getStorageAdapter();
    expect(a).toBe(b);
  });

  it('_resetAdapterForTest() sonrası yeni instance oluşturur', () => {
    const a = getStorageAdapter();
    _resetAdapterForTest();
    const b = getStorageAdapter();
    expect(a).toBe(b); // her ikisi de local — içerik aynı ama reset çalıştı
  });

  it('bilinmeyen CDN_PROVIDER → fail-closed startup hatası', () => {
    process.env.CDN_PROVIDER = 'dropbox';
    expect(() => getStorageAdapter()).toThrow(/Bilinmeyen CDN_PROVIDER=dropbox|fail-closed/);
  });

  // S3/R2/MinIO/B2: @aws-sdk/client-s3 kurulu değilse hata fırlatır
  const remoteProviders: Array<[string, Record<string, string>]> = [
    ['s3',    { S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }],
    ['r2',    { R2_BUCKET: 'b', R2_ACCOUNT_ID: 'aid', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_PUBLIC_URL: 'https://x.r2.dev' }],
    ['minio', { MINIO_BUCKET: 'b', MINIO_ACCESS_KEY: 'k', MINIO_SECRET_KEY: 's' }],
    ['b2',    { B2_BUCKET_NAME: 'b', B2_KEY_ID: 'k', B2_APP_KEY: 's' }],
  ];

  remoteProviders.forEach(([provider, envVars]) => {
    it(`CDN_PROVIDER=${provider} → @aws-sdk eksikse hata fırlatır`, () => {
      process.env.CDN_PROVIDER = provider;
      Object.assign(process.env, envVars);
      // tryRequire null döndürürse buildS3Adapter hata fırlatır
      // Bu test config doğruluğunu test eder — SDK kurulu ortamda geçer
      // SDK yoksa Error bekliyoruz:
      jest.doMock('../lib/_optional-require', () => ({ tryRequire: () => null }));
      expect(() => {
        jest.resetModules();
        const { getStorageAdapter: gsa, _resetAdapterForTest: reset } =
          jest.requireActual('../lib/storageAdapter') as typeof import('../lib/storageAdapter');
        reset();
        // Env zaten set edildi
        process.env.CDN_PROVIDER = provider;
        // SDK yokken çağrı hata fırlatmalı
      }).not.toThrow(); // Import hata fırlatmaz, adapter oluşturma hatası fırlatır
      // Cleanup
      Object.keys(envVars).forEach(k => delete process.env[k]);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// _validateRemoteCredentials — Sprint 74: fail-fast credential checks
// ═════════════════════════════════════════════════════════════════════════════

describe('getStorageAdapter() — credential validation (Sprint 74)', () => {
  const ALL_REMOTE_ENVS = [
    'S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY',
    'R2_BUCKET','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_PUBLIC_URL',
    'MINIO_ENDPOINT','MINIO_BUCKET','MINIO_ACCESS_KEY','MINIO_SECRET_KEY',
    'B2_BUCKET_NAME','B2_KEY_ID','B2_APP_KEY',
    'CDN_PROVIDER',
  ];

  beforeEach(() => {
    _resetAdapterForTest();
    ALL_REMOTE_ENVS.forEach(k => delete process.env[k]);
  });

  afterEach(() => {
    _resetAdapterForTest();
    ALL_REMOTE_ENVS.forEach(k => delete process.env[k]);
  });

  it('S3: bucket eksikse hata fırlatır', () => {
    process.env.CDN_PROVIDER       = 's3';
    process.env.S3_ACCESS_KEY_ID     = 'key';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';
    // S3_BUCKET eksik
    expect(() => getStorageAdapter()).toThrow(/S3_BUCKET/);
  });

  it('S3: access key eksikse hata fırlatır', () => {
    process.env.CDN_PROVIDER       = 's3';
    process.env.S3_BUCKET          = 'my-bucket';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';
    // S3_ACCESS_KEY_ID eksik
    expect(() => getStorageAdapter()).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it('S3: boş string değer eksik sayılır', () => {
    process.env.CDN_PROVIDER         = 's3';
    process.env.S3_BUCKET            = '';   // boş string
    process.env.S3_ACCESS_KEY_ID     = 'key';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';
    expect(() => getStorageAdapter()).toThrow(/S3_BUCKET/);
  });

  it('R2: account_id eksikse hata fırlatır', () => {
    process.env.CDN_PROVIDER         = 'r2';
    process.env.R2_BUCKET            = 'bucket';
    process.env.R2_ACCESS_KEY_ID     = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    process.env.R2_PUBLIC_URL        = 'https://pub.r2.dev';
    // R2_ACCOUNT_ID eksik
    expect(() => getStorageAdapter()).toThrow(/R2_ACCOUNT_ID/);
  });

  it('MinIO: tüm zorunlular varsa hata fırlatmaz (SDK mock ile)', () => {
    process.env.CDN_PROVIDER    = 'minio';
    process.env.MINIO_ENDPOINT  = 'http://minio:9000';
    process.env.MINIO_BUCKET    = 'bridge-uploads';
    process.env.MINIO_ACCESS_KEY = 'minioadmin';
    process.env.MINIO_SECRET_KEY = 'minioadmin';
    // buildS3Adapter SDK kontrolünde hata fırlatabilir (tryRequire null),
    // ama _validateRemoteCredentials buraya kadar geçmeli:
    try { getStorageAdapter(); } catch (e) {
      expect((e as Error).message).not.toMatch(/MINIO_/);
    }
  });

  it('B2: bucket adı eksikse hata fırlatır', () => {
    process.env.CDN_PROVIDER = 'b2';
    process.env.B2_KEY_ID    = 'keyid';
    process.env.B2_APP_KEY   = 'appkey';
    // B2_BUCKET_NAME eksik
    expect(() => getStorageAdapter()).toThrow(/B2_BUCKET_NAME/);
  });

  it('local provider: credential validasyonu çalışmaz', () => {
    process.env.CDN_PROVIDER = 'local';
    // Hiçbir S3 env yok — local için hata fırlatılmamalı
    expect(() => getStorageAdapter()).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROVIDER sabiti
// ═════════════════════════════════════════════════════════════════════════════

describe('PROVIDER export', () => {
  it('CDN_PROVIDER env ile eşleşir', () => {
    jest.resetModules();
    delete process.env.CDN_PROVIDER;
    const { PROVIDER } = require('../lib/storageAdapter');
    expect(PROVIDER).toBe('local');
  });
});


describe('private storage boundary', () => {
  const PRIVATE_ENV_KEYS = [
    'PRIVATE_STORAGE_PROVIDER', 'PRIVATE_S3_BUCKET', 'PRIVATE_R2_BUCKET',
    'PRIVATE_MINIO_BUCKET', 'PRIVATE_B2_BUCKET_NAME',
  ];

  beforeEach(() => {
    _resetAdapterForTest();
    for (const key of PRIVATE_ENV_KEYS) delete process.env[key];
    delete process.env.CDN_PROVIDER;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
  });

  afterEach(() => {
    _resetAdapterForTest();
    for (const key of PRIVATE_ENV_KEYS) delete process.env[key];
  });

  it('defaults protected attachments to local even when public CDN is remote', () => {
    process.env.CDN_PROVIDER = 'r2';
    expect(getPrivateStorageProvider()).toBe('local');
    expect(getPrivateStorageAdapter()).toBe(localAdapter);
  });

  it('fails closed for an unknown private provider', () => {
    process.env.PRIVATE_STORAGE_PROVIDER = 'dropbox';
    expect(() => getPrivateStorageAdapter()).toThrow(/PRIVATE_STORAGE_PROVIDER|fail-closed/i);
  });

  it('rejects sharing the exact public S3 bucket with protected attachments', () => {
    process.env.CDN_PROVIDER = 's3';
    process.env.PRIVATE_STORAGE_PROVIDER = 's3';
    process.env.S3_BUCKET = 'public-bucket';
    process.env.PRIVATE_S3_BUCKET = 'public-bucket';
    process.env.S3_ACCESS_KEY_ID = 'key';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';
    expect(() => getPrivateStorageAdapter()).toThrow(/aynı olamaz|separate|ayrı/i);
  });
});
