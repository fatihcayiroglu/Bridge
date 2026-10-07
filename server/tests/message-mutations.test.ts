// server/tests/message-mutations.test.ts — Final21 Phase 16.
//
// lib/messageMutations.ts is the ONE owner of editing and deleting a channel message; the
// socket handlers and the HTTP routes both call it. Before it existed the HTTP copy skipped
// AutoMod (a refused word was stored through PATCH), never invalidated the first-page cache
// and never broadcast (measured with p16-http-mutation-probe, baseline 1/4).

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import { createMockDb, makeChannel, makeMessage, makeServer, makeUser } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));

const order: string[] = [];
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    invalidatePattern: jest.fn(async (prefix: string) => { order.push(`invalidate:${prefix}`); }),
    del: jest.fn(async () => undefined),
    increment: jest.fn(async () => 1),
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
  },
  isRedisAvailable: () => false,
}));

import { deleteChannelMessage, editChannelMessage } from '../lib/messageMutations';
import { RAW_TEXT_FORMAT } from '../lib/storedText';

type Emitted = { room: string; event: string; data: Record<string, unknown> };
function ioDouble() {
  const emitted: Emitted[] = [];
  const io = {
    to(room: string) {
      return { emit(event: string, data: Record<string, unknown>) { order.push(`emit:${event}`); emitted.push({ room, event, data }); } };
    },
  };
  return { io: io as never, emitted };
}

let owner: ReturnType<typeof makeUser>;
let other: ReturnType<typeof makeUser>;
let outsider: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let channel: ReturnType<typeof makeChannel>;

beforeEach(async () => {
  mockDb._reset();
  order.length = 0;
  owner = makeUser({ username: 'owner' });
  other = makeUser({ username: 'other' });
  outsider = makeUser({ username: 'outsider' });
  server = makeServer(owner._id);
  channel = makeChannel(server._id);
  for (const u of [owner, other, outsider]) await mockDb.users.insert(u);
  await mockDb.servers.insert(server);
  await mockDb.channels.insert(channel);
  for (const u of [owner, other]) await mockDb.members.insert({ userId: u._id, serverId: server._id, joinedAt: Date.now(), roles: [] });
});

describe('editChannelMessage', () => {
  it('stores the text RAW, as typed, and keeps the previous version with its own format', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'a &lt; b', contentFormat: 0 });
    await mockDb.messages.insert(msg);
    const { io } = ioDouble();

    const result = await editChannelMessage(io, { actorId: other._id, messageId: msg._id, content: 'Vec<String> & Map<K, V>' });

    expect(result.ok).toBe(true);
    const stored = await mockDb.messages.findOne({ _id: msg._id });
    expect(stored).toMatchObject({ content: 'Vec<String> & Map<K, V>', contentFormat: RAW_TEXT_FORMAT });
    expect(stored?.editHistory).toEqual([expect.objectContaining({ content: 'a &lt; b', contentFormat: 0 })]);
  });

  it('rejects a stale offline edit instead of overwriting a newer authoritative version', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, {
      content: 'original',
      createdAt: 100,
      editedAt: 200,
    });
    await mockDb.messages.insert(msg);
    const { io, emitted } = ioDouble();

    const result = await editChannelMessage(io, {
      actorId: other._id,
      messageId: msg._id,
      content: 'offline stale edit',
      clientNonce: 'offline-edit-1',
      baseVersion: 100,
    });

    expect(result).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(await mockDb.messages.findOne({ _id: msg._id })).toMatchObject({
      content: 'original',
      editedAt: 200,
    });
    expect(emitted).toEqual([]);
  });

  it('treats replay of an already-applied desired edit as success without duplicating edit history', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, {
      content: 'before',
      createdAt: 100,
    });
    await mockDb.messages.insert(msg);
    const { io, emitted } = ioDouble();

    const first = await editChannelMessage(io, {
      actorId: other._id,
      messageId: msg._id,
      content: 'desired',
      clientNonce: 'edit-replay',
      baseVersion: 100,
    });
    expect(first.ok).toBe(true);
    const once = await mockDb.messages.findOne({ _id: msg._id });
    expect(once?.editHistory).toHaveLength(1);

    // ACK/event loss: replay carries the original baseVersion. Desired state is
    // already present, so this is a confirmation-only no-op.
    const second = await editChannelMessage(io, {
      actorId: other._id,
      messageId: msg._id,
      content: 'desired',
      clientNonce: 'edit-replay',
      baseVersion: 100,
    });
    expect(second.ok).toBe(true);
    const twice = await mockDb.messages.findOne({ _id: msg._id });
    expect(twice?.editHistory).toHaveLength(1);
    expect(emitted.filter(event => event.event === 'message:edited')).toHaveLength(2);
    expect(emitted.at(-1)?.data).toMatchObject({ clientNonce: 'edit-replay' });
  });

  it('refuses an edit AutoMod blocks and leaves the accepted text untouched', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'clean' });
    await mockDb.messages.insert(msg);
    await mockDb.automodRules.insert({
      _id: 'am-1', serverId: server._id, type: 'blocked_words', enabled: true,
      config: { words: ['forbidden'], action: 'delete' }, createdBy: owner._id, createdAt: Date.now(),
    });
    const { io, emitted } = ioDouble();

    const result = await editChannelMessage(io, { actorId: other._id, messageId: msg._id, content: 'now FORBIDDEN' });

    expect(result).toMatchObject({ ok: false, code: 'AUTOMOD_BLOCKED' });
    expect(await mockDb.messages.findOne({ _id: msg._id })).toMatchObject({ content: 'clean' });
    expect(emitted.find((e) => e.event === 'message:edited')).toBeUndefined();
  });

  it('fails closed when AutoMod cannot be evaluated', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'clean' });
    await mockDb.messages.insert(msg);
    jest.spyOn(mockDb.automodRules, 'find').mockImplementationOnce(() => { throw new Error('rules down'); });
    const { io } = ioDouble();

    const result = await editChannelMessage(io, { actorId: other._id, messageId: msg._id, content: 'anything' });

    expect(result).toMatchObject({ ok: false, code: 'AUTOMOD_UNAVAILABLE' });
    expect(await mockDb.messages.findOne({ _id: msg._id })).toMatchObject({ content: 'clean' });
  });

  it('invalidates the first-page cache BEFORE announcing the edit', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'x' });
    await mockDb.messages.insert(msg);
    const { io } = ioDouble();

    await editChannelMessage(io, { actorId: other._id, messageId: msg._id, content: 'y' });

    const firstInvalidate = order.findIndex((o) => o.startsWith('invalidate:'));
    const announce = order.indexOf('emit:message:edited');
    expect(firstInvalidate).toBeGreaterThanOrEqual(0);
    expect(announce).toBeGreaterThan(firstInvalidate);
  });

  it('only the author may edit', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'mine' });
    await mockDb.messages.insert(msg);
    const { io } = ioDouble();
    expect(await editChannelMessage(io, { actorId: owner._id, messageId: msg._id, content: 'hijack' }))
      .toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await mockDb.messages.findOne({ _id: msg._id })).toMatchObject({ content: 'mine' });
  });

  it('a non-member is refused as NOT_VISIBLE', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'mine' });
    await mockDb.messages.insert(msg);
    const { io } = ioDouble();
    expect(await editChannelMessage(io, { actorId: outsider._id, messageId: msg._id, content: 'x' }))
      .toMatchObject({ ok: false, code: 'NOT_VISIBLE' });
  });

  it.each(['', '   ', 'x'.repeat(2001)])('refuses invalid content %#', async (content) => {
    const { io } = ioDouble();
    expect(await editChannelMessage(io, { actorId: other._id, messageId: 'any', content }))
      .toMatchObject({ ok: false, code: 'INVALID' });
  });
});

describe('deleteChannelMessage', () => {
  it('invalidates the first-page cache BEFORE announcing the delete', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'bye' });
    await mockDb.messages.insert(msg);
    const { io, emitted } = ioDouble();

    const result = await deleteChannelMessage(io, { actorId: other._id, messageId: msg._id });

    expect(result.ok).toBe(true);
    expect(emitted).toEqual([expect.objectContaining({ room: `channel:${channel._id}`, event: 'message:deleted' })]);
    const firstInvalidate = order.findIndex((o) => o.startsWith('invalidate:'));
    expect(order.indexOf('emit:message:deleted')).toBeGreaterThan(firstInvalidate);
    expect(firstInvalidate).toBeGreaterThanOrEqual(0);
  });

  it('treats a repeated authorized delete as desired-state success without a second cascade', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'bye' });
    await mockDb.messages.insert(msg);
    const { io, emitted } = ioDouble();

    const first = await deleteChannelMessage(io, {
      actorId: other._id,
      messageId: msg._id,
      clientNonce: 'delete-replay',
    });
    expect(first.ok).toBe(true);
    const deleted = await mockDb.messages.findOne({ _id: msg._id });
    expect(deleted?.deletedAt).toBeTruthy();

    const historyAfterFirst = structuredClone(deleted?.editHistory ?? []);
    const second = await deleteChannelMessage(io, {
      actorId: other._id,
      messageId: msg._id,
      clientNonce: 'delete-replay',
    });

    expect(second.ok).toBe(true);
    expect(await mockDb.messages.findOne({ _id: msg._id })).toMatchObject({
      deletedAt: deleted?.deletedAt,
      editHistory: historyAfterFirst,
    });
    expect(emitted.filter(event => event.event === 'message:deleted')).toHaveLength(2);
    expect(emitted.at(-1)?.data).toMatchObject({ id: msg._id, clientNonce: 'delete-replay' });
  });

  it('does not let a revoked user use repeated delete as an authorization bypass', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'bye' });
    await mockDb.messages.insert(msg);
    const { io } = ioDouble();

    expect((await deleteChannelMessage(io, {
      actorId: other._id,
      messageId: msg._id,
      clientNonce: 'delete-once',
    })).ok).toBe(true);

    await mockDb.members.remove({ userId: other._id, serverId: server._id });
    const replay = await deleteChannelMessage(io, {
      actorId: other._id,
      messageId: msg._id,
      clientNonce: 'delete-once',
    });
    expect(replay).toMatchObject({ ok: false, code: 'NOT_VISIBLE' });
  });

  it('a member without MANAGE_MESSAGES cannot delete someone else\'s message', async () => {
    const msg = makeMessage(channel._id, server._id, owner._id, { content: 'owner text' });
    await mockDb.messages.insert(msg);
    const { io, emitted } = ioDouble();

    const result = await deleteChannelMessage(io, { actorId: other._id, messageId: msg._id });

    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(emitted).toEqual([]);
    expect((await mockDb.messages.findOne({ _id: msg._id }))?.deletedAt).toBeFalsy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Final21 Phase 17 — the paths a normal edit never walks.
//
// Everything below was reachable production code with no test behind it: the moderator-facing
// AutoMod record, rows written by older versions, and a storage layer that refuses a delete.
// ════════════════════════════════════════════════════════════════════════════
describe('editChannelMessage — records and legacy rows', () => {
  async function blockedWordRuleWithLog(logChannelId: string, extra: Record<string, unknown> = {}) {
    await mockDb.automodRules.insert({
      _id: 'am-log', serverId: server._id, type: 'blocked_words', enabled: true,
      config: { words: ['forbidden'], action: 'delete', logChannelId, ...extra },
      createdBy: owner._id, createdAt: Date.now(),
    });
  }

  async function logChannel() {
    const log = makeChannel(server._id, { name: 'mod-log', type: 'text' });
    await mockDb.channels.insert(log);
    return log;
  }

  it('the moderator record names the person by their server nickname', async () => {
    const log = await logChannel();
    await blockedWordRuleWithLog(log._id);
    await mockDb.members.update({ userId: other._id, serverId: server._id }, { $set: { nickname: 'Takma Ad' } });
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'clean' });
    await mockDb.messages.insert(msg);

    const result = await editChannelMessage(ioDouble().io, { actorId: other._id, messageId: msg._id, content: 'now FORBIDDEN' });

    expect(result).toMatchObject({ ok: false, code: 'AUTOMOD_BLOCKED' });
    const record = await mockDb.messages.findOne({ channelId: log._id, autoModAlert: true });
    // A moderator has to be able to tell WHO this was, and in this server people are known by
    // their nickname. The id is there too, because nicknames change.
    expect(String(record?.content)).toContain('Takma Ad');
    expect(String(record?.content)).toContain(other._id);
    expect(String(record?.content)).toContain('düzenleme engellendi');
  });

  it('falls back to the username when the person has neither nickname nor display name', async () => {
    const log = await logChannel();
    await blockedWordRuleWithLog(log._id);
    await mockDb.users.update({ _id: other._id }, { $set: { displayName: '' } });
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'clean' });
    await mockDb.messages.insert(msg);

    await editChannelMessage(ioDouble().io, { actorId: other._id, messageId: msg._id, content: 'now FORBIDDEN' });

    const record = await mockDb.messages.findOne({ channelId: log._id, autoModAlert: true });
    expect(String(record?.content)).toContain(other.username);
  });

  it('a person whose account row cannot be read is still recorded, by id', async () => {
    const log = await logChannel();
    await blockedWordRuleWithLog(log._id);
    jest.spyOn(mockDb.users, 'findOne').mockImplementation(async () => { throw new Error('users down'); });
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'clean' });
    await mockDb.messages.insert(msg);

    const result = await editChannelMessage(ioDouble().io, { actorId: other._id, messageId: msg._id, content: 'now FORBIDDEN' });

    // The name lookup is decoration; losing it must not turn a refusal into an accepted edit.
    expect(result).toMatchObject({ ok: false, code: 'AUTOMOD_BLOCKED' });
    jest.restoreAllMocks();
    const record = await mockDb.messages.findOne({ channelId: log._id, autoModAlert: true });
    expect(String(record?.content)).toContain(other._id);
  });

  it('a timeout rule writes the timeout before refusing the edit', async () => {
    const log = await logChannel();
    await blockedWordRuleWithLog(log._id, { action: 'delete_and_timeout', timeoutMs: 120000 });
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'clean' });
    await mockDb.messages.insert(msg);

    const before = Date.now();
    const result = await editChannelMessage(ioDouble().io, { actorId: other._id, messageId: msg._id, content: 'now FORBIDDEN' });

    expect(result).toMatchObject({ ok: false, code: 'AUTOMOD_BLOCKED' });
    const member = await mockDb.members.findOne({ userId: other._id, serverId: server._id });
    expect(Number(member?.timeoutUntil)).toBeGreaterThanOrEqual(before);
  });

  it.each([
    ['a non-string body (an untyped caller)', 42],
    ['nothing at all', undefined],
    ['only whitespace', '   '],
  ])('refuses %s without touching storage', async (_label, content) => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'kept' });
    await mockDb.messages.insert(msg);
    const { io, emitted } = ioDouble();

    const result = await editChannelMessage(io, { actorId: other._id, messageId: msg._id, content: content as never });

    expect(result).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await mockDb.messages.findOne({ _id: msg._id })).toMatchObject({ content: 'kept' });
    expect(emitted).toEqual([]);
  });

  it('a row whose editHistory is not a list starts a fresh history instead of crashing', async () => {
    // Rows written by older versions (and by plugins) exist in the wild; a crash here would
    // make the message permanently uneditable.
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'first' });
    await mockDb.messages.insert({ ...msg, editHistory: 'not-a-list' as never, editedAt: undefined });
    const { io } = ioDouble();

    const result = await editChannelMessage(io, { actorId: other._id, messageId: msg._id, content: 'second' });

    expect(result.ok).toBe(true);
    const stored = await mockDb.messages.findOne({ _id: msg._id });
    expect(stored?.editHistory).toEqual([expect.objectContaining({ content: 'first' })]);
    // No editedAt yet, so the kept version is stamped with when the message was written.
    expect((stored?.editHistory as Array<{ editedAt: number }>)[0].editedAt).toBe(msg.createdAt);
  });
});

describe('deleteChannelMessage — storage refusals', () => {
  it('reports FAILED and announces nothing when the delete does not happen', async () => {
    const msg = makeMessage(channel._id, server._id, other._id, { content: 'bye' });
    await mockDb.messages.insert(msg);
    // A delete that silently "succeeds" while the row stays readable is the worst outcome: the
    // author believes it is gone. The refusal must reach the caller.
    jest.spyOn(mockDb.messages, 'update').mockRejectedValue(new Error('storage down'));
    const { io, emitted } = ioDouble();

    const result = await deleteChannelMessage(io, { actorId: other._id, messageId: msg._id });

    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(emitted).toEqual([]);
    jest.restoreAllMocks();
  });
});
