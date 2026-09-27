import type { Request, Response, NextFunction } from 'express';

describe('IP reputation behavior', () => {
  const originalEnv = { ...process.env };
  let mod: typeof import('../middleware/ipReputation');

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, IP_REPUTATION_ENABLED: 'true' };
    delete process.env.ABUSEIPDB_KEY;
    delete process.env.IP_BLOCKLIST_PATH;
    delete process.env.BLOCK_TOR;
    mod = require('../middleware/ipReputation');
    mod._clearCache();
    mod._setStaticBlocklist(new Set());
    mod._setTorExitNodes(new Set());
    mod._setConfig({ enabled: true, abuseIpDbKey: null, blockTor: false, cacheTtlMs: 60_000 });
  });

  afterAll(() => { process.env = originalEnv; });

  test('validates exact IPv4 and CIDR boundaries without accepting malformed networks', () => {
    expect(mod._ipInCidr('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(mod._ipInCidr('203.0.113.8', '203.0.113.7')).toBe(false);
    expect(mod._ipInCidr('10.2.3.4', '10.0.0.0/8')).toBe(true);
    expect(mod._ipInCidr('11.2.3.4', '10.0.0.0/8')).toBe(false);
    expect(mod._ipInCidr('198.51.100.7', '0.0.0.0/0')).toBe(true);
    expect(mod._ipInCidr('203.0.113.7', '203.0.113.0/33')).toBe(false);
    expect(mod._ipInCidr('203.0.113.7', '203.0.113.0/-1')).toBe(false);
    expect(mod._ipInCidr('::1', '203.0.113.0/24')).toBe(false);
    expect(mod._ipInCidr('203.0.113.7', 'bad/24')).toBe(false);
    expect(mod._ipInCidr('203.0.113.7', 'too/many/parts')).toBe(false);
  });

  test('recognizes non-public IPv4/IPv6/mapped inputs without misclassifying public addresses', () => {
    for (const ip of ['', 'unknown', 'bad-ip', '127.0.0.1', '169.254.1.2', '100.64.1.2', '::1', 'fc00::1', 'fd00::1', 'fe80::1', '::ffff:10.4.5.6', '10.4.5.6', '172.16.0.1', '172.31.255.1', '192.168.1.1']) {
      expect(mod._isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ['172.15.0.1', '172.32.0.1', '203.0.113.1', '8.8.8.8', '2001:4860:4860::8888']) {
      expect(mod._isPrivateIp(ip)).toBe(false);
    }
  });

  test('disabled/private inputs bypass reputation services and public static/Tor entries are blocked', async () => {
    mod._setConfig({ enabled: false });
    await expect(mod.checkIpReputation('203.0.113.2')).resolves.toEqual({ blocked: false });
    mod._setConfig({ enabled: true });
    await expect(mod.checkIpReputation('10.0.0.2')).resolves.toEqual({ blocked: false });
    await expect(mod.checkIpReputation('unknown')).resolves.toEqual({ blocked: false });

    mod._setStaticBlocklist(new Set(['203.0.113.0/24']));
    await expect(mod.checkIpReputation('203.0.113.22')).resolves.toEqual(expect.objectContaining({
      blocked: true, reason: 'Statik IP engel listesinde',
    }));

    mod._clearCache();
    mod._setStaticBlocklist(new Set());
    mod._setConfig({ blockTor: true });
    mod._setTorExitNodes(new Set(['198.51.100.8']));
    await expect(mod.checkIpReputation('198.51.100.8')).resolves.toEqual(expect.objectContaining({
      blocked: true, reason: 'Tor çıkış düğümü',
    }));
  });

  test('cache is authoritative for its TTL and supports explicit admin/test updates', async () => {
    mod._setCacheEntry('203.0.113.9', { blocked: true, reason: 'cached', score: 99 });
    await expect(mod.checkIpReputation('203.0.113.9')).resolves.toEqual(expect.objectContaining({
      blocked: true, reason: 'cached', score: 99,
    }));
    expect(mod._getConfig()).toEqual(expect.objectContaining({ enabled: true, cacheTtlMs: 60_000 }));
  });

  function response() {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    return { value: { status } as unknown as Response, status, json };
  }

  test('middleware bypasses operational/admin endpoints and rejects a cached blocked client', async () => {
    for (const path of ['/api/admin/audit', '/api/health/ready', '/api/docs/openapi']) {
      const next = jest.fn() as NextFunction;
      const res = response();
      await mod.ipReputationMiddleware({ path, ip: '203.0.113.7' } as unknown as Request, res.value, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }

    mod._setCacheEntry('203.0.113.7', { blocked: true, reason: 'abuse', score: 100 });
    const next = jest.fn() as NextFunction;
    const res = response();
    await mod.ipReputationMiddleware({ path: '/api/messages', ip: '203.0.113.7' } as unknown as Request, res.value, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reason: 'abuse' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('middleware allows a clean public address and honors runtime disable', async () => {
    const next = jest.fn() as NextFunction;
    const res = response();
    await mod.ipReputationMiddleware({ path: '/api/messages', ip: '203.0.113.33' } as unknown as Request, res.value, next);
    expect(next).toHaveBeenCalledTimes(1);

    mod._setConfig({ enabled: false });
    const disabledNext = jest.fn() as NextFunction;
    await mod.ipReputationMiddleware({ path: '/api/messages', ip: '203.0.113.44' } as unknown as Request, res.value, disabledNext);
    expect(disabledNext).toHaveBeenCalledTimes(1);
  });
});

describe('IP reputation middleware failure isolation', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { jest.resetModules(); jest.dontMock('../middleware/ipBan'); process.env = originalEnv; });

  test('an internal reputation exception is logged and fails closed without taking the process down', async () => {
    jest.resetModules();
    process.env = { ...originalEnv, IP_REPUTATION_ENABLED: 'true' };
    const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: logger }));
    jest.doMock('../middleware/ipBan', () => ({ getClientIp: () => { throw new Error('resolver failed'); } }));
    const isolated = require('../middleware/ipReputation') as typeof import('../middleware/ipReputation');
    const next = jest.fn();
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ json }) } as unknown as Response;
    await isolated.ipReputationMiddleware({ path: '/api/messages' } as Request, res, next);
    expect(logger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({ error: 'IP reputation service unavailable' });
    expect(next).not.toHaveBeenCalled();
  });
});
