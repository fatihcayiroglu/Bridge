// server/tests/jobs-autoModeration.test.js
// autoModeration job — unit tests (timer-free, DB mocked)
process.env.NODE_ENV = 'test';

const { createMockDb, makeUser, makeServer, makeChannel, makeMessage } = require('./helpers/mockDb');

let db;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

// Mock repositories that autoModeration.js imports via named destructuring
jest.mock('../db/repositories', () => {
  const { createMockDb } = require('./helpers/mockDb');
  const _db = createMockDb();

  return {
    Channels: {
      findWhere: (q) => _db.channels.find(q),
      insert:    (doc) => _db.channels.insert(doc),
    },
    Servers: {
      findById:  (id) => _db.servers.findOne({ _id: id }),
    },
    Messages: {
      findWhere: (q) => _db.messages.find(q),
      create:    (doc) => _db.messages.insert(doc),
    },
    Users: {
      findById:  (id) => _db.users.findOne({ _id: id }),
    },
    _db, // expose for seeding
  };
});

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../lib/aiProvider', () => ({
  AI_ENABLED: false,
  callAI: jest.fn(),
}));

jest.mock('../lib/modRules', () => ({
  rulesMod: jest.fn(),
}));

const repos    = require('../db/repositories');
const { rulesMod }            = require('../lib/modRules');
const { runScan, startAutoModerationJob } = require('../jobs/autoModeration');

const { v4: uuidv4 } = require('uuid');

// ── helpers ──────────────────────────────────────────────────────
function seedServer(overrides = {}) {
  return repos._db.servers.insert({ _id: uuidv4(), name: 'S', ownerId: 'owner', autoModerate: true, ...overrides });
}
function seedUser(overrides = {}) {
  return repos._db.users.insert({ _id: uuidv4(), username: 'u', displayName: 'User', ...overrides });
}
function seedMsg(serverId, overrides = {}) {
  return repos._db.messages.insert({
    _id: uuidv4(), serverId, channelId: 'ch1', userId: 'u1',
    username: 'u', displayName: 'User', content: 'hello',
    type: 'normal', reactions: {}, pinned: false,
    createdAt: Date.now(),
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe('runScan — no messages', () => {
  beforeEach(() => repos._db._reset());

  it('returns silently when no recent messages exist', async () => {
    await expect(runScan()).resolves.toBeUndefined();
  });
});

describe('runScan — autoModerate disabled', () => {
  beforeEach(() => repos._db._reset());

  it('skips servers without autoModerate flag', async () => {
    const server = await seedServer({ autoModerate: false });
    await seedMsg(server._id);
    rulesMod.mockReturnValue({ safe: false, score: 90, reason: 'bad', categories: {} });

    await runScan();

    // No mod alerts should be created
    const alerts = await repos._db.messages.find({ autoModAlert: true });
    expect(alerts).toHaveLength(0);
  });
});

describe('runScan — safe messages', () => {
  beforeEach(() => repos._db._reset());

  it('ignores messages with safe=true and score < 70', async () => {
    const server = await seedServer();
    await seedMsg(server._id);
    rulesMod.mockReturnValue({ safe: true, score: 10, reason: '', categories: {} });

    await runScan();

    const alerts = await repos._db.messages.find({ autoModAlert: true });
    expect(alerts).toHaveLength(0);
  });
});

describe('runScan — flagged messages', () => {
  beforeEach(() => repos._db._reset());

  it('creates a mod-alert message for a flagged message', async () => {
    const server = await seedServer();
    const user   = await seedUser();
    await seedMsg(server._id, { userId: user._id });
    rulesMod.mockReturnValue({ safe: false, score: 85, reason: 'toxic', categories: { toxic: true } });

    await runScan();

    const alerts = await repos._db.messages.find({ autoModAlert: true });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].userId).toBe('system');
    expect(alerts[0].username).toBe('AutoMod');
    expect(alerts[0].content).toContain('85');
  });

  it('auto-creates mod-log channel when none exists', async () => {
    const server = await seedServer();
    await seedMsg(server._id);
    rulesMod.mockReturnValue({ safe: false, score: 90, reason: 'spam', categories: { spam: true } });

    await runScan();

    const modCh = await repos._db.channels.findOne({ name: 'mod-log' });
    expect(modCh).not.toBeNull();
    expect(modCh.serverId).toBe(server._id);
  });

  it('reuses existing mod-log channel', async () => {
    const server = await seedServer();
    const chId = uuidv4();
    await repos._db.channels.insert({ _id: chId, serverId: server._id, name: 'mod-log', type: 'text', order: 0 });
    await seedMsg(server._id);
    await seedMsg(server._id, { content: 'another bad msg', createdAt: Date.now() });
    rulesMod.mockReturnValue({ safe: false, score: 80, reason: 'bad', categories: {} });

    await runScan();

    // Should NOT have created a duplicate channel
    const channels = await repos._db.channels.find({ serverId: server._id, name: 'mod-log' });
    expect(channels).toHaveLength(1);
  });

  it('skips system messages (type=system) to avoid feedback loops', async () => {
    const server = await seedServer();
    await seedMsg(server._id, { type: 'system' });
    rulesMod.mockReturnValue({ safe: false, score: 95, reason: 'bad', categories: {} });

    await runScan();

    // rulesMod should not be called for system messages
    expect(rulesMod).not.toHaveBeenCalled();
  });

  it('skips messages that are already mod-alerts', async () => {
    const server = await seedServer();
    await seedMsg(server._id, { autoModAlert: true });
    rulesMod.mockReturnValue({ safe: false, score: 95, reason: 'bad', categories: {} });

    await runScan();

    expect(rulesMod).not.toHaveBeenCalled();
  });

  it('skips messages without a serverId (DMs)', async () => {
    const server = await seedServer();
    await seedMsg(server._id, { serverId: undefined });
    rulesMod.mockReturnValue({ safe: false, score: 95, reason: 'bad', categories: {} });

    await runScan();

    const alerts = await repos._db.messages.find({ autoModAlert: true });
    expect(alerts).toHaveLength(0);
  });
});

describe('runScan — alert content', () => {
  beforeEach(() => repos._db._reset());

  it('alert message contains username, score, reason, and message ID', async () => {
    const server = await seedServer();
    const user   = await seedUser({ username: 'badguy', displayName: 'Bad Guy' });
    const msg    = await seedMsg(server._id, { userId: user._id, content: 'toxic content here' });
    rulesMod.mockReturnValue({ safe: false, score: 75, reason: 'offensive language', categories: { toxic: true } });

    await runScan();

    const alert = await repos._db.messages.findOne({ autoModAlert: true });
    expect(alert.content).toContain('Bad Guy');
    expect(alert.content).toContain('75');
    expect(alert.content).toContain('offensive language');
    expect(alert.content).toContain(msg._id);
  });
});

describe('startAutoModerationJob', () => {
  it('does not throw when called with null io', () => {
    jest.useFakeTimers();
    expect(() => startAutoModerationJob(null)).not.toThrow();
    jest.useRealTimers();
  });
});
