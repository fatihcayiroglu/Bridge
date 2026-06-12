/**
 * server/tests/lib-unit.test.js
 * server/lib/ katmanı birim testleri
 *
 * Kapsam:
 *   captcha          — getBotScore, _getIp, verifyCaptcha (devre dışı), kilit/kayıt sayaçları
 *   contentScanner   — fileHash, listQuarantinedFiles, deleteQuarantinedFile, scanFile (devre dışı)
 *   svgSanitizer     — sanitizeSvgString (tehlikeli / temiz SVG), isSvgSafe
 *   pushSender       — modül import kontrolü (VAPID yoksa webpush null)
 *   permissions      — PERMS bayrakları, DEFAULT_PERMISSIONS, VALID_BITS, hasFlag yardımcısı
 *   presenceCache    — trackSocket / releaseSocket / isUserOnline (Redis mock)
 *   notifications    — extractMentions
 */

'use strict';

const os   = require('os');
const fs   = require('fs');
import path from 'path';
import crypto from 'crypto';

// ── Mock'lar ──────────────────────────────────────────────────────────────────

// redisAdapter — presenceCache ve captcha için
// cache gerçekte { get, set, del, invalidatePattern, ... } metodları olan bir nesne
// jest.mock factory'si hoist edildiği için mock fn'leri doğrudan içinde tanımlanır.
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get:               jest.fn().mockResolvedValue(null),
    set:               jest.fn().mockResolvedValue(undefined),
    del:               jest.fn().mockResolvedValue(undefined),
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    increment:         jest.fn().mockResolvedValue(1),
  },
  subscribeToChannel:  jest.fn().mockResolvedValue(async () => {}),
  publishToChannel:    jest.fn().mockResolvedValue(undefined),
  getClient:           jest.fn().mockReturnValue(null),
  redisClient:         jest.fn().mockReturnValue(null),
}));

// db/repositories — notifications/pushSender için
jest.mock('../db/repositories', () => ({
  Users:         { findByIds: jest.fn().mockResolvedValue([]) },
  Channels:      { findById: jest.fn().mockResolvedValue(null) },
  Members:       { findWhere: jest.fn().mockResolvedValue([]) },
  Notifications: {
    insert:              jest.fn().mockResolvedValue({}),
    upsertNativeToken:   jest.fn().mockResolvedValue({}),
    removeNativeToken:   jest.fn().mockResolvedValue({}),
    findWhere:           jest.fn().mockResolvedValue([]),
  },
  Servers:  { findById: jest.fn().mockResolvedValue(null) },
  Roles:    { findWhere: jest.fn().mockResolvedValue([]) },
  Messages: { findWhere: jest.fn().mockResolvedValue([]) },
  Dms:      { findById: jest.fn().mockResolvedValue(null) },
  Auth:     { findById: jest.fn().mockResolvedValue(null) },
}));

// logger — sessiz tut
jest.mock('../lib/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  fatal: jest.fn(),
}));

// ══════════════════════════════════════════════════════════════════════════════
// captcha
// ══════════════════════════════════════════════════════════════════════════════

describe('lib/captcha', () => {
  let captcha;

  beforeEach(() => {
    // Her test öncesi modül cache'i sıfırla → CAPTCHA_ENABLED env'i temiz alınsın.
    // beforeEach + resetModules, sadece bu describe bloğunu etkiler çünkü
    // diğer bloklar kendi require çağrılarını kendi beforeEach'larında yapar.
    jest.resetModules();
    process.env.CAPTCHA_ENABLED = 'false';
    captcha = require('../lib/captcha');
  });

  afterEach(() => {
    delete process.env.CAPTCHA_ENABLED;
  });

  describe('getBotScore', () => {
    test('normal tarayıcı isteği için düşük puan döner', () => {
      const req = {
        headers: {
          'user-agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
          'accept-language':  'tr-TR,tr;q=0.9',
          'accept':           'text/html,application/xhtml+xml',
          'accept-encoding':  'gzip, deflate, br',
          'connection':       'keep-alive',
          'sec-fetch-site':   'none',
          'sec-fetch-mode':   'navigate',
        },
        method: 'GET',
        socket: { remoteAddress: '1.2.3.4' },
      };
      expect(captcha.getBotScore(req)).toBeLessThan(60);
    });

    test('curl user-agent yüksek bot puanı alır', () => {
      const req = {
        headers: { 'user-agent': 'curl/7.88.1' },
        method: 'GET',
        socket: { remoteAddress: '1.2.3.4' },
      };
      expect(captcha.getBotScore(req)).toBeGreaterThanOrEqual(50);
    });

    test('user-agent yoksa puan artar', () => {
      const req = {
        headers: {},
        method: 'GET',
        socket: { remoteAddress: '1.2.3.4' },
      };
      expect(captcha.getBotScore(req)).toBeGreaterThan(0);
    });
  });

  describe('_getIp', () => {
    test('doğrudan IP döner', () => {
      const req = {
        socket: { remoteAddress: '5.6.7.8' },
        headers: {},
      };
      expect(captcha._getIp(req)).toBe('5.6.7.8');
    });

    test('proxy arkasında X-Forwarded-For ilk IP kullanılır', () => {
      const req = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
      };
      expect(captcha._getIp(req)).toBe('203.0.113.5');
    });
  });

  describe('verifyCaptcha — devre dışı', () => {
    test('CAPTCHA devre dışıysa ok:true ve skip:true döner', async () => {
      const result = await captcha.verifyCaptcha('', '1.2.3.4');
      expect(result).toMatchObject({ ok: true, skip: true });
    });
  });

  describe('isLoginLocked / recordFailedLogin', () => {
    const TEST_IP = '10.20.30.40';

    beforeEach(async () => {
      // Sayacı temizle (başarılı giriş sıfırlar)
      await captcha.recordSuccessfulLogin(TEST_IP);
    });

    test('yeni IP kilitli değil', async () => {
      expect(await captcha.isLoginLocked('99.99.99.99')).toBe(false);
    });

    test('başarısız giriş sayısı artar', async () => {
      await captcha.recordFailedLogin(TEST_IP);
      expect(await captcha.getFailCount(TEST_IP)).toBe(1);
    });

    test('başarılı giriş sayacı sıfırlar', async () => {
      await captcha.recordFailedLogin(TEST_IP);
      await captcha.recordSuccessfulLogin(TEST_IP);
      expect(await captcha.getFailCount(TEST_IP)).toBe(0);
    });
  });

  describe('getPublicConfig', () => {
    test('enabled false ise provider none döner', () => {
      const cfg = captcha.getPublicConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.provider).toBe('none');
    });
  });

  describe('GENERIC_LOGIN_ERROR', () => {
    test('sabit tanımlı', () => {
      expect(typeof captcha.GENERIC_LOGIN_ERROR).toBe('string');
      expect(captcha.GENERIC_LOGIN_ERROR.length).toBeGreaterThan(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// contentScanner
// ══════════════════════════════════════════════════════════════════════════════

describe('lib/contentScanner', () => {
  let scanner;
  let tmpDir;

  beforeEach(() => {
    // Modül cache'i bu describe'a özel sıfırla — diğer describe bloklarını etkilemez.
    jest.resetModules();
    process.env.CONTENT_SCAN_ENABLED = 'false'; // VirusTotal çağrısı olmaz
    scanner = require('../lib/contentScanner');
    tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CONTENT_SCAN_ENABLED;
  });

  describe('fileHash', () => {
    test("geçerli dosyanın sha256 hash'ini döner", async () => {
      const file = path.join(tmpDir, 'hello.txt');
      fs.writeFileSync(file, 'merhaba dünya');
      const hash = await scanner.fileHash(file);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    test('aynı içerik her seferinde aynı hash üretir', async () => {
      const file = path.join(tmpDir, 'same.txt');
      fs.writeFileSync(file, 'sabit içerik 123');
      const [h1, h2] = await Promise.all([scanner.fileHash(file), scanner.fileHash(file)]);
      expect(h1).toBe(h2);
    });

    test('var olmayan dosya için hata fırlatır', async () => {
      await expect(scanner.fileHash('/tmp/__noexist__abc.txt')).rejects.toThrow();
    });
  });

  describe('scanFile — devre dışı', () => {
    test('CONTENT_SCAN_ENABLED=false ise skipped döner', async () => {
      const file = path.join(tmpDir, 'skip.txt');
      fs.writeFileSync(file, 'içerik');
      const result = await scanner.scanFile(file, {});
      expect(result).toMatchObject({ safe: true, skipped: true });
    });
  });

  describe('listQuarantinedFiles / deleteQuarantinedFile', () => {
    test('liste döner (boş olabilir)', () => {
      const list = scanner.listQuarantinedFiles();
      expect(Array.isArray(list)).toBe(true);
    });

    test('var olmayan dosya silinmeye çalışılırsa hata fırlatmaz', () => {
      expect(() => scanner.deleteQuarantinedFile('__nonexistent_file__.txt')).not.toThrow();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// svgSanitizer
// ══════════════════════════════════════════════════════════════════════════════

describe('lib/svgSanitizer', () => {
  let svg;

  beforeAll(() => {
    svg = require('../lib/svgSanitizer');
  });

  const CLEAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="blue"/>
</svg>`;

  const XSS_SCRIPT = `<svg xmlns="http://www.w3.org/2000/svg">
  <script>alert('xss')</script>
  <circle cx="50" cy="50" r="40"/>
</svg>`;

  const XSS_ONERROR = `<svg xmlns="http://www.w3.org/2000/svg">
  <image onerror="alert(1)" href="x"/>
</svg>`;

  const XSS_FOREIGN = `<svg xmlns="http://www.w3.org/2000/svg">
  <foreignObject><body><script>alert(1)</script></body></foreignObject>
</svg>`;

  describe('sanitizeSvgString', () => {
    test('temiz SVG değişmeden çıkar ve stripped boş', () => {
      const { clean, stripped } = svg.sanitizeSvgString(CLEAN_SVG);
      expect(stripped).toHaveLength(0);
      expect(clean).toContain('<circle');
    });

    test('script elementi kaldırılır', () => {
      const { clean, stripped } = svg.sanitizeSvgString(XSS_SCRIPT);
      expect(clean).not.toMatch(/<script/i);
      expect(stripped.some(s => s.includes('script'))).toBe(true);
    });

    test('onerror attribute kaldırılır', () => {
      const { clean, stripped } = svg.sanitizeSvgString(XSS_ONERROR);
      expect(clean).not.toMatch(/onerror/i);
      expect(stripped.some(s => s.includes('onerror'))).toBe(true);
    });

    test('foreignObject kaldırılır', () => {
      const { clean, stripped } = svg.sanitizeSvgString(XSS_FOREIGN);
      expect(clean).not.toMatch(/<foreignObject/i);
      expect(stripped.some(s => s.includes('foreignObject'))).toBe(true);
    });

    test('CDATA bölümleri kaldırılır', () => {
      const cdataSvg = `<svg><style><![CDATA[ body{color:red} ]]></style></svg>`;
      const { stripped } = svg.sanitizeSvgString(cdataSvg);
      expect(stripped.some(s => s.includes('CDATA'))).toBe(true);
    });

    test('javascript: href kaldırılır', () => {
      const jsSvg = `<svg><a href="javascript:alert(1)">click</a></svg>`;
      const { clean } = svg.sanitizeSvgString(jsSvg);
      expect(clean).not.toMatch(/javascript:/i);
    });
  });

  describe('isSvgSafe', () => {
    test('temiz SVG için true döner', () => {
      expect(svg.isSvgSafe(CLEAN_SVG)).toBe(true);
    });

    test('script içeren SVG için false döner', () => {
      expect(svg.isSvgSafe(XSS_SCRIPT)).toBe(false);
    });

    test('onerror attribute içeren SVG için false döner', () => {
      expect(svg.isSvgSafe(XSS_ONERROR)).toBe(false);
    });
  });

  describe('sanitizeSvgFile', () => {
    let tmpDir;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-svg-'));
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('SVG olmayan dosya dokunulmadan güvenli döner', async () => {
      const file = path.join(tmpDir, 'test.png');
      fs.writeFileSync(file, 'fake png');
      const result = await svg.sanitizeSvgFile(file);
      expect(result).toMatchObject({ safe: true, rewritten: false });
    });

    test('temiz SVG güvenli döner ve dosya değişmez', async () => {
      const file = path.join(tmpDir, 'clean.svg');
      fs.writeFileSync(file, CLEAN_SVG);
      const result = await svg.sanitizeSvgFile(file);
      expect(result.safe).toBe(true);
      expect(result.rewritten).toBe(false);
    });

    test('tehlikeli SVG sanitize edilir ve dosya yeniden yazılır', async () => {
      const file = path.join(tmpDir, 'dirty.svg');
      fs.writeFileSync(file, XSS_ONERROR);
      const result = await svg.sanitizeSvgFile(file);
      expect(result.safe).toBe(true);
      expect(result.rewritten).toBe(true);
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toMatch(/onerror/i);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// pushSender — yalnızca import & tip kontrolleri (VAPID yok)
// ══════════════════════════════════════════════════════════════════════════════

describe('lib/pushSender', () => {
  beforeAll(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  test('modül hatasız import edilir', () => {
    expect(() => require('../lib/pushSender')).not.toThrow();
  });

  test('sendPushToUser fonksiyonu export edilmiş', () => {
    const ps = require('../lib/pushSender');
    expect(typeof ps.sendPushToUser).toBe('function');
  });

  test('VAPID yokken sendPushToUser hata fırlatmaz', async () => {
    const ps = require('../lib/pushSender');
    // VAPID olmadığında gönderi sessizce başarısız olur veya skip eder
    await expect(ps.sendPushToUser('userId', { title: 't', body: 'b' })).resolves.not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// permissions
// ══════════════════════════════════════════════════════════════════════════════

describe('lib/permissions', () => {
  let perms;

  beforeAll(() => {
    perms = require('../lib/permissions');
  });

  test('PERMS nesnesi beklenen bayrakları içerir', () => {
    const expected = [
      'VIEW_CHANNELS', 'MANAGE_CHANNELS', 'SEND_MESSAGES',
      'ADMINISTRATOR', 'BAN_MEMBERS', 'KICK_MEMBERS',
    ];
    for (const flag of expected) {
      expect(perms.PERMS).toHaveProperty(flag);
      expect(typeof perms.PERMS[flag]).toBe('number');
    }
  });

  test('her PERM bayrağı 2\'nin kuvvetidir', () => {
    for (const val of Object.values(perms.PERMS)) {
      expect(Number.isInteger(Math.log2(val))).toBe(true);
    }
  });

  test('ADMINISTRATOR en büyük tekil bit\'tir', () => {
    for (const [key, val] of Object.entries(perms.PERMS)) {
      if (key !== 'ADMINISTRATOR' && key !== 'ADMIN') {
        expect(perms.PERMS.ADMINISTRATOR).toBeGreaterThan(val);
      }
    }
  });

  test('DEFAULT_PERMISSIONS VIEW_CHANNELS içerir', () => {
    expect(perms.DEFAULT_PERMISSIONS & perms.PERMS.VIEW_CHANNELS).toBeTruthy();
  });

  test('DEFAULT_PERMISSIONS ADMINISTRATOR içermez', () => {
    expect(perms.DEFAULT_PERMISSIONS & perms.PERMS.ADMINISTRATOR).toBe(0);
  });

  test('VALID_BITS tüm bayrakları kapsar', () => {
    for (const val of Object.values(perms.PERMS)) {
      expect(perms.VALID_BITS & val).toBe(val);
    }
  });

  test('bit OR ile birden fazla izin birleştirilebilir', () => {
    const combined = perms.PERMS.VIEW_CHANNELS | perms.PERMS.SEND_MESSAGES;
    expect(combined & perms.PERMS.VIEW_CHANNELS).toBeTruthy();
    expect(combined & perms.PERMS.SEND_MESSAGES).toBeTruthy();
    expect(combined & perms.PERMS.BAN_MEMBERS).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// presenceCache
// ══════════════════════════════════════════════════════════════════════════════

describe('lib/presenceCache', () => {
  let pc;
  let cacheGet, cacheSet, cacheDel;

  beforeAll(() => {
    // jest.mock hoisting sonrası mock referanslarını al
    const redisAdapter = require('../lib/redisAdapter');
    cacheGet = redisAdapter.cache.get;
    cacheSet = redisAdapter.cache.set;
    cacheDel = redisAdapter.cache.del;
    pc = require('../lib/presenceCache');
  });

  afterEach(() => {
    cacheGet.mockReset().mockResolvedValue(null);
    cacheSet.mockReset().mockResolvedValue(undefined);
    cacheDel.mockReset().mockResolvedValue(undefined);
  });

  test('modül hatasız import edilir', () => {
    expect(pc).toBeDefined();
  });

  test('trackSocket → cache.set çağrılır (online heartbeat)', async () => {
    await pc.trackSocket('user1', 'socket1');
    expect(cacheSet).toHaveBeenCalled();
    const calls = cacheSet.mock.calls;
    expect(calls.some(([key]) => String(key).includes('online'))).toBe(true);
  });

  test('releaseSocket — son socket gidince cache.del çağrılır', async () => {
    await pc.trackSocket('user2', 'socketA');
    cacheDel.mockReset();
    await pc.releaseSocket('user2', 'socketA');
    expect(cacheDel).toHaveBeenCalled();
  });

  test('isUserOnline: cache.get null dönerse false', async () => {
    cacheGet.mockResolvedValueOnce(null);
    const result = await pc.isUserOnline('no-one');
    expect(result).toBe(false);
    expect(cacheGet).toHaveBeenCalledWith(expect.stringContaining('online'));
  });

  test('isUserOnline: cache.get değer dönerse true', async () => {
    cacheGet.mockResolvedValueOnce(1);
    const result = await pc.isUserOnline('online-user');
    expect(result).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// notifications — extractMentions
// ══════════════════════════════════════════════════════════════════════════════

describe('lib/notifications — extractMentions', () => {
  let notif;

  beforeAll(() => {
    notif = require('../lib/notifications');
  });

  test('modül hatasız import edilir', () => {
    expect(notif).toBeDefined();
  });

  test('extractMentions fonksiyonu export edilmiş', () => {
    expect(typeof notif.extractMentions).toBe('function');
  });

  test('@kullanıcı mention\'larını çıkarır', () => {
    const mentions = notif.extractMentions('Merhaba @ahmet ve @ayse, nasılsınız?');
    expect(mentions).toContain('ahmet');
    expect(mentions).toContain('ayse');
  });

  test('@everyone ve @here mention listesine dahil edilmez', () => {
    const mentions = notif.extractMentions('@everyone burayı oku @here');
    expect(mentions).not.toContain('everyone');
    expect(mentions).not.toContain('here');
  });

  test('mention içermeyen mesajda boş dizi döner', () => {
    const mentions = notif.extractMentions('bu mesajda mention yok');
    expect(mentions).toHaveLength(0);
  });

  test('processNotifications fonksiyonu export edilmiş', () => {
    expect(typeof notif.processNotifications).toBe('function');
  });
});
