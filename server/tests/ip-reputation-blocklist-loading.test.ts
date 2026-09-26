// server/tests/ip-reputation-blocklist-loading.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ipReputation — STATIK BLOCKLIST YUKLEME VE ONBELLEK BUDAMA
// ════════════════════════════════════════════════════════════════════════════
// Kardes paketler karar mantigini olcer. Bu dosya iki ALTYAPI davranisini
// olcer; ikisi de sessizce bozuldugunda korumayi tamamen etkisiz birakir.
//
// 1. BLOCKLIST YUKLEME. Operator bir dosya yolu verir. Dosya okunamazsa
//    (yanlis yol, izin hatasi) surec COKMEZ — ama bu, listenin BOS oldugu
//    anlamina gelir ve bunun gunluge yazilmasi sarttir. Sessiz bir bos liste,
//    "engelleme acik" sanilan ama hicbir sey engellemeyen bir dagitim demektir.
//
// 2. ONBELLEK BUDAMA. Karar onbellegi SINIRLIDIR. Sinir uygulanmazsa her yeni
//    IP bir girdi birakir ve onbellek bir bellek sizintisina donusur — ustelik
//    tam olarak saldiri altinda, yani en cok farkli IP gorulen anda.
process.env.NODE_ENV = 'test';

import fs from 'fs';
import os from 'os';
import path from 'path';

type Module = typeof import('../middleware/ipReputation');

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: logger }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-blocklist-'));

/** Verilen yapilandirmayla taze bir modul ornegi yukler. */
async function load(blocklistPath?: string): Promise<Module> {
  const previous = process.env.IP_BLOCKLIST_PATH;
  if (blocklistPath === undefined) delete process.env.IP_BLOCKLIST_PATH;
  else process.env.IP_BLOCKLIST_PATH = blocklistPath;

  let mod!: Module;
  await jest.isolateModulesAsync(async () => { mod = await import('../middleware/ipReputation'); });

  if (previous === undefined) delete process.env.IP_BLOCKLIST_PATH;
  else process.env.IP_BLOCKLIST_PATH = previous;
  return mod;
}

beforeEach(() => {
  jest.useFakeTimers();
  for (const fn of Object.values(logger)) fn.mockClear();
});

afterEach(() => { jest.useRealTimers(); jest.resetModules(); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('the static blocklist is loaded from disk', () => {
  it('reads addresses and ignores comments and blank lines', async () => {
    const file = path.join(dir, 'list.txt');
    fs.writeFileSync(file, [
      '# yorum satiri',
      '203.0.113.10',
      '   ',
      '  198.51.100.7  ',
      '',
      '# bir yorum daha',
    ].join('\n'));

    const mod = await load(file);
    await expect(mod.checkIpReputation('203.0.113.10')).resolves.toEqual(
      expect.objectContaining({ blocked: true }));
    // Bosluklar kirpilir; aksi hâlde girdi hicbir zaman eslesmezdi.
    await expect(mod.checkIpReputation('198.51.100.7')).resolves.toEqual(
      expect.objectContaining({ blocked: true }));

    mod._clearCache();
    await expect(mod.checkIpReputation('203.0.113.99')).resolves.toEqual(
      expect.objectContaining({ blocked: false }));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('2 kayıt'));
  });

  it('reports an unreadable blocklist instead of silently allowing everyone', async () => {
    const mod = await load(path.join(dir, 'boyle-bir-dosya-yok.txt'));

    // Surec COKMEZ, ama operator "engelleme acik" sanmamalidir.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Blocklist okunamadı'));
    await expect(mod.checkIpReputation('203.0.113.10')).resolves.toEqual(
      expect.objectContaining({ blocked: false }));
  });

  it('loads nothing at all when no path is configured', async () => {
    const mod = await load(undefined);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Blocklist okunamadı'));
    await expect(mod.checkIpReputation('203.0.113.10')).resolves.toEqual(
      expect.objectContaining({ blocked: false }));
  });

  it('treats an empty file as an empty list, not as a failure', async () => {
    const file = path.join(dir, 'bos.txt');
    fs.writeFileSync(file, '\n\n# yalnizca yorum\n');
    await load(file);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('0 kayıt'));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('okunamadı'));
  });
});

describe('the decision cache is bounded and self-pruning', () => {
  it('drops entries once they expire', async () => {
    const mod = await load(undefined);
    mod._clearCache();
    mod._setCacheEntry('203.0.113.5', { blocked: true, reason: 'test' });

    await expect(mod.checkIpReputation('203.0.113.5')).resolves.toEqual(
      expect.objectContaining({ blocked: true, reason: 'test' }));

    // Onbellek girdisinin omru dolar: karar YENIDEN hesaplanir.
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await expect(mod.checkIpReputation('203.0.113.5')).resolves.toEqual(
      expect.objectContaining({ blocked: false }));
  });

  it('runs the periodic prune without throwing on an empty cache', async () => {
    const mod = await load(undefined);
    mod._clearCache();
    expect(() => jest.advanceTimersByTime(5 * 60_000)).not.toThrow();
  });

  it('keeps a fresh entry across a prune cycle', async () => {
    const mod = await load(undefined);
    mod._clearCache();
    mod._setCacheEntry('203.0.113.6', { blocked: true, reason: 'taze' });

    jest.advanceTimersByTime(5 * 60_000);
    await expect(mod.checkIpReputation('203.0.113.6')).resolves.toEqual(
      expect.objectContaining({ blocked: true, reason: 'taze' }));
  });
});

describe('private and malformed addresses are never scored', () => {
  it.each([
    ['loopback IPv4', '127.0.0.1'],
    ['a private 10.x host', '10.0.0.5'],
    ['a private 192.168.x host', '192.168.1.9'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['link-local', '169.254.1.1'],
    ['IPv6 loopback', '::1'],
    ['an IPv6 unique-local address', 'fc00::1'],
  ])('treats %s as private', async (_label, ip) => {
    const mod = await load(undefined);
    expect(mod._isPrivateIp(ip)).toBe(true);
  });

  it.each([
    ['a public IPv4', '203.0.113.10'],
    ['a public IPv6', '2001:db8::1'],
  ])('treats %s as public', async (_label, ip) => {
    const mod = await load(undefined);
    // NOT: 2001:db8:: dokumantasyon aralığıdır ama OZEL aralik degildir.
    expect(mod._isPrivateIp(ip)).toBe(false);
  });

  it('rejects a malformed CIDR rather than matching everything', async () => {
    const mod = await load(undefined);
    expect(mod._ipInCidr('203.0.113.10', 'bu-cidr-degil')).toBe(false);
    expect(mod._ipInCidr('203.0.113.10', '203.0.113.0/abc')).toBe(false);
    expect(mod._ipInCidr('bu-ip-degil', '203.0.113.0/24')).toBe(false);
  });

  it('matches an address inside its CIDR and rejects one outside', async () => {
    const mod = await load(undefined);
    expect(mod._ipInCidr('203.0.113.10', '203.0.113.0/24')).toBe(true);
    expect(mod._ipInCidr('203.0.114.10', '203.0.113.0/24')).toBe(false);
  });
});
