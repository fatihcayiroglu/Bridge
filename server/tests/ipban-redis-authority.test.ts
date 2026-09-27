process.env.NODE_ENV = 'test';
const originalRedisUrl = process.env.REDIS_URL;
process.env.REDIS_URL = 'redis://configured-authority.invalid:6379';

const mockStore = new Map<string, string>();
let mockRedisAvailable = true;
const mockRedisClient = {
  set: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); return 'OK'; }),
  setEx: jest.fn(async (key: string, _ttl: number, value: string) => { mockStore.set(key, value); return 'OK'; }),
  get: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  del: jest.fn(async (key: string) => { const existed = mockStore.delete(key); return existed ? 1 : 0; }),
  keys: jest.fn(async (pattern: string) => {
    const prefix = pattern.replace(/\*$/, '');
    return [...mockStore.keys()].filter(key => key.startsWith(prefix));
  }),
  mGet: jest.fn(async (keys: string[]) => keys.map(key => mockStore.get(key) ?? null)),
};
const mockAuthoritativeCommand = jest.fn(async (
  _operation: string,
  command: (client: unknown) => Promise<unknown>,
) => {
  if (!mockRedisAvailable) throw new Error('Redis authoritative command unavailable');
  return command(mockRedisClient);
});

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => mockRedisAvailable,
  redisClient: () => mockRedisClient,
  redisAuthoritativeCommand: (...args: unknown[]) => mockAuthoritativeCommand(...args as [string, (client: unknown) => Promise<unknown>]),
}));

const ipBan = require('../middleware/ipBan') as typeof import('../middleware/ipBan');

function responseMock() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('IP-ban configured Redis authority', () => {
  beforeEach(() => {
    mockStore.clear();
    mockRedisAvailable = true;
    mockAuthoritativeCommand.mockClear();
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it('routes configured ban writes and reads through the bounded authoritative command owner', async () => {
    await ipBan.banIp('198.51.100.80', { reason: 'authority-test' });
    await expect(ipBan.getBan('198.51.100.80')).resolves.toMatchObject({ reason: 'authority-test' });

    expect(mockAuthoritativeCommand).toHaveBeenCalledWith(
      'ip-ban write', expect.any(Function),
    );
    expect(mockAuthoritativeCommand).toHaveBeenCalledWith(
      'ip-ban read', expect.any(Function),
    );
  });

  it('fails closed when configured authority becomes unavailable instead of consulting process-local state', async () => {
    mockRedisAvailable = false;
    await expect(ipBan.getBan('198.51.100.81')).rejects.toThrow(/coordination unavailable/);

    const req = { path: '/api/messages', headers: {}, socket: { remoteAddress: '198.51.100.81' } } as any;
    const res = responseMock();
    const next = jest.fn();
    await ipBan.ipBanMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
