'use strict';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = process.env.REFRESH_SECRET || 'test-refresh-secret-long-enough-32!!';

type RedisFake = {
  status: string;
  store: Map<string,string>;
  ttl: Map<string,number>;
  set: jest.Mock;
  setEx: jest.Mock;
  expire: jest.Mock;
  get: jest.Mock;
  del: jest.Mock;
  keys: jest.Mock;
  mget: jest.Mock;
};

function fakeRedis(): RedisFake {
  const store = new Map<string,string>();
  const ttl = new Map<string,number>();
  return {
    status: 'ready', store, ttl,
    set: jest.fn(async (k:string,v:string) => { store.set(k,v); return 'OK'; }),
    setEx: jest.fn(async (k:string,s:number,v:string) => { store.set(k,v); ttl.set(k,s); return 'OK'; }),
    expire: jest.fn(async (k:string,s:number) => { ttl.set(k,s); return 1; }),
    get: jest.fn(async (k:string) => store.get(k) ?? null),
    del: jest.fn(async (k:string) => { const had=store.delete(k); ttl.delete(k); return had?1:0; }),
    keys: jest.fn(async (pattern:string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys()].filter(k => k.startsWith(prefix));
    }),
    mget: jest.fn(async (...keys:string[]) => keys.map(k => store.get(k) ?? null)),
  };
}

async function fresh(redis?: RedisFake) {
  jest.resetModules();
  const g = global as typeof globalThis & { _bridgeRedis?: RedisFake };
  delete g._bridgeRedis;
  if (redis) g._bridgeRedis = redis;
  return await import('../middleware/ipBan');
}

function resMock() {
  const res:any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function reqFor(path:string, ip='203.0.113.7') {
  return { path, headers: {}, socket: { remoteAddress: ip } } as any;
}

describe('ipBan production behavior', () => {
  afterEach(() => { jest.restoreAllMocks(); delete (global as any)._bridgeRedis; });

  it('configured Redis outage refuses process-local ban state instead of creating split-brain enforcement', async () => {
    process.env.REDIS_URL = 'redis://configured-but-not-connected:6379';
    try {
      const m = await fresh();
      await expect(m.banIp('203.0.113.9')).rejects.toThrow(/coordination unavailable/);
      await expect(m.getBan('203.0.113.9')).rejects.toThrow(/coordination unavailable/);
    } finally {
      delete process.env.REDIS_URL;
    }
  });

  it('rejects empty/unknown IP instead of creating unusable bans', async () => {
    const m = await fresh();
    await expect(m.banIp('')).rejects.toThrow('Geçersiz IP');
    await expect(m.banIp('unknown')).rejects.toThrow('Geçersiz IP');
  });

  it('in-memory permanent ban round-trips, lists and unbans', async () => {
    const m = await fresh();
    const entry = await m.banIp('203.0.113.1', { reason: 'abuse', adminId: 'admin-1' });
    expect(entry).toMatchObject({ ip:'203.0.113.1', reason:'abuse', adminId:'admin-1', expiresAt:null });
    expect(await m.getBan('203.0.113.1')).toMatchObject({ reason:'abuse' });
    expect(await m.listBans()).toHaveLength(1);
    await m.unbanIp('203.0.113.1');
    expect(await m.getBan('203.0.113.1')).toBeNull();
  });

  it('in-memory timed ban expires and is physically pruned from list/get', async () => {
    const now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const m = await fresh();
    await m.banIp('203.0.113.2', { durationMs: 1000 });
    expect((await m.getBan('203.0.113.2'))?.expiresAt).toBe(now + 1000);
    jest.spyOn(Date, 'now').mockReturnValue(now + 1001);
    expect(await m.getBan('203.0.113.2')).toBeNull();
    expect(await m.listBans()).toEqual([]);
  });

  it('Redis timed/permanent writes use atomic setEx vs set and support unban', async () => {
    const r = fakeRedis();
    const m = await fresh(r);
    await m.banIp('198.51.100.1', { durationMs: 1501, reason:'temp' });
    expect(r.setEx).toHaveBeenCalledWith('bridge:ipban:198.51.100.1', 2, expect.any(String));
    await m.banIp('198.51.100.2', { reason:'perm' });
    expect(r.set).toHaveBeenCalledWith('bridge:ipban:198.51.100.2', expect.any(String));
    expect(await m.listBans()).toHaveLength(2);
    await m.unbanIp('198.51.100.2');
    expect(r.del).toHaveBeenCalledWith('bridge:ipban:198.51.100.2');
  });

  it('Redis expired record is fail-closed-cleaned and null records are ignored in listing', async () => {
    const now = 2_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const r = fakeRedis();
    const expired = { ip:'198.51.100.3', reason:'x', bannedAt:now-2000, expiresAt:now-1, adminId:null };
    r.store.set('bridge:ipban:198.51.100.3', JSON.stringify(expired));
    const m = await fresh(r);
    expect(await m.getBan('198.51.100.3')).toBeNull();
    expect(r.del).toHaveBeenCalledWith('bridge:ipban:198.51.100.3');

    r.store.set('bridge:ipban:198.51.100.4', JSON.stringify({ ...expired, ip:'198.51.100.4', expiresAt:null }));
    r.keys.mockResolvedValueOnce(['bridge:ipban:198.51.100.4','bridge:ipban:missing']);
    r.mget.mockResolvedValueOnce([r.store.get('bridge:ipban:198.51.100.4')!, null]);
    expect(await m.listBans()).toEqual([expect.objectContaining({ ip:'198.51.100.4' })]);
  });

  it.each(['/api/admin/ip-bans','/api/health/ready','/api/docs'])('middleware bypasses %s', async (path) => {
    const m = await fresh();
    await m.banIp('203.0.113.7');
    const next=jest.fn(), res=resMock();
    await m.ipBanMiddleware(reqFor(path),res,next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('middleware emits 403 with remaining seconds for timed ban', async () => {
    const now = 10_000;
    jest.spyOn(Date,'now').mockReturnValue(now);
    const m = await fresh();
    await m.banIp('203.0.113.7', { durationMs: 2500, reason:'burst' });
    const next=jest.fn(), res=resMock();
    await m.ipBanMiddleware(reqFor('/api/messages'),res,next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reason:'burst', remainingSeconds:3 }));
  });

  it('middleware omits remainingSeconds for permanent ban', async () => {
    const m = await fresh();
    await m.banIp('203.0.113.7', { reason:'perm' });
    const res=resMock();
    await m.ipBanMiddleware(reqFor('/api/messages'),res,jest.fn());
    const body = res.json.mock.calls[0][0];
    expect(body.remainingSeconds).toBeUndefined();
  });

  it('middleware fails closed on corrupted Redis state instead of bypassing a ban decision', async () => {
    const r=fakeRedis();
    r.store.set('bridge:ipban:203.0.113.7','{not-json');
    const m=await fresh(r);
    const next=jest.fn(), res=resMock();
    await m.ipBanMiddleware(reqFor('/api/messages'),res,next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('configured Redis outage makes middleware return 503 rather than allow the request', async () => {
    process.env.REDIS_URL = 'redis://configured-but-not-connected:6379';
    try {
      const m = await fresh();
      const next=jest.fn(), res=resMock();
      await m.ipBanMiddleware(reqFor('/api/messages'),res,next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    } finally { delete process.env.REDIS_URL; }
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
