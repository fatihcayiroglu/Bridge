'use strict';

const originalRedisUrl = process.env.REDIS_URL;

type Queue = { current: any; queue: any[] };

function loadMusic(options: { initial?: Queue | null; outage?: boolean } = {}) {
  jest.resetModules();
  process.env.REDIS_URL = 'redis://cluster.test:6379';

  let shared: Queue | null = options.initial ?? null;
  const tails = new Map<string, Promise<void>>();
  const getAuthoritative = jest.fn(async () => {
    if (options.outage) throw new Error('redis down');
    return shared;
  });
  const setAuthoritative = jest.fn(async (_key: string, value: Queue) => {
    if (options.outage) throw new Error('redis down');
    shared = JSON.parse(JSON.stringify(value));
  });
  const delAuthoritative = jest.fn(async () => {
    if (options.outage) throw new Error('redis down');
    shared = null;
  });
  const withKeyLock = jest.fn(async (key: string, fn: () => Promise<unknown>) => {
    if (options.outage) throw new Error('coordination unavailable');
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    tails.set(key, tail);
    await previous.catch(() => undefined);
    try { return await fn(); }
    finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  });

  jest.doMock('../lib/redisAdapter', () => ({
    cache: { getAuthoritative, setAuthoritative, delAuthoritative, withKeyLock },
  }));

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const music = require('../music') as typeof import('../music');
  return {
    music,
    mocks: { getAuthoritative, setAuthoritative, delAuthoritative, withKeyLock },
    getShared: () => shared,
  };
}

afterEach(() => {
  jest.resetModules();
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe('music queue cluster authority', () => {
  it('serializes concurrent play mutations so only one request becomes current', async () => {
    const { music, getShared, mocks } = loadMusic();
    jest.spyOn(music, 'getVideoInfo')
      .mockImplementation(async (url: string) => ({ title: url.endsWith('a') ? 'A' : 'B', duration: 10, url }));

    const [first, second] = await Promise.all([
      music.handleMusicCommand('!play', ['https://youtube.com/a'], 'ch-1', null),
      music.handleMusicCommand('!play', ['https://youtube.com/b'], 'ch-1', null),
    ]);

    expect([first, second].filter(result => result && 'nowPlaying' in result)).toHaveLength(1);
    expect([first, second].filter(result => result && 'queued' in result)).toHaveLength(1);
    expect(getShared()?.current).toBeTruthy();
    expect(getShared()?.queue).toHaveLength(1);
    expect(mocks.withKeyLock).toHaveBeenCalledTimes(2);
    expect(new Set(mocks.withKeyLock.mock.calls.map(call => call[0]))).toEqual(new Set(['music-queue:ch-1']));
  });

  it('reads canonical shared state instead of the process-local compatibility queue', async () => {
    const initial = {
      current: { title: 'Shared', duration: 30, url: 'https://youtube.com/shared' },
      queue: [{ title: 'Next', duration: 31, url: 'https://youtube.com/next' }],
    };
    const { music } = loadMusic({ initial });
    music.getQueue('ch-2').current = { title: 'Wrong local', duration: 1, url: 'https://youtube.com/local' };

    await expect(music.readMusicQueue('ch-2')).resolves.toEqual(initial);
    await expect(music.handleMusicCommand('!queue', [], 'ch-2', null)).resolves.toEqual(initial);
  });

  it('deletes empty shared state after stop and never leaves a stale queue document', async () => {
    const { music, getShared, mocks } = loadMusic({
      initial: { current: { title: 'Playing', duration: 5, url: 'https://youtube.com/x' }, queue: [] },
    });

    await music.clearSharedMusicQueue('ch-3');
    expect(getShared()).toBeNull();
    expect(mocks.delAuthoritative).toHaveBeenCalledWith('music:queue:ch-3');
  });

  it('fails closed on corrupt shared state rather than silently forking a local queue', async () => {
    const { music } = loadMusic({ initial: { current: null, queue: [null] } as unknown as Queue });
    music.getQueue('ch-corrupt').current = { title: 'Local', duration: 1, url: 'https://youtube.com/local' };

    await expect(music.readMusicQueue('ch-corrupt')).rejects.toThrow(/Corrupt shared music/);
    expect(music.getQueue('ch-corrupt').current?.title).toBe('Local');
  });

  it('fails closed when configured coordination is unavailable and does not run the mutation', async () => {
    const { music, mocks } = loadMusic({ outage: true });
    const mutate = jest.fn((queue: Queue) => { queue.current = { title: 'Should not run', duration: 1, url: 'x' }; });

    await expect(music.mutateMusicQueue('ch-down', mutate)).rejects.toThrow(/coordination unavailable/);
    expect(mutate).not.toHaveBeenCalled();
    expect(mocks.setAuthoritative).not.toHaveBeenCalled();
  });

  it('rejects malformed channel ids before touching shared authority', async () => {
    const { music, mocks } = loadMusic();
    await expect(music.readMusicQueue('')).rejects.toThrow(/channelId/);
    await expect(music.mutateMusicQueue('x'.repeat(129), async () => undefined)).rejects.toThrow(/channelId/);
    expect(mocks.withKeyLock).not.toHaveBeenCalled();
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
