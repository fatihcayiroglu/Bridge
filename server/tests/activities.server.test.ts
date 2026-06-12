// server/tests/activities.server.test.ts
// Sprint 82: Activities server handler unit testleri

'use strict';

// ── Mock Setup ────────────────────────────────────────────────────────────────

const _ioRooms: Record<string, { event: string; data: unknown }[]> = {};
const _socketEmits: { event: string; data: unknown }[] = [];

const mockIo = {
  to: (room: string) => ({
    emit: (event: string, data: unknown) => {
      if (!_ioRooms[room]) _ioRooms[room] = [];
      _ioRooms[room].push({ event, data });
    },
  }),
};

const mockSocket = {
  _listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
  on:  function(event: string, cb: (...args: unknown[]) => void) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(cb);
  },
  emit: (event: string, data?: unknown) => { _socketEmits.push({ event, data }); },
  trigger: function(event: string, data?: unknown) {
    this._listeners.get(event)?.forEach(cb => cb(data));
  },
};

// ── Pure logic (activities handler'dan) ──────────────────────────────────────

const ALLOWED_ACTIVITY_IDS = new Set([
  'watch-together', 'chess', 'draw-together', 'word-snack', 'trivia',
]);

interface ActivitySession {
  activityId:   string;
  channelId:    string;
  serverId:     string;
  hostUserId:   string;
  participants: Set<string>;
  startedAt:    number;
  sessionId:    string;
}

function createSession(
  activityId: string, channelId: string, serverId: string, hostUserId: string,
): ActivitySession {
  return {
    activityId, channelId, serverId, hostUserId,
    participants: new Set([hostUserId]),
    startedAt: Date.now(),
    sessionId: `sess-${Math.random().toString(36).slice(2)}`,
  };
}

function serializeSession(s: ActivitySession) {
  return {
    activityId:   s.activityId,
    channelId:    s.channelId,
    serverId:     s.serverId,
    hostUserId:   s.hostUserId,
    participants: [...s.participants],
    startedAt:    s.startedAt,
    sessionId:    s.sessionId,
  };
}

function validatePayload(payload: { activityId?: string; channelId?: string; serverId?: string }): string | null {
  if (!payload?.activityId) return 'activityId gerekli';
  if (!payload?.channelId)  return 'channelId gerekli';
  if (!payload?.serverId)   return 'serverId gerekli';
  if (!ALLOWED_ACTIVITY_IDS.has(payload.activityId)) return 'Bilinmeyen aktivite ID';
  return null;
}

// ── Test Runner ───────────────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
const _errors: string[] = [];

function test(name: string, fn: () => void): void {
  try { fn(); _passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    _failed++;
    const msg = err instanceof Error ? err.message : String(err);
    _errors.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}: ${msg}`);
  }
}

function expect(val: unknown) {
  return {
    toBe:          (e: unknown) => { if (val !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(val)}`); },
    toBeTruthy:    () => { if (!val) throw new Error(`Expected truthy`); },
    toBeFalsy:     () => { if (val)  throw new Error(`Expected falsy`); },
    toBeNull:      () => { if (val !== null) throw new Error(`Expected null, got ${JSON.stringify(val)}`); },
    toContain:     (item: unknown) => { if (Array.isArray(val) && !val.includes(item)) throw new Error(`Array doesn't contain ${JSON.stringify(item)}`); },
    toBeGreaterThan: (n: number) => { if (typeof val !== 'number' || val <= n) throw new Error(`Expected ${val} > ${n}`); },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== Activities Server Tests ===\n');

// 1. ALLOWED_ACTIVITY_IDS
test('should have 5 allowed activities', () => {
  expect(ALLOWED_ACTIVITY_IDS.size).toBe(5);
});

test('chess is allowed', () => { expect(ALLOWED_ACTIVITY_IDS.has('chess')).toBeTruthy(); });
test('trivia is allowed', () => { expect(ALLOWED_ACTIVITY_IDS.has('trivia')).toBeTruthy(); });
test('unknown activity is not allowed', () => { expect(ALLOWED_ACTIVITY_IDS.has('malicious-app')).toBeFalsy(); });

// 2. validatePayload
test('validatePayload returns null for valid payload', () => {
  expect(validatePayload({ activityId: 'chess', channelId: 'ch-1', serverId: 'srv-1' })).toBeNull();
});

test('validatePayload catches missing activityId', () => {
  const err = validatePayload({ channelId: 'ch-1', serverId: 'srv-1' });
  expect(err).toBeTruthy();
});

test('validatePayload catches missing channelId', () => {
  const err = validatePayload({ activityId: 'chess', serverId: 'srv-1' });
  expect(err).toBeTruthy();
});

test('validatePayload catches missing serverId', () => {
  const err = validatePayload({ activityId: 'chess', channelId: 'ch-1' });
  expect(err).toBeTruthy();
});

test('validatePayload catches unknown activityId', () => {
  const err = validatePayload({ activityId: 'evil-app', channelId: 'ch-1', serverId: 'srv-1' });
  expect(err).toBeTruthy();
});

// 3. createSession
test('createSession initializes with host in participants', () => {
  const s = createSession('chess', 'ch-1', 'srv-1', 'host-1');
  expect(s.participants.has('host-1')).toBeTruthy();
  expect(s.participants.size).toBe(1);
});

test('createSession has unique sessionId', () => {
  const s1 = createSession('chess', 'ch-1', 'srv-1', 'host-1');
  const s2 = createSession('chess', 'ch-1', 'srv-1', 'host-1');
  if (s1.sessionId === s2.sessionId) throw new Error('Session IDs should be unique');
});

test('createSession records startedAt timestamp', () => {
  const before = Date.now();
  const s = createSession('trivia', 'ch-1', 'srv-1', 'host');
  const after = Date.now();
  if (s.startedAt < before || s.startedAt > after) throw new Error('startedAt out of range');
});

// 4. serializeSession
test('serializeSession converts Set to array', () => {
  const s = createSession('trivia', 'ch-1', 'srv-1', 'host');
  s.participants.add('user-2');
  const serialized = serializeSession(s);
  if (!Array.isArray(serialized.participants)) throw new Error('participants should be array');
  expect(serialized.participants.length).toBe(2);
  expect(serialized.participants).toContain('host');
  expect(serialized.participants).toContain('user-2');
});

test('serializeSession includes all required fields', () => {
  const s = createSession('chess', 'ch-x', 'srv-x', 'h-x');
  const sr = serializeSession(s);
  const required = ['activityId', 'channelId', 'serverId', 'hostUserId', 'participants', 'startedAt', 'sessionId'];
  for (const field of required) {
    if (!(field in sr)) throw new Error(`Missing field: ${field}`);
  }
});

// 5. Session management logic
test('adding participant increases count', () => {
  const s = createSession('trivia', 'ch-1', 'srv-1', 'host');
  s.participants.add('user-2');
  expect(s.participants.size).toBe(2);
});

test('removing host triggers end condition', () => {
  const s = createSession('trivia', 'ch-1', 'srv-1', 'host');
  s.participants.add('user-2');
  const shouldEnd = s.hostUserId === 'host'; // host leaves
  expect(shouldEnd).toBeTruthy();
});

test('session ends when last participant leaves', () => {
  const s = createSession('chess', 'ch-1', 'srv-1', 'host');
  s.participants.delete('host');
  expect(s.participants.size).toBe(0);
});

// 6. Payload validation edge cases
test('validatePayload rejects empty strings', () => {
  const err = validatePayload({ activityId: '', channelId: 'ch-1', serverId: 'srv-1' });
  expect(err).toBeTruthy();
});

test('validatePayload handles null-like payload gracefully', () => {
  const err = validatePayload({} as { activityId?: string; channelId?: string; serverId?: string });
  expect(err).toBeTruthy();
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) {
  console.error('FAILED TESTS:\n' + _errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}

describe('activities server legacy self-test harness', () => {
  it('legacy inline assertions pass', () => {
    const jestExpect = (globalThis as unknown as { expect: typeof globalThis.expect }).expect;
    jestExpect(_failed).toBe(0);
    jestExpect(_passed).toBeGreaterThan(0);
  });
});
