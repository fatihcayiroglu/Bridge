// server/tests/cleanupUploads.test.ts
// cleanupUploads — birim testleri (adapter mock'lu, timer-free)
//
// Sprint 54 odağı: grace period hem local hem de remote adaptörlerde
// doğru çalıştığını doğrular.
//
// Sprint 62: getReferencedKeys() refactor testleri eklendi.
//   - Collection API yolu: Messages.findProjected + Dms.findMessagesWhere
//   - PostgreSQL yolu: db._pool.query ile UNION ALL sorgusu

process.env.NODE_ENV = 'test';

import type { StorageAdapter, StorageObject } from '../lib/storageAdapter';

// ── Logger mock ───────────────────────────────────────────────────────────────

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => mockLogger);

// ── Repositories mock ─────────────────────────────────────────────────────────

let mockChannelMessages: Array<{ fileUrl?: string }> = [];
let mockDmMessages:      Array<{ fileUrl?: string }> = [];
let mockGroupDmMessages: Array<{ fileUrl?: string }> = [];
let mockGroupDmFindError: Error | null = null;

jest.mock('../db/repositories', () => ({
  Messages: {
    findProjected: jest.fn(async () => mockChannelMessages),
  },
  Dms: {
    findMessagesWhere: jest.fn(async () => mockDmMessages),
  },
}));

// ── DB loader mock — PostgreSQL yolu test edilebilmesi için ───────────────────

let mockPoolQuery: jest.Mock | null = null;

jest.mock('../db/loader', () => ({
  get _pool() { return mockPoolQuery ? { query: mockPoolQuery } : undefined; },
  groupDmMessages: {
    find: jest.fn(async () => {
      if (mockGroupDmFindError) throw mockGroupDmFindError;
      return mockGroupDmMessages;
    }),
  },
}));

// ── storageAdapter mock ───────────────────────────────────────────────────────

let mockObjects: StorageObject[]             = [];
const mockDeleteFile  = jest.fn(async () => {});
const mockListFiles   = jest.fn(async () => mockObjects);
const mockKeyFromUrl  = jest.fn((url: string) => url.split('/').pop() ?? url);
const mockPublicUrlForKey = jest.fn((key: string) => `/uploads/${key.replace(/^uploads\//, '')}`);
const mockUploadFile = jest.fn(async (_localPath: string, key: string) => ({ url: `/uploads/${key}`, key: null, provider: 'local' as const }));
const mockReadFile = jest.fn(async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); });
const mockHealthCheck = jest.fn(async () => true);

const mockAdapter: StorageAdapter = {
  listFiles:       mockListFiles,
  uploadFile:      mockUploadFile,
  readFile:        mockReadFile,
  deleteFile:      mockDeleteFile,
  keyFromUrl:      mockKeyFromUrl,
  publicUrlForKey: mockPublicUrlForKey,
  healthCheck:     mockHealthCheck,
};

jest.mock('../lib/storageAdapter', () => ({
  getPrivateStorageAdapter: jest.fn(() => mockAdapter),
  getPrivateStorageProvider: jest.fn(() => process.env.PRIVATE_STORAGE_PROVIDER || 'local'),
}));




// ── Test yardımcıları ─────────────────────────────────────────────────────────

const GRACE_MS = 10 * 60 * 1000; // cleanupUploads MAX_FILE_AGE_MS ile aynı

function makeObject(key: string, ageMs: number): StorageObject {
  return { key, lastModifiedMs: Date.now() - ageMs };
}

function makeOldObject(key: string): StorageObject {
  return makeObject(key, GRACE_MS + 1);   // grace period dışında
}

function makeNewObject(key: string): StorageObject {
  return makeObject(key, GRACE_MS - 1000); // grace period içinde — korunmalı
}

function makeUnknownAgeObject(key: string): StorageObject {
  return { key }; // lastModifiedMs: undefined
}

// ── Import (mock'lar hazır olduktan sonra) ────────────────────────────────────

import { isReapable, runCleanup } from '../jobs/cleanupUploads';

// ─────────────────────────────────────────────────────────────────────────────
// Testler
// ─────────────────────────────────────────────────────────────────────────────

describe('runCleanup()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObjects          = [];
    mockChannelMessages  = [];
    mockDmMessages       = [];
    mockGroupDmMessages  = [];
    mockGroupDmFindError = null;
    mockPoolQuery        = null; // varsayılan: Collection API yolu
    process.env.PRIVATE_STORAGE_PROVIDER = 'local';
  });

  // ── Temel davranış ─────────────────────────────────────────

  it('dosya yoksa erken döner, delete çağrılmaz', async () => {
    mockObjects = [];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('tüm dosyalar referanslıysa hiçbirini silmez', async () => {
    mockObjects = [makeOldObject('img.png')];
    mockChannelMessages = [{ fileUrl: '/uploads/img.png' }];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('referanssız + eski dosyayı siler', async () => {
    mockObjects = [makeOldObject('orphan.png')];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledWith('orphan.png');
  });

  it('birden fazla dosyadan yalnızca referanssız olanı siler', async () => {
    mockObjects = [makeOldObject('keep.png'), makeOldObject('orphan.png')];
    mockChannelMessages = [{ fileUrl: '/uploads/keep.png' }];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith('orphan.png');
  });

  // ── Grace period ───────────────────────────────────────────

  it('[local] yeni dosyayı grace period nedeniyle korur', async () => {
    process.env.PRIVATE_STORAGE_PROVIDER = 'local';
    mockObjects = [makeNewObject('fresh.png')];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('[remote/r2] yeni dosyayı grace period nedeniyle korur', async () => {
    process.env.PRIVATE_STORAGE_PROVIDER = 'r2';
    mockObjects = [makeNewObject('fresh-remote.png')];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('[remote/s3] eski ve referanssız dosyayı siler', async () => {
    process.env.PRIVATE_STORAGE_PROVIDER = 's3';
    mockObjects = [makeOldObject('old-remote.png')];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledWith('old-remote.png');
  });

  // ── lastModifiedMs bilinmiyor — güvenli taraf ──────────────

  it('lastModifiedMs undefined ise dosyayı silmez', async () => {
    process.env.PRIVATE_STORAGE_PROVIDER = 'r2';
    mockObjects = [makeUnknownAgeObject('mystery.png')];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('lastModifiedMs bilinmeyen + eski dosya karışık — sadece eski bilineni siler', async () => {
    process.env.PRIVATE_STORAGE_PROVIDER = 's3';
    mockObjects = [
      makeUnknownAgeObject('unknown.png'),
      makeOldObject('old.png'),
    ];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith('old.png');
  });

  // ── DM mesaj referansları ──────────────────────────────────

  it('DM mesajındaki dosya URL\'sini korur', async () => {
    mockObjects = [makeOldObject('dm-file.png')];
    mockDmMessages = [{ fileUrl: '/uploads/dm-file.png' }];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('Group DM mesajındaki root upload referansını fallback modunda korur', async () => {
    mockObjects = [makeOldObject('gdm-file.png')];
    mockGroupDmMessages = [{ fileUrl: '/uploads/gdm-file.png' }];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('referans authority okunamazsa destructive cleanup fail-closed olur', async () => {
    mockObjects = [makeOldObject('would-be-orphan.png')];
    mockGroupDmFindError = new Error('group DM store down');
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cleanup.references.failed' }),
      expect.any(String),
    );
  });

  // ── Hata toleransı ─────────────────────────────────────────

  it('listFiles hata fırlatırsa erken döner, error loglanır', async () => {
    mockListFiles.mockRejectedValueOnce(new Error('S3 timeout'));
    await runCleanup();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cleanup.list.failed' }),
      expect.any(String),
    );
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('deleteFile hata fırlatırsa diğer dosyalar silinmeye devam eder', async () => {
    mockObjects = [makeOldObject('fail.png'), makeOldObject('ok.png')];
    mockDeleteFile
      .mockRejectedValueOnce(new Error('yarış koşulu'))
      .mockResolvedValueOnce(undefined);
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'fail.png' }),
      expect.any(String),
    );
  });

  // ── PostgreSQL yolu (Sprint 62) ────────────────────────────

  it('[pg] canonical UNION ile referenced key set oluşturulur; orphan ownership metadata da temizlenir', async () => {
    mockPoolQuery = jest.fn(async (sql: string) => {
      if (/^DELETE FROM uploads/.test(sql.trim())) return { rows: [] };
      return { rows: [{ v: '/uploads/keep-pg.png' }] };
    });
    mockObjects = [makeOldObject('keep-pg.png'), makeOldObject('orphan-pg.png')];
    await runCleanup();
    // Final21 Faz 8 (F21-8-01): referans sorgusu satirlari VERITABANINDA
    // tekillestirir. `UNION ALL` her mesajin avatar anlik goruntusunu Node
    // bellegine tasiyordu (1M mesajda 601 633 satir, +98 MB heap). Bu iddia
    // eskiden `UNION ALL`i ARIYORDU; kusuru kilitliyordu.
    const unionCall = mockPoolQuery.mock.calls.find(([sql]) => String(sql).includes(' UNION '));
    expect(unionCall).toBeTruthy();
    const referenceSql = String(unionCall?.[0]);
    expect(referenceSql).not.toContain('UNION ALL');
    expect(referenceSql).toContain('group_dm_messages');
    expect(referenceSql).toContain('podcast_settings');
    expect(referenceSql).toContain('"audioUrl" AS v FROM podcast_episodes');
    expect(referenceSql).toContain("'/uploads/' || filename AS v FROM podcast_episodes");
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith('orphan-pg.png');
    expect(mockPoolQuery).toHaveBeenCalledWith(
      'DELETE FROM uploads WHERE key = $1',
      ['uploads/orphan-pg.png'],
    );
  });

  it('[pg] filename-only podcast episode keeps its root upload', async () => {
    mockPoolQuery = jest.fn(async () => ({ rows: [{ v: '/uploads/podcast.mp3' }] }));
    mockObjects = [makeOldObject('podcast.mp3')];

    await runCleanup();

    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // VERİ KAYBI GERİLEMESİ — kalıcı varlıklar asla biçilmez
  // ══════════════════════════════════════════════════════════════════════════
  // Önceki hâlde referans kümesi SADECE `messages.fileUrl` +
  // `dm_messages.fileUrl` idi ve bu kümede olmayan her nesne siliniyordu.
  // Uzak modda `ListObjectsV2` önek filtresi olmadan çağrıldığı için KOVANIN
  // TAMAMI listeleniyordu — yani avatarlar, sunucu ikonları, emojiler,
  // soundboard sesleri ve ÇIKARTMALAR günlük işin silme adayıydı.

  it('ALT DİZİNDEKİ hiçbir nesne silinmez (uzak mod kova taraması)', async () => {
    // Referans kümesi BOŞ olsa bile kalıcı varlıklara dokunulmamalı.
    mockPoolQuery = jest.fn(async (sql: string) =>
      sql.includes('information_schema') ? { rows: [] } : { rows: [] });
    mockObjects = [
      makeOldObject('stickers/pack-1/happy.png'),
      makeOldObject('avatars/user-42.png'),
      makeOldObject('banners/user-42.png'),
      makeOldObject('server-assets/icon-9.png'),
      makeOldObject('soundboard/airhorn.mp3'),
      makeOldObject('member-profiles/p.png'),
      makeOldObject('_chunks/part-1'),
      makeOldObject('_quarantine/suspicious.exe'),
      makeOldObject('.gitkeep'),
    ];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('KÖK düzeydeki sahipsiz ek silinmeye devam eder (iş hâlâ çalışıyor)', async () => {
    // Kapsam kısıtı işi felç etmemeli — asıl görevi sürüyor.
    mockPoolQuery = jest.fn(async (sql: string) =>
      sql.includes('information_schema') ? { rows: [] } : { rows: [] });
    mockObjects = [makeOldObject('orphan-attachment.png')];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledWith('orphan-attachment.png');
  });

  it('AVATAR referansı kök düzeyde bile olsa korunur', async () => {
    // Bu düzeltmeden önce kök dizine yazılmış eski avatarlar `fileUrl`
    // kümesinde bulunmadığı için siliniyordu.
    mockPoolQuery = jest.fn(async (sql: string) => {
      if (sql.includes('information_schema')) {
        return { rows: [{ table_name: 'users', column_name: 'avatarUrl' }] };
      }
      return { rows: [{ v: '/uploads/legacy-avatar.png' }] };
    });
    mockObjects = [makeOldObject('legacy-avatar.png'), makeOldObject('junk.png')];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith('junk.png');
  });

  it('referans kümesi ÇÖZÜLEMEZSE hiçbir şey silinmez', async () => {
    // En kritik güvenlik kuralı: "bilmiyorum" ASLA "hepsini sil" demek
    // değildir. Sorgu hata verirse iş sessizce durmalıdır.
    mockPoolQuery = jest.fn(async (sql: string) => {
      if (sql.includes('information_schema')) {
        return { rows: [{ table_name: 'messages', column_name: 'fileUrl' }] };
      }
      throw new Error('pg down');
    });
    mockObjects = [makeOldObject('would-be-deleted.png')];
    await runCleanup().catch(() => { /* iş yukarıya hata verir — silme yok */ });
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('[pg] pool.query hatası destructive turu fail-closed bitirir ve error loglanır', async () => {
    mockPoolQuery = jest.fn().mockRejectedValueOnce(new Error('pg connect fail'));
    mockObjects   = [makeOldObject('some.png')];
    await expect(runCleanup()).resolves.toBeUndefined();
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cleanup.references.failed' }),
      expect.any(String),
    );
  });

  // ── startCleanupJob timer testi ────────────────────────────

  it('startCleanupJob — setTimeout ve setInterval kaydeder', () => {
    jest.useFakeTimers();
    const setTimeoutSpy  = jest.spyOn(global, 'setTimeout');
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const { startCleanupJob } = require('../jobs/cleanupUploads');
    startCleanupJob();

    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      5 * 60 * 1000,
    );
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      24 * 60 * 60 * 1000,
    );

    jest.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FAZ 7 — TEMIZLIK KAPSAMI: TAM GERILEME KILIDI
// ═══════════════════════════════════════════════════════════════════════════
// Duzeltme iki ozelligi AYNI ANDA saglamalidir. Yalnizca birini test etmek
// yaniltici olur:
//
//   1. EK OLMAYAN VARLIKLAR ASLA BICILMEZ  (veri kaybi korumasi)
//   2. GERCEKTEN SAHIPSIZ EKLER GUVENLE BICILEBILIR  (is hala calisiyor)
//
// Ikinci madde onemlidir: asiri temkinli bir "hicbir seyi silme" davranisi da
// bir kusurdur — depolama sonsuza dek buyur.

describe('isReapable remote root normalization', () => {
  it('remote uploads/<file> kök nesnesini temizlenebilir sayar', () => {
    expect(isReapable('uploads/orphan.png')).toBe(true);
  });

  it('remote kalıcı alt dizinleri kapsam dışında tutar', () => {
    expect(isReapable('uploads/server-assets/icon.png')).toBe(false);
    expect(isReapable('uploads/stickers/legacy.png')).toBe(false);
  });
});

describe('temizlik kapsami — varlik siniflari', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObjects         = [];
    mockChannelMessages = [];
    mockDmMessages      = [];
    mockPoolQuery       = null;
    process.env.PRIVATE_STORAGE_PROVIDER = 'local';
  });

  /** Verilen (tablo, sutun) referansini donduren sahte pg havuzu. */
  function poolWith(table: string, column: string, url: string) {
    return jest.fn(async (sql: string) => {
      if (sql.includes('information_schema')) {
        return { rows: [{ table_name: table, column_name: column }] };
      }
      return { rows: [{ v: url }] };
    });
  }

  // Her varlik sinifi KENDI sutunundan referanslanir. Bir sutun listeden
  // duserse o sinif sessizce silinmeye aday olur — bu testler bunu yakalar.
  const CLASSES: Array<[string, string, string, string]> = [
    ['avatar',        'users',              'avatarUrl', 'avatar-1.png'],
    ['banner',        'users',              'bannerUrl', 'banner-1.png'],
    ['sunucu ikonu',  'servers',            'iconUrl',   'icon-1.png'],
    ['sunucu banner', 'servers',            'bannerUrl', 'sbanner-1.png'],
    ['emoji',         'server_emojis',      'url',       'emoji-1.png'],
    ['soundboard',    'soundboard',         'url',       'sound-1.mp3'],
    ['sesli mesaj',   'voice_messages',     'url',       'vm-1.webm'],
    ['cikartma',      'sticker_pack_items', 'url',       'sticker-1.png'],
    ['gif',           'server_gifs',        'url',       'gif-1.gif'],
    ['webhook avatar','messages',           'avatarUrl', 'wh-avatar-1.png'],
  ];

  it.each(CLASSES)('%s KORUNUR (kok duzeyde bile)', async (_label, table, column, key) => {
    mockPoolQuery = poolWith(table, column, '/uploads/' + key);
    mockObjects = [makeOldObject(key), makeOldObject('gercek-sahipsiz.png')];
    await runCleanup();
    // Yalnizca sahipsiz olan silinmeli.
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith('gercek-sahipsiz.png');
  });

  it('`uploads.key` yalnız ownership metadata olduğundan tek başına orphan byte nesnesini KORUMAZ', async () => {
    mockPoolQuery = jest.fn(async (sql: string) => {
      if (/^DELETE FROM uploads/.test(sql.trim())) return { rows: [] };
      // Hiçbir canlı mesaj/asset referansı yok.
      return { rows: [] };
    });
    mockObjects = [makeOldObject('kayitli-yukleme.png')];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledWith('kayitli-yukleme.png');
    expect(mockPoolQuery).toHaveBeenCalledWith(
      'DELETE FROM uploads WHERE key = $1',
      ['uploads/kayitli-yukleme.png'],
    );
  });

  it('GDM fileUrl canlı referans olarak korunur', async () => {
    mockPoolQuery = jest.fn(async (sql: string) => {
      if (/^DELETE FROM uploads/.test(sql.trim())) return { rows: [] };
      expect(sql).toContain('group_dm_messages');
      return { rows: [{ v: '/uploads/gdm-live.png' }] };
    });
    mockObjects = [makeOldObject('gdm-live.png')];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('COK REFERANSLI dosya, referanslardan biri kalkinca da KORUNUR', async () => {
    // Ayni dosya hem bir mesajda hem bir avatarda kullanilabilir. Tek bir
    // referansin silinmesi dosyayi sahipsiz YAPMAZ.
    mockPoolQuery = jest.fn(async (sql: string) => {
      if (sql.includes('information_schema')) {
        return { rows: [
          { table_name: 'messages', column_name: 'fileUrl'   },
          { table_name: 'users',    column_name: 'avatarUrl' },
        ] };
      }
      // Mesaj referansi KALKTI; avatar referansi DURUYOR.
      return { rows: [{ v: '/uploads/paylasilan.png' }] };
    });
    mockObjects = [makeOldObject('paylasilan.png')];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('SON referans da kalkinca dosya BICILEBILIR (is hala calisiyor)', async () => {
    // Karsi yon: asiri temkinli davranis da kusurdur. Referans kalmayinca
    // dosya gercekten silinmelidir.
    mockPoolQuery = jest.fn(async (sql: string) => {
      if (sql.includes('information_schema')) {
        return { rows: [{ table_name: 'messages', column_name: 'fileUrl' }] };
      }
      return { rows: [] };            // hicbir referans kalmadi
    });
    mockObjects = [makeOldObject('artik-sahipsiz.png')];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledWith('artik-sahipsiz.png');
  });

  // ── Kapsam kacisi ────────────────────────────────────────────────────────
  const TRAVERSAL = [
    '../../../etc/passwd',
    '..\..\windows\system32\config',
    'stickers/../../root.png',
    'uploads/../../../secret.key',
    '/etc/shadow',
    '.env',
    '_internal-manifest',
    '',
  ];

  it.each(TRAVERSAL)('kapsam disi anahtar SILINMEZ: %s', async (key) => {
    // Referans kumesi BOS olsa bile bu anahtarlar degerlendirilmemeli.
    mockPoolQuery = jest.fn(async () => ({ rows: [] }));
    mockObjects = [makeOldObject(key)];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('TEKRARLANAN temizlik guvenlidir (idempotent)', async () => {
    // Ikinci kosumda dosya artik listede yoktur; hata olmamalidir.
    mockPoolQuery = jest.fn(async () => ({ rows: [] }));
    mockObjects = [makeOldObject('bir-kez.png')];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);

    mockObjects = [];                 // silindi, artik yok
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);   // yeni cagri YOK
  });

  it('ZATEN SILINMIS dosya tolere edilir (yaris kosulu)', async () => {
    mockPoolQuery = jest.fn(async () => ({ rows: [] }));
    mockDeleteFile.mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as never,
    );
    mockObjects = [makeOldObject('kayip.png'), makeOldObject('var.png')];
    await expect(runCleanup()).resolves.toBeUndefined();   // firlatmaz
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);       // digeri devam eder
  });
});
