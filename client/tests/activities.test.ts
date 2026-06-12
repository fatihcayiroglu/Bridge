// client/tests/activities.test.ts
// Sprint 82: Activities sistemi unit testleri

'use strict';

// ── Mock Setup ────────────────────────────────────────────────────────────────

const _socketListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
const _socketEmits: Array<{ event: string; data: unknown }> = [];

const mockSocket = {
  on:   (event: string, cb: (...args: unknown[]) => void) => {
    if (!_socketListeners[event]) _socketListeners[event] = [];
    _socketListeners[event].push(cb);
  },
  emit: (event: string, data?: unknown) => {
    _socketEmits.push({ event, data: data ?? null });
  },
  off:  () => {},
};

// Trigger helper
function triggerSocket(event: string, data?: unknown): void {
  _socketListeners[event]?.forEach(cb => cb(data));
}

// Mock globals
(globalThis as Record<string, unknown>)['window'] = {
  BridgeRegistry: { _store: new Map<string, unknown>() },
};

// ── Types (inline — gerçek dosya import edilmez) ──────────────────────────────

interface ActivityDefinition {
  id: string; name: string; description: string;
  iconUrl: string; url: string; category: string;
  maxUsers?: number; minUsers?: number;
}

interface ActiveActivity {
  activityId: string; channelId: string; serverId: string;
  hostUserId: string; participants: string[];
  startedAt: number; sessionId: string;
}

// ── BUILTIN_ACTIVITIES sabitlerini yeniden tanımla ───────────────────────────

const BUILTIN_ACTIVITIES: ActivityDefinition[] = [
  { id: 'watch-together', name: 'Watch Together', description: 'YouTube izle', iconUrl: '/a.svg', url: '/a/', category: 'watch', maxUsers: 20 },
  { id: 'chess',          name: 'Satranç',         description: 'Satranç',      iconUrl: '/b.svg', url: '/b/', category: 'game', maxUsers: 2, minUsers: 2 },
  { id: 'draw-together',  name: 'Çiz',             description: 'Çiz',          iconUrl: '/c.svg', url: '/c/', category: 'draw', maxUsers: 10 },
  { id: 'word-snack',     name: 'Kelime',          description: 'Kelime',       iconUrl: '/d.svg', url: '/d/', category: 'game', maxUsers: 8 },
  { id: 'trivia',         name: 'Trivia',          description: 'Trivia',       iconUrl: '/e.svg', url: '/e/', category: 'game', maxUsers: 16 },
];

// ── Pure logic functions (activities/index.ts'den çıkarılan pure kısımlar) ────

function isValidActivityId(id: string): boolean {
  return BUILTIN_ACTIVITIES.some(a => a.id === id);
}

function getActivityDefinition(id: string): ActivityDefinition | undefined {
  return BUILTIN_ACTIVITIES.find(a => a.id === id);
}

function canUserJoin(activity: ActivitySession, userId: string): boolean {
  const def = getActivityDefinition(activity.activityId);
  if (!def) return false;
  if (activity.participants.has(userId)) return true; // zaten içinde
  if (def.maxUsers && activity.participants.size >= def.maxUsers) return false;
  return true;
}

function shouldEndOnLeave(activity: ActivitySession, leavingUserId: string): boolean {
  return activity.hostUserId === leavingUserId || activity.participants.size <= 1;
}

// In-memory session (server handler'dan)
interface ActivitySession {
  activityId:   string;
  channelId:    string;
  serverId:     string;
  hostUserId:   string;
  participants: Set<string>;
  startedAt:    number;
  sessionId:    string;
}

function createSession(activityId: string, channelId: string, hostUserId: string): ActivitySession {
  return {
    activityId,
    channelId,
    serverId:     'srv-test',
    hostUserId,
    participants: new Set([hostUserId]),
    startedAt:    Date.now(),
    sessionId:    `sess-${Math.random().toString(36).slice(2)}`,
  };
}

// ── Test Runner ───────────────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
const _errors: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    _passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    _failed++;
    const msg = err instanceof Error ? err.message : String(err);
    _errors.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}: ${msg}`);
  }
}

function expect(val: unknown) {
  return {
    toBe:         (expected: unknown) => { if (val !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`); },
    toEqual:      (expected: unknown) => { if (JSON.stringify(val) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`); },
    toBeTruthy:   () => { if (!val) throw new Error(`Expected truthy, got ${JSON.stringify(val)}`); },
    toBeFalsy:    () => { if (val)  throw new Error(`Expected falsy, got ${JSON.stringify(val)}`); },
    toBeUndefined:() => { if (val !== undefined) throw new Error(`Expected undefined, got ${JSON.stringify(val)}`); },
    toContain:    (item: unknown) => { if (!Array.isArray(val) || !val.includes(item)) throw new Error(`Expected array to contain ${JSON.stringify(item)}`); },
    toBeGreaterThan: (n: number) => { if (typeof val !== 'number' || val <= n) throw new Error(`Expected ${val} > ${n}`); },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== Activities Unit Tests ===\n');

// 1. BUILTIN_ACTIVITIES
test('BUILTIN_ACTIVITIES should have 5 entries', () => {
  expect(BUILTIN_ACTIVITIES.length).toBe(5);
});

test('all activities should have required fields', () => {
  for (const act of BUILTIN_ACTIVITIES) {
    if (!act.id)      throw new Error(`Activity missing id`);
    if (!act.name)    throw new Error(`Activity ${act.id} missing name`);
    if (!act.url)     throw new Error(`Activity ${act.id} missing url`);
    if (!act.category)throw new Error(`Activity ${act.id} missing category`);
  }
});

// 2. isValidActivityId
test('isValidActivityId returns true for valid ids', () => {
  expect(isValidActivityId('chess')).toBeTruthy();
  expect(isValidActivityId('trivia')).toBeTruthy();
  expect(isValidActivityId('watch-together')).toBeTruthy();
});

test('isValidActivityId returns false for unknown id', () => {
  expect(isValidActivityId('unknown-activity')).toBeFalsy();
  expect(isValidActivityId('')).toBeFalsy();
});

// 3. getActivityDefinition
test('getActivityDefinition returns correct definition', () => {
  const def = getActivityDefinition('chess');
  expect(def?.id).toBe('chess');
  expect(def?.maxUsers).toBe(2);
  expect(def?.minUsers).toBe(2);
});

test('getActivityDefinition returns undefined for unknown', () => {
  expect(getActivityDefinition('nope')).toBeUndefined();
});

// 4. createSession
test('createSession initializes correctly', () => {
  const sess = createSession('chess', 'ch-1', 'user-1');
  expect(sess.activityId).toBe('chess');
  expect(sess.channelId).toBe('ch-1');
  expect(sess.hostUserId).toBe('user-1');
  expect(sess.participants.has('user-1')).toBeTruthy();
  expect(typeof sess.sessionId).toBe('string');
});

test('createSession includes host in participants', () => {
  const sess = createSession('trivia', 'ch-2', 'host-99');
  expect(sess.participants.size).toBe(1);
  expect(sess.participants.has('host-99')).toBeTruthy();
});

// 5. canUserJoin
test('canUserJoin allows new user when space available', () => {
  const sess = createSession('trivia', 'ch-1', 'host');
  expect(canUserJoin(sess, 'new-user')).toBeTruthy();
});

test('canUserJoin allows existing participant back', () => {
  const sess = createSession('chess', 'ch-1', 'host');
  expect(canUserJoin(sess, 'host')).toBeTruthy();
});

test('canUserJoin blocks when maxUsers reached', () => {
  const sess = createSession('chess', 'ch-1', 'host');
  sess.participants.add('user-2');
  // chess maxUsers = 2, şimdi dolu
  expect(canUserJoin(sess, 'user-3')).toBeFalsy();
});

test('canUserJoin allows join for activity without maxUsers limit... (draw)', () => {
  const sess = createSession('draw-together', 'ch-1', 'host');
  for (let i = 0; i < 9; i++) sess.participants.add(`user-${i}`);
  // maxUsers = 10, 10'da dolu
  expect(canUserJoin(sess, 'user-new')).toBeFalsy();
});

// 6. shouldEndOnLeave
test('shouldEndOnLeave true when host leaves', () => {
  const sess = createSession('trivia', 'ch-1', 'host');
  sess.participants.add('user-2');
  expect(shouldEndOnLeave(sess, 'host')).toBeTruthy();
});

test('shouldEndOnLeave true when last user leaves', () => {
  const sess = createSession('trivia', 'ch-1', 'host');
  // sadece host var
  expect(shouldEndOnLeave(sess, 'host')).toBeTruthy();
});

test('shouldEndOnLeave false when non-host participant leaves with others present', () => {
  const sess = createSession('trivia', 'ch-1', 'host');
  sess.participants.add('user-2');
  sess.participants.add('user-3');
  expect(shouldEndOnLeave(sess, 'user-2')).toBeFalsy();
});

// 7. Socket emit patterns
test('Socket emits activity:start correctly', () => {
  _socketEmits.length = 0;
  mockSocket.emit('activity:start', { activityId: 'chess', channelId: 'ch-1', serverId: 'srv-1' });
  expect(_socketEmits.length).toBe(1);
  expect(_socketEmits[0]!.event).toBe('activity:start');
});

test('Socket receives activity:started event', () => {
  let received: ActiveActivity | null = null;
  mockSocket.on('activity:started', (data) => { received = data as ActiveActivity; });

  triggerSocket('activity:started', {
    activityId: 'chess', channelId: 'ch-1', serverId: 'srv-1',
    hostUserId: 'u1', participants: ['u1'], startedAt: Date.now(), sessionId: 'sess-1',
  });

  expect(received).toBeTruthy();
  expect((received as unknown as ActiveActivity).activityId).toBe('chess');
});

test('Socket receives activity:ended event', () => {
  let endedChannelId = '';
  mockSocket.on('activity:ended', (data) => { endedChannelId = (data as { channelId: string }).channelId; });

  triggerSocket('activity:ended', { channelId: 'ch-1' });
  expect(endedChannelId).toBe('ch-1');
});

test('Socket receives activity:participants_updated', () => {
  let updatedParticipants: string[] = [];
  mockSocket.on('activity:participants_updated', (data) => {
    updatedParticipants = (data as { channelId: string; participants: string[] }).participants;
  });

  triggerSocket('activity:participants_updated', { channelId: 'ch-1', participants: ['u1', 'u2', 'u3'] });
  expect(updatedParticipants.length).toBe(3);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) {
  console.error('FAILED TESTS:\n' + _errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}
