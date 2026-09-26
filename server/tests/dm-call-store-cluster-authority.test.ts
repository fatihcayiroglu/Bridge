// server/tests/dm-call-store-cluster-authority.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// dm-call-store — KUME MODUNDA ARAMA DURUMU ASLA TAHMIN EDILMEZ
// ════════════════════════════════════════════════════════════════════════════
// `dm-call-store.test.ts` TEK DUGUM yedeğini olcer (Redis yapilandirilmamis).
// Bu dosya `REDIS_URL` TANIMLI hâli olcer — yani cok dugumlu kurulum.
//
// Ayrim guvenlik acisindan onemlidir. Redis yapilandirilmisSA arama durumunun
// SAHIBI odur. O sirada Redis erisilemezse dogru davranis, surec-ici bir
// kopyaya duserek "arama yok" ya da "arama var" demek DEGILDIR:
//
//   · yanlis "yok"  → gecerli bir arama dusurulur,
//   · yanlis "var"  → baska bir dugumdeki aramaya yetkisiz katilim yolu acilir.
//
// Ikisi de kabul edilemez, bu yuzden modul HATA FIRLATIR (fail-closed) ve
// cagiran katman kullaniciya durustce "su an yapilamiyor" der.
process.env.NODE_ENV = 'test';

const previousRedisUrl = process.env.REDIS_URL;
process.env.REDIS_URL = 'redis://dm-cluster.test:6379';

// Ikizler `cache` API'sinin GERCEK imzalariyla tiplenir; boylece cagri
// kaydi (`mock.calls[0]`) de dogru tiplenir ve `as [...]` donusumune
// gerek kalmaz. (Ayni gerekce: chess-store-cluster-authority.test.ts)
type LockOptions = { leaseSeconds?: number; waitMs?: number; retryMs?: number };

const isRedisAvailable = jest.fn<boolean, []>(() => true);
const getAuthoritative = jest.fn<Promise<unknown>, [key: string]>(async () => null);
const setAuthoritative = jest.fn<Promise<void>, [key: string, value: unknown, ttlSeconds?: number]>(async () => undefined);
const delAuthoritative = jest.fn<Promise<void>, [key: string]>(async () => undefined);
const withKeyLock = jest.fn<Promise<unknown>, [key: string, fn: () => Promise<unknown>, options?: LockOptions]>(
  async (_key, fn) => fn(),
);

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => isRedisAvailable(),
  cache: {
    getAuthoritative: (key: string) => getAuthoritative(key),
    setAuthoritative: (key: string, value: unknown, ttlSeconds?: number) => setAuthoritative(key, value, ttlSeconds),
    delAuthoritative: (key: string) => delAuthoritative(key),
    withKeyLock: (key: string, fn: () => Promise<unknown>, options?: LockOptions) => withKeyLock(key, fn, options),
  },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { present } from './helpers/narrow';
import { dmCallStore } from '../socket/handlers/dm-call-store';

const call = (id = 'c1', extra: Record<string, unknown> = {}) => ({
  callId: id, callerId: 'u1', calleeId: 'u2',
  type: 'voice' as const, startedAt: 1_000, status: 'ringing' as const, ...extra,
});

beforeEach(() => {
  dmCallStore._localCalls_TEST_ONLY.clear();
  isRedisAvailable.mockReset(); isRedisAvailable.mockReturnValue(true);
  getAuthoritative.mockReset(); getAuthoritative.mockResolvedValue(null);
  setAuthoritative.mockReset(); setAuthoritative.mockResolvedValue(undefined);
  delAuthoritative.mockReset(); delAuthoritative.mockResolvedValue(undefined);
  withKeyLock.mockReset();
  withKeyLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());
});

afterAll(() => {
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe('with Redis reachable the shared store is authoritative', () => {
  it('reads through the authoritative key', async () => {
    getAuthoritative.mockResolvedValue(call());
    await expect(dmCallStore.get('c1')).resolves.toEqual(call());
    expect(getAuthoritative).toHaveBeenCalledWith('dm:call:c1');
  });

  it('reports no call when the key is absent', async () => {
    getAuthoritative.mockResolvedValue(null);
    await expect(dmCallStore.get('c1')).resolves.toBeNull();
  });

  it('writes with a bounded lifetime so a crashed node cannot orphan metadata', async () => {
    await dmCallStore.set(call());
    const [key, value, ttl] = setAuthoritative.mock.calls[0];
    expect(key).toBe('dm:call:c1');
    expect(value).toEqual(call());
    // TTL normal bir gorusmeyi KESMEYECEK kadar uzun olmalidir.
    expect(ttl).toBe(24 * 60 * 60);
    // Paylasilan yazma basarili oldu: surec-ici kopya TUTULMAZ.
    expect(dmCallStore._localCalls_TEST_ONLY.size).toBe(0);
  });

  it('deletes through the authoritative key', async () => {
    await dmCallStore.del('c1');
    expect(delAuthoritative).toHaveBeenCalledWith('dm:call:c1');
  });

  it('refuses to trust a persisted row whose participants collapsed', async () => {
    // Arayan ve aranan AYNI kisi olamaz; boyle bir satir kurcalanmistir.
    getAuthoritative.mockResolvedValue(call('c1', { calleeId: 'u1' }));
    await expect(dmCallStore.get('c1')).rejects.toThrow(/Invalid persisted DM call/);
  });

  it.each([
    ['a foreign call id', { callId: 'baska' }],
    ['an unknown media type', { type: 'hologram' }],
    ['an unknown status', { status: 'belki' }],
    ['a fractional start time', { startedAt: 1.5 }],
    ['a negative start time', { startedAt: -1 }],
  ])('refuses a persisted row with %s', async (_label, extra) => {
    getAuthoritative.mockResolvedValue(call('c1', extra));
    await expect(dmCallStore.get('c1')).rejects.toThrow(/Invalid persisted DM call/);
  });

  it('refuses to write a call that does not describe itself', async () => {
    await expect(dmCallStore.set(call('c1', { callerId: '' })))
      .rejects.toThrow(/Invalid persisted DM call/);
    expect(setAuthoritative).not.toHaveBeenCalled();
  });
});

describe('with Redis configured but unreachable every operation fails closed', () => {
  beforeEach(() => { isRedisAvailable.mockReturnValue(false); });

  it.each([
    ['get', () => dmCallStore.get('c1')],
    ['set', () => dmCallStore.set(call())],
    ['delete', () => dmCallStore.del('c1')],
  ])('%s refuses to guess from process-local state', async (operation, run) => {
    // Surec-ici bir kopyaya dusmek, ya gecerli bir aramayi dusurur ya da
    // baska dugumdeki aramaya yetkisiz katilim yolu acardi.
    await expect(run()).rejects.toThrow(
      new RegExp(`Redis DM-call coordination unavailable during ${operation}`));
  });

  it('never leaves a process-local copy behind after a refused write', async () => {
    await expect(dmCallStore.set(call())).rejects.toThrow();
    expect(dmCallStore._localCalls_TEST_ONLY.size).toBe(0);
  });
});

describe('a Redis error during an operation is propagated, not swallowed', () => {
  it.each([
    ['read', () => { getAuthoritative.mockRejectedValue(new Error('redis down')); return dmCallStore.get('c1'); }],
    ['write', () => { setAuthoritative.mockRejectedValue(new Error('redis down')); return dmCallStore.set(call()); }],
    ['delete', () => { delAuthoritative.mockRejectedValue(new Error('redis down')); return dmCallStore.del('c1'); }],
  ])('propagates a failed %s', async (_label, run) => {
    await expect(run()).rejects.toThrow('redis down');
  });
});

describe('identifier bounds are enforced before any coordination', () => {
  it.each([
    ['an empty id', ''],
    ['an over-long id', 'x'.repeat(129)],
  ])('treats %s as no call at all on read and delete', async (_label, id) => {
    await expect(dmCallStore.get(id)).resolves.toBeNull();
    await expect(dmCallStore.del(id)).resolves.toBeUndefined();
    expect(getAuthoritative).not.toHaveBeenCalled();
    expect(delAuthoritative).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty id', ''],
    ['an over-long id', 'x'.repeat(129)],
  ])('refuses to take a lock for %s', async (_label, id) => {
    await expect(dmCallStore.withLock(id, async () => 'ok')).rejects.toThrow(/Invalid DM call id/);
    expect(withKeyLock).not.toHaveBeenCalled();
  });

  it('runs the guarded section under a per-call lock', async () => {
    await expect(dmCallStore.withLock('c1', async () => 'bitti')).resolves.toBe('bitti');
    const [key, , rawOptions] = withKeyLock.mock.calls[0];
    // `options` istege bagli parametredir; urunun onu GECMESI iddianin parcasi.
    const options = present(rawOptions, 'kilit secenekleri');
    expect(key).toBe('dm-call:c1');
    // Kilit SINIRLIDIR: coken bir dugum aramayi sonsuza dek kilitleyemez.
    expect(options.leaseSeconds).toBeGreaterThan(0);
    expect(options.waitMs).toBeGreaterThan(0);
  });
});
