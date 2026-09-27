// server/tests/jobs-eventReminders.test.ts
// Sprint 96 — Event Reminder Job unit tests
process.env.NODE_ENV = 'test';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCacheStore: Record<string, string> = {};
let mockRedisAvailable = true;

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => mockRedisAvailable,
  cache: {
    get: jest.fn(async (key: string) => mockCacheStore[key] ?? null),
    set: jest.fn(async (key: string, val: string) => { mockCacheStore[key] = val; }),
    setIfAbsentAuthoritative: jest.fn(async (key: string, val: string) => {
      if (mockCacheStore[key] !== undefined) return false;
      mockCacheStore[key] = val;
      return true;
    }),
    del: jest.fn(async (key: string) => { delete mockCacheStore[key]; }),
    delAuthoritative: jest.fn(async (key: string) => { delete mockCacheStore[key]; }),
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    increment:         jest.fn().mockResolvedValue(1),
  },
}));

const mockSendPushToUser = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/pushSender', () => ({
  sendPushToUser: (...args: unknown[]) => mockSendPushToUser(...args),
}));


const mockMembers = {
  // Urun sozlesmesi: uyelik YOKSA `null` doner. Ikiz bunu tasimazsa
  // `mockResolvedValue(null)` tipe uymaz ve 'uye degil' dali OLCULEMEZ.
  findOne: jest.fn<Promise<{ userId: string; serverId: string } | null>, [userId: string, serverId: string]>(
    async (userId, serverId) => ({ userId, serverId }),
  ),
};
jest.mock('../db/repositories', () => ({
  Members: mockMembers,
}));

const mockResolvePermissions = jest.fn(async (..._args: unknown[]) => 1 << 0);
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1 << 0, ADMINISTRATOR: 1 << 30 },
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
  hasPermission: (perms: number, flag: number) => (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
}));

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  },
}));

// ── DB mock — simulates server_events + server_event_rsvp ────────────────────
// NOT: ServerEventRepository artık ../db/postgres/index.js üzerinden db.query
// değil, doğrudan ../db/postgres/pool üzerinden pool.query kullanıyor.
// Mock doğru katmanı (pool) hedeflemeli; aksi hâlde testler kendi mock'larını
// test eder, gerçek implementasyonu değil.

interface EventRow   { id: string; server_id: string; title: string; starts_at: Date; channel_id: string | null; }
interface RsvpRow    { user_id: string; }

const _events: EventRow[]  = [];
const _rsvps:  { event_id: string; user_id: string; status: string }[] = [];

// `params` ISTEGE BAGLIdir: urun `query(sql)` de cagirabiliyor.
const mockPoolQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (sql.includes('FROM server_events')) {
    const [from, to] = params as [string, string];
    const rows = _events.filter(e => {
      const ts = e.starts_at.getTime();
      return ts >= new Date(from).getTime() && ts <= new Date(to).getTime();
    });
    return { rows };
  }
  if (sql.includes('FROM server_event_rsvp')) {
    const [eventId] = params as [string];
    const rows: RsvpRow[] = _rsvps
      .filter(r => r.event_id === eventId && ['going', 'interested'].includes(r.status))
      .map(r => ({ user_id: r.user_id }));
    return { rows };
  }
  return { rows: [] };
});

jest.mock('../db/postgres/pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => mockPoolQuery(sql, params) },
  default: { query: (sql: string, params?: unknown[]) => mockPoolQuery(sql, params) },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(minutesFromNow: number, id = 'evt-1'): EventRow {
  return {
    id,
    server_id:  'srv-1',
    title:      'Test Etkinliği',
    starts_at:  new Date(Date.now() + minutesFromNow * 60_000),
    channel_id: 'ch-1',
  };
}

function seedEvent(ev: EventRow) { _events.push(ev); }
function seedRsvp(eventId: string, userId: string, status = 'going') {
  _rsvps.push({ event_id: eventId, user_id: userId, status });
}

function resetAll() {
  _events.length = 0;
  _rsvps.length  = 0;
  Object.keys(mockCacheStore).forEach(k => delete mockCacheStore[k]);
  mockPoolQuery.mockClear();
  jest.clearAllMocks();
  mockMembers.findOne.mockImplementation(async (userId: string, serverId: string) => ({ userId, serverId }));
  mockResolvePermissions.mockResolvedValue(1 << 0);
  mockSendPushToUser.mockResolvedValue(undefined);
  mockRedisAvailable = true;
  delete process.env.REDIS_URL;
}

// ── Import after mocks ────────────────────────────────────────────────────────

import { sendEventReminders, startEventReminderJob, stopEventReminderJob } from '../jobs/eventReminders';
import { ServerEvents } from '../db/repositories/ServerEventRepository';
import { cache } from '../lib/redisAdapter';
import { sendPushToUser } from '../lib/pushSender';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('startEventReminderJob', () => {
  beforeEach(() => {
    stopEventReminderJob();
    resetAll();
  });
  afterEach(() => {
    stopEventReminderJob();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('starts without throwing', () => {
    jest.useFakeTimers();
    expect(() => startEventReminderJob()).not.toThrow();
  });

  it('does not schedule duplicate startup timers', () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    startEventReminderJob();
    startEventReminderJob();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('sends push to going/interested users for 5-min window', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-a', 'going');
    seedRsvp('evt-1', 'user-b', 'interested');

    await sendEventReminders(); // initial 15s delay + tick

    expect(mockSendPushToUser).toHaveBeenCalledTimes(2);
    const [uid, payload] = mockSendPushToUser.mock.calls[0];
    expect(['user-a', 'user-b']).toContain(uid);
    expect(payload.title).toContain('Test Etkinliği');
    expect(payload.body).toContain('5 dakika');
    expect(payload.data?.type).toBe('event:reminder');

  });

  it('sends push for 15-min window', async () => {
    seedEvent(makeEvent(15));
    seedRsvp('evt-1', 'user-c', 'going');

    await sendEventReminders();

    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser.mock.calls[0][1].body).toContain('15 dakika');

  });

  it('does NOT send to not_going users', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-d', 'not_going');

    await sendEventReminders();

    expect(mockSendPushToUser).not.toHaveBeenCalled();

  });

  it('does NOT send duplicate within TTL window (atomic per-user claim)', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-e', 'going');

    await sendEventReminders();
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);

    // Second tick (1 min later) — Redis flag still set, should not resend
    await sendEventReminders();
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1); // still 1

  });

  it('claims each recipient atomically with a 300s TTL', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-f', 'going');

    await sendEventReminders();

    const claimCalls = (cache.setIfAbsentAuthoritative as jest.Mock).mock.calls;
    const claim = claimCalls.find(([k]: [string]) => k === 'evtremind:evt-1:5:user-f');
    expect(claim).toBeDefined();
    expect(claim[2]).toBe(300); // TTL must be 5 minutes
  });

  it('releases only the failed recipient claim so retry does not duplicate successful pushes', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-ok', 'going');
    seedRsvp('evt-1', 'user-retry', 'going');

    mockSendPushToUser.mockImplementation(async (userId: string) => {
      if (userId === 'user-retry' && mockSendPushToUser.mock.calls.filter(([u]) => u === 'user-retry').length === 1) {
        throw new Error('temporary push outage');
      }
    });

    await sendEventReminders();
    await sendEventReminders();

    const okCalls = mockSendPushToUser.mock.calls.filter(([u]) => u === 'user-ok');
    const retryCalls = mockSendPushToUser.mock.calls.filter(([u]) => u === 'user-retry');
    expect(okCalls).toHaveLength(1);
    expect(retryCalls).toHaveLength(2);
    expect(cache.delAuthoritative).toHaveBeenCalledWith('evtremind:evt-1:5:user-retry');
  });


  it('fails closed when idempotency claim throws', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-claim-error', 'going');
    (cache.setIfAbsentAuthoritative as jest.Mock).mockRejectedValueOnce(new Error('cache unavailable'));

    await sendEventReminders();

    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it('fails closed in configured cluster mode when Redis is unavailable', async () => {
    process.env.REDIS_URL = 'redis://cluster.example:6379';
    mockRedisAvailable = false;
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-cluster', 'going');

    await sendEventReminders();

    expect(cache.setIfAbsentAuthoritative).not.toHaveBeenCalled();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it('skips events with no RSVP rows without calling sendPushToUser', async () => {
    seedEvent(makeEvent(5));
    // no rsvp

    await sendEventReminders();

    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it('skips a recipient who is no longer a server member', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'removed-user', 'going');
    mockMembers.findOne.mockResolvedValue(null);

    await sendEventReminders();

    expect(mockSendPushToUser).not.toHaveBeenCalled();
    expect(cache.setIfAbsentAuthoritative).not.toHaveBeenCalled();
  });

  it('skips a channel-bound reminder after VIEW_CHANNELS is revoked', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'revoked-user', 'going');
    mockResolvePermissions.mockResolvedValue(0);

    await sendEventReminders();

    expect(mockSendPushToUser).not.toHaveBeenCalled();
    expect(cache.setIfAbsentAuthoritative).not.toHaveBeenCalled();
  });

  it('keeps server-wide event reminders available to current members', async () => {
    seedEvent({ ...makeEvent(5), channel_id: null });
    seedRsvp('evt-1', 'member-user', 'going');
    mockResolvePermissions.mockResolvedValue(0);

    await sendEventReminders();

    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
  });

  it('continues processing other events if push throws', async () => {
    jest.spyOn(ServerEvents, 'findScheduledInWindow').mockResolvedValueOnce([
      { id: 'evt-fail', server_id: 'srv-1', title: 'Test Etkinliği', starts_at: new Date(), channel_id: 'ch-1' },
      { id: 'evt-ok', server_id: 'srv-1', title: 'Test Etkinliği', starts_at: new Date(), channel_id: 'ch-1' },
    ] as never).mockResolvedValueOnce([] as never);
    jest.spyOn(ServerEvents, 'findAttendees').mockImplementation(async (eventId: string) => [
      { user_id: eventId === 'evt-fail' ? 'user-bad' : 'user-good' },
    ]);

    mockSendPushToUser
      .mockRejectedValueOnce(new Error('push failed'))
      .mockResolvedValueOnce(undefined);

    await sendEventReminders();

    expect(mockSendPushToUser).toHaveBeenCalledTimes(2);
  });
});
