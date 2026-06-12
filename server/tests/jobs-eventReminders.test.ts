// server/tests/jobs-eventReminders.test.ts
// Sprint 96 — Event Reminder Job unit tests
process.env.NODE_ENV = 'test';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCacheStore: Record<string, string> = {};

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get: jest.fn(async (key: string) => mockCacheStore[key] ?? null),
    set: jest.fn(async (key: string, val: string) => { mockCacheStore[key] = val; }),
    del: jest.fn(async (key: string) => { delete mockCacheStore[key]; }),
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    increment:         jest.fn().mockResolvedValue(1),
  },
}));

const mockSendPushToUser = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/pushSender', () => ({
  sendPushToUser: (...args: unknown[]) => mockSendPushToUser(...args),
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

const mockPoolQuery = jest.fn(async (sql: string, params: unknown[]) => {
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
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
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
}

// ── Import after mocks ────────────────────────────────────────────────────────

import { startEventReminderJob } from '../jobs/eventReminders';
import { cache } from '../lib/redisAdapter';
import { sendPushToUser } from '../lib/pushSender';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('startEventReminderJob', () => {
  beforeEach(resetAll);

  it('starts without throwing', () => {
    jest.useFakeTimers();
    expect(() => startEventReminderJob()).not.toThrow();
    jest.useRealTimers();
  });

  it('sends push to going/interested users for 5-min window', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-a', 'going');
    seedRsvp('evt-1', 'user-b', 'interested');

    jest.useFakeTimers();
    startEventReminderJob();
    await jest.advanceTimersByTimeAsync(16_000); // initial 15s delay + tick

    expect(mockSendPushToUser).toHaveBeenCalledTimes(2);
    const [uid, payload] = mockSendPushToUser.mock.calls[0];
    expect(['user-a', 'user-b']).toContain(uid);
    expect(payload.title).toContain('Test Etkinliği');
    expect(payload.body).toContain('5 dakika');
    expect(payload.data?.type).toBe('event:reminder');

    jest.useRealTimers();
  });

  it('sends push for 15-min window', async () => {
    seedEvent(makeEvent(15));
    seedRsvp('evt-1', 'user-c', 'going');

    jest.useFakeTimers();
    startEventReminderJob();
    await jest.advanceTimersByTimeAsync(16_000);

    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser.mock.calls[0][1].body).toContain('15 dakika');

    jest.useRealTimers();
  });

  it('does NOT send to not_going users', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-d', 'not_going');

    jest.useFakeTimers();
    startEventReminderJob();
    await jest.advanceTimersByTimeAsync(16_000);

    expect(mockSendPushToUser).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('does NOT send duplicate within TTL window (Redis flag)', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-e', 'going');

    jest.useFakeTimers();
    startEventReminderJob();

    // First tick — sends
    await jest.advanceTimersByTimeAsync(16_000);
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);

    // Second tick (1 min later) — Redis flag still set, should not resend
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1); // still 1

    jest.useRealTimers();
  });

  it('writes Redis flag with 300s TTL after sending', async () => {
    seedEvent(makeEvent(5));
    seedRsvp('evt-1', 'user-f', 'going');

    jest.useFakeTimers();
    startEventReminderJob();
    await jest.advanceTimersByTimeAsync(16_000);

    const setCalls = (cache.set as jest.Mock).mock.calls;
    const flagCall = setCalls.find(([k]: [string]) => k.startsWith('evtremind:'));
    expect(flagCall).toBeDefined();
    expect(flagCall[2]).toBe(300); // TTL must be 5 minutes
    jest.useRealTimers();
  });

  it('skips events with no RSVP rows without calling sendPushToUser', async () => {
    seedEvent(makeEvent(5));
    // no rsvp

    jest.useFakeTimers();
    startEventReminderJob();
    await jest.advanceTimersByTimeAsync(16_000);

    expect(mockSendPushToUser).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('continues processing other events if push throws', async () => {
    seedEvent(makeEvent(5), 'evt-fail');
    seedEvent(makeEvent(5), 'evt-ok');
    seedRsvp('evt-fail', 'user-bad',  'going');
    seedRsvp('evt-ok',   'user-good', 'going');

    mockSendPushToUser
      .mockRejectedValueOnce(new Error('push failed'))
      .mockResolvedValueOnce(undefined);

    jest.useFakeTimers();
    startEventReminderJob();
    await jest.advanceTimersByTimeAsync(16_000);

    // Both were attempted; one succeeded
    expect(mockSendPushToUser).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
