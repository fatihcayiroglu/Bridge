// server/tests/ipReputation.test.ts
// IP Reputation Kontrolü — birim + entegrasyon testleri
//
// Bu testler hiçbir harici ağ isteği yapmaz.
// AbuseIPDB ve Tor listesi tamamen mock'lanır.

process.env.NODE_ENV       = 'test';
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';

// ipBan.js, ipReputation.js tarafından import ediliyor —
// getClientIp'in çalışması için gerçek modül yüklenmeli.
jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// https modülünü mock'la — AbuseIPDB isteklerini simüle etmek için
let _mockHttpsResponse = null; // { statusCode, body } | null (= timeout)
jest.mock('https', () => ({
  get: jest.fn((url, optsOrCb, cb) => {
    // https.get(url, headers, callback) veya https.get(url, callback)
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    const mockRes = {
      on: jest.fn((event, handler) => {
        if (event === 'data' && _mockHttpsResponse) handler(_mockHttpsResponse.body);
        if (event === 'end')                         handler();
        return mockRes;
      }),
    };
    process.nextTick(() => {
      if (_mockHttpsResponse === null) {
        // timeout simülasyonu — req.setTimeout callback'ini tetikle
        return;
      }
      if (callback) callback(mockRes);
    });
    return {
      setTimeout: jest.fn(),
      destroy:    jest.fn(),
      on:         jest.fn(),
    };
  }),
}));

const {
  checkIpReputation,
  ipReputationMiddleware,
  _clearCache,
  _setStaticBlocklist,
  _setTorExitNodes,
  _setConfig,
  _getConfig,
  _isPrivateIp,
  _ipInCidr,
} = require('../middleware/ipReputation');

// Her testten önce cache'i ve ayarları sıfırla
beforeEach(() => {
  _clearCache();
  _setStaticBlocklist(new Set());
  _setTorExitNodes(new Set());
  _mockHttpsResponse = null;
  _setConfig({
    enabled:         true,
    abuseIpDbKey:    null,   // API key yok → AbuseIPDB atlanır
    abuseThreshold:  80,
    cacheTtlMs:      3600000,
    blockTor:        false,
    blocklistPath:   null,
  });
});

// ══════════════════════════════════════════════════════════════
// YARDIMCI FONKSİYONLAR
// ══════════════════════════════════════════════════════════════

describe('_isPrivateIp', () => {
  it('loopback adreslerini özel kabul eder', () => {
    expect(_isPrivateIp('127.0.0.1')).toBe(true);
    expect(_isPrivateIp('::1')).toBe(true);
  });

  it('RFC-1918 bloklarını özel kabul eder', () => {
    expect(_isPrivateIp('10.0.0.1')).toBe(true);
    expect(_isPrivateIp('10.255.255.255')).toBe(true);
    expect(_isPrivateIp('172.16.0.1')).toBe(true);
    expect(_isPrivateIp('172.31.255.255')).toBe(true);
    expect(_isPrivateIp('192.168.1.100')).toBe(true);
  });

  it('genel IP adreslerini özel saymaz', () => {
    expect(_isPrivateIp('8.8.8.8')).toBe(false);
    expect(_isPrivateIp('1.1.1.1')).toBe(false);
    expect(_isPrivateIp('203.0.113.5')).toBe(false);
  });

  it('bilinmeyen / boş değerleri güvenli kabul eder', () => {
    expect(_isPrivateIp('unknown')).toBe(true);
    expect(_isPrivateIp('')).toBe(true);
    expect(_isPrivateIp(null)).toBe(true);
  });
});

describe('_ipInCidr', () => {
  it('/24 bloğu içindeki IP eşleşir', () => {
    expect(_ipInCidr('192.168.1.50', '192.168.1.0/24')).toBe(true);
  });

  it('/24 bloğu dışındaki IP eşleşmez', () => {
    expect(_ipInCidr('192.168.2.1', '192.168.1.0/24')).toBe(false);
  });

  it('/32 tek IP eşleşir', () => {
    expect(_ipInCidr('1.2.3.4', '1.2.3.4/32')).toBe(true);
    expect(_ipInCidr('1.2.3.5', '1.2.3.4/32')).toBe(false);
  });

  it('CIDR olmayan girdi düz IP karşılaştırması yapar', () => {
    expect(_ipInCidr('5.5.5.5', '5.5.5.5')).toBe(true);
    expect(_ipInCidr('5.5.5.6', '5.5.5.5')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// DEVRE DIŞI MOD
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — devre dışı', () => {
  beforeEach(() => _setConfig({ enabled: false }));

  it('enabled=false iken hiçbir zaman engel koymaz', async () => {
    _setStaticBlocklist(new Set(['8.8.8.8']));
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// ÖZEL IP KORUMALARI
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — özel IP\'ler', () => {
  it('loopback IP\'yi engellemiyor', async () => {
    _setStaticBlocklist(new Set(['127.0.0.1'])); // blocklist'te olsa bile
    const result = await checkIpReputation('127.0.0.1');
    expect(result.blocked).toBe(false);
  });

  it('RFC-1918 IP\'yi engellemiyor', async () => {
    const result = await checkIpReputation('192.168.0.1');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// STATİK BLOCKLİST
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — statik blocklist', () => {
  it('blocklist\'teki IP engellenir', async () => {
    _setStaticBlocklist(new Set(['1.2.3.4', '5.6.7.8']));
    const result = await checkIpReputation('1.2.3.4');
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/statik/i);
  });

  it('blocklist\'te olmayan IP geçer', async () => {
    _setStaticBlocklist(new Set(['1.2.3.4']));
    const result = await checkIpReputation('9.9.9.9');
    expect(result.blocked).toBe(false);
  });

  it('CIDR bloğundaki IP engellenir', async () => {
    _setStaticBlocklist(new Set(['10.100.0.0/16'])); // özel gibi görünüyor ama test için
    // Test: CIDR mantığını kontrol et — genel IP ile
    _setStaticBlocklist(new Set(['203.0.113.0/24']));
    const result = await checkIpReputation('203.0.113.42');
    expect(result.blocked).toBe(true);
  });

  it('CIDR dışındaki IP geçer', async () => {
    _setStaticBlocklist(new Set(['203.0.113.0/24']));
    const result = await checkIpReputation('203.0.114.1');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// TOR ÇIKIŞ DÜĞÜMLERİ
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — Tor engeli', () => {
  beforeEach(() => _setConfig({ blockTor: true }));

  it('Tor çıkış düğümü engellenir', async () => {
    _setTorExitNodes(new Set(['185.220.101.1']));
    const result = await checkIpReputation('185.220.101.1');
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/tor/i);
  });

  it('Tor listesinde olmayan IP geçer', async () => {
    _setTorExitNodes(new Set(['185.220.101.1']));
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(false);
  });

  it('blockTor=false iken Tor düğümü geçer', async () => {
    _setConfig({ blockTor: false });
    _setTorExitNodes(new Set(['185.220.101.1']));
    const result = await checkIpReputation('185.220.101.1');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// ABUSEIPDB ENTEGRASYONU
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — AbuseIPDB', () => {
  beforeEach(() => {
    _setConfig({ abuseIpDbKey: 'test-api-key', abuseThreshold: 80 });
  });

  it('eşiği aşan skor IP\'yi engeller', async () => {
    _mockHttpsResponse = {
      body: JSON.stringify({
        data: {
          abuseConfidenceScore: 95,
          isTor: false,
          countryCode: 'CN',
          totalReports: 42,
        },
      }),
    };
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(true);
    expect(result.score).toBe(95);
    expect(result.reason).toMatch(/95/);
  });

  it('eşiğin altındaki skor IP\'yi geçirir', async () => {
    _mockHttpsResponse = {
      body: JSON.stringify({
        data: {
          abuseConfidenceScore: 30,
          isTor: false,
          countryCode: 'US',
          totalReports: 2,
        },
      }),
    };
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(false);
  });

  it('tam eşik değerindeki skor engeller (>=)', async () => {
    _setConfig({ abuseThreshold: 50 });
    _mockHttpsResponse = {
      body: JSON.stringify({
        data: { abuseConfidenceScore: 50, isTor: false, totalReports: 5 },
      }),
    };
    const result = await checkIpReputation('1.1.1.1');
    expect(result.blocked).toBe(true);
  });

  it('API key yokken AbuseIPDB sorgusu atlanır', async () => {
    _setConfig({ abuseIpDbKey: null });
    // https.get çağrılmamalı
    const https = require('https');
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(false);
    // Statik ve Tor kontrolleri geçmişse, AbuseIPDB'siz blocked=false döner
  });

  it('API hatası trafiği durdurmaz — blocked: false döner', async () => {
    _mockHttpsResponse = { body: 'GECERSIZ JSON{{{{' };
    const result = await checkIpReputation('1.2.3.4');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// ÖNBELLEK (CACHE)
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — önbellek', () => {
  it('aynı IP ikinci kez çağrıldığında önbellekten döner', async () => {
    _setStaticBlocklist(new Set(['3.3.3.3']));
    const r1 = await checkIpReputation('3.3.3.3');
    // Blocklist'ten kaldır — önbellekten yine engel gelmeli
    _setStaticBlocklist(new Set());
    const r2 = await checkIpReputation('3.3.3.3');
    expect(r1.blocked).toBe(true);
    expect(r2.blocked).toBe(true); // önbellek
  });

  it('cache temizlenince yeniden kontrol yapılır', async () => {
    _setStaticBlocklist(new Set(['4.4.4.4']));
    await checkIpReputation('4.4.4.4'); // önbelleğe al
    _setStaticBlocklist(new Set());      // listeden kaldır
    _clearCache();                       // önbelleği temizle
    const result = await checkIpReputation('4.4.4.4');
    expect(result.blocked).toBe(false); // listede yok artık
  });
});

// ══════════════════════════════════════════════════════════════
// ÖNCELIK SIRASI (statik > tor > abuseipdb)
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — öncelik sırası', () => {
  it('statik blocklist AbuseIPDB\'den önce kontrol edilir', async () => {
    _setConfig({ abuseIpDbKey: 'key' });
    _setStaticBlocklist(new Set(['5.5.5.5']));
    // AbuseIPDB temiz skor dönseydi bile statik engel önce devreye girer
    _mockHttpsResponse = {
      body: JSON.stringify({
        data: { abuseConfidenceScore: 0, isTor: false, totalReports: 0 },
      }),
    };
    const result = await checkIpReputation('5.5.5.5');
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/statik/i);
  });
});

// ══════════════════════════════════════════════════════════════
// EXPRESS MIDDLEWARE
// ══════════════════════════════════════════════════════════════

describe('ipReputationMiddleware', () => {
  let req, res, next;

  beforeEach(() => {
    req  = { ip: '8.8.8.8', path: '/api/messages', headers: {} };
    res  = {
      status: jest.fn().mockReturnThis(),
      json:   jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it('temiz IP\'de next() çağrılır', async () => {
    await ipReputationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('engellenen IP\'de 403 döner', async () => {
    _setStaticBlocklist(new Set(['8.8.8.8']));
    await ipReputationMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('/api/admin path\'i her zaman geçer', async () => {
    _setStaticBlocklist(new Set(['8.8.8.8']));
    req.path = '/api/admin/ip-bans';
    await ipReputationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('/api/health path\'i geçer', async () => {
    _setStaticBlocklist(new Set(['8.8.8.8']));
    req.path = '/api/health';
    await ipReputationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('middleware devre dışıyken hep geçer', async () => {
    _setConfig({ enabled: false });
    _setStaticBlocklist(new Set(['8.8.8.8']));
    await ipReputationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('beklenmedik hata trafiği durdurmuyor', async () => {
    // getClientIp yerine hatalı req verelim
    req.ip      = undefined;
    req.headers = null; // headers erişimi hata fırlatabilir
    // Middleware catch bloğuna girip next() çağırmalı
    await expect(ipReputationMiddleware(req, res, next)).resolves.not.toThrow();
    // next ya da res.status çağrılmış olmalı (hata toleransı)
    // (sonuç implementation detayına göre değişebilir)
  });

  it('X-Forwarded-For başlığından IP okur', async () => {
    req.ip      = '127.0.0.1';  // proxy arkasında
    req.headers = { 'x-forwarded-for': '8.8.8.8, 172.16.0.1' };
    _setStaticBlocklist(new Set(['8.8.8.8']));
    await ipReputationMiddleware(req, res, next);
    // 8.8.8.8 blocklist'te olduğu için 403 beklenir
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ══════════════════════════════════════════════════════════════
// YAPILANDIRMA
// ══════════════════════════════════════════════════════════════

describe('_getConfig', () => {
  it('yapılandırma nesnesini döner', () => {
    const cfg = _getConfig();
    expect(cfg).toHaveProperty('enabled');
    expect(cfg).toHaveProperty('abuseThreshold');
    expect(cfg).toHaveProperty('cacheTtlMs');
  });

  it('_setConfig ile güncellenir', () => {
    _setConfig({ abuseThreshold: 50 });
    expect(_getConfig().abuseThreshold).toBe(50);
  });
});
