// server/tests/bot-interaction-reply.test.ts
//
// The one bot action (Final21 Phase 14): answering a slash command a user invoked.
// Every refusal branch is exercised; the live probe tools/bot-lifecycle-probe.mjs
// proves the same flow against a real server.

process.env.NODE_ENV = 'test';

const mockBots = { findServerBot: jest.fn(), findByIdAndServer: jest.fn(), updateByIdAndServer: jest.fn() };
const mockMessages = { findById: jest.fn(), create: jest.fn() };
const mockChannels = { findById: jest.fn() };
const mockResolvePermissions = jest.fn();
const mockAutomod = { findByServer: jest.fn() };
const mockIncrement = jest.fn();
const mockInvalidate = jest.fn();
const mockWriteAutomodLogs = jest.fn();

jest.mock('../db/repositories', () => ({ Bots: mockBots, Messages: mockMessages, Channels: mockChannels, ChannelWebhooks: {}, Automod: mockAutomod }));
jest.mock('../lib/redisAdapter', () => {
  const actual = jest.requireActual('../lib/redisAdapter');
  return { ...actual, cache: { ...actual.cache, increment: (...args: unknown[]) => mockIncrement(...args) } };
});
jest.mock('../lib/messageCache', () => ({ invalidateChannelMessages: (...args: unknown[]) => mockInvalidate(...args) }));
jest.mock('../lib/automodRuntime', () => ({ writeAutomodLogs: (...args: unknown[]) => mockWriteAutomodLogs(...args) }));
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args) };
});
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'owner-1' }; next(); },
}));
jest.mock('../middleware/botAuth', () => ({
  botAuthMiddleware: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bot valid') return void res.status(401).json({ error: 'Invalid or inactive bot token' });
    req.bot = HOME_BOT;
    next();
  },
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { bots: () => (_req: any, _res: any, next: any) => next() } }));
jest.mock('uuid', () => ({ v4: () => 'reply-1' }));

import express from 'express';
import request from 'supertest';
import { PERMS } from '../lib/permissions';
import { INTERACTION_REPLY_LIMIT, INTERACTION_REPLY_WINDOW_MS, replyToInvocation, type ReplyingBot } from '../lib/botInteractionReply';
import botsRouter from '../routes/bots';

const NOW = 1_800_000_000_000;
const HOME = 'home-server';
const OTHER = 'other-server';
const HOME_BOT: ReplyingBot = { _id: 'bot-1', serverId: HOME, username: 'Helper', slashCommands: [{ name: 'ping' }] };

const invocation = (over: Record<string, unknown> = {}) => ({
  _id: 'inv-1', channelId: 'ch-1', serverId: HOME, userId: 'user-9', displayName: 'Invoker',
  content: '/ping hello', createdAt: NOW - 1_000, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockMessages.findById.mockResolvedValue(invocation());
  mockMessages.create.mockImplementation(async (row: Record<string, unknown>) => row);
  mockChannels.findById.mockImplementation(async (id: string) => ({ _id: id, serverId: invocation().serverId }));
  mockBots.findServerBot.mockResolvedValue(null);
  mockResolvePermissions.mockResolvedValue(PERMS.USE_BOT_COMMANDS);
  mockAutomod.findByServer.mockResolvedValue([]);
  mockIncrement.mockResolvedValue(1);
  mockInvalidate.mockResolvedValue(undefined);
  mockWriteAutomodLogs.mockResolvedValue(undefined);
});

const blockedWordRule = (config: Record<string, unknown> = {}) => ({
  _id: 'rule-1', serverId: HOME, type: 'blocked_words', enabled: true,
  config: { words: ['forbidden'], action: 'delete', timeoutMs: 60_000, logChannelId: null, exemptRoles: [], ...config },
});

describe('replyToInvocation — canonical send guarantees that apply to a bot', () => {
  // tools/p14-reply-gaps-probe.mjs reproduced all three against a live server first.
  it('invalidates the channel history cache after storing, so a reload shows the reply', async () => {
    await replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW);
    expect(mockInvalidate).toHaveBeenCalledWith('ch-1');
    expect(mockInvalidate.mock.invocationCallOrder[0]).toBeGreaterThan(mockMessages.create.mock.invocationCallOrder[0]!);
  });

  it('refuses a reply AutoMod blocks, logs it, and stores nothing', async () => {
    mockAutomod.findByServer.mockResolvedValue([blockedWordRule({ logChannelId: 'mod-log' })]);
    const io = { to: jest.fn() } as never;
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'this is forbidden', NOW, io))
      .resolves.toEqual({ ok: false, status: 403, error: 'automod_blocked' });
    expect(mockAutomod.findByServer).toHaveBeenCalledWith(HOME);
    expect(mockWriteAutomodLogs).toHaveBeenCalledWith(
      expect.objectContaining({ matched: true, logChannelIds: ['mod-log'] }),
      expect.objectContaining({ serverId: HOME, channelId: 'ch-1', userId: 'bot:bot-1', displayName: 'Helper' }),
      io,
    );
    expect(mockMessages.create).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
    // Refused attempts do not use up the invocation's replies.
    expect(mockIncrement).not.toHaveBeenCalledWith(expect.stringMatching(/^bot-interaction-replies:/), expect.anything());

    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'all clear', NOW, io)).resolves.toMatchObject({ ok: true });
  });

  it('role exemptions cannot apply to a bot, and a timeout-only rule still refuses the reply', async () => {
    mockAutomod.findByServer.mockResolvedValue([blockedWordRule({ exemptRoles: ['role-mods'], action: 'timeout' })]);
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'forbidden', NOW))
      .resolves.toEqual({ ok: false, status: 403, error: 'automod_blocked' });
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it('fails closed when AutoMod rules cannot be read', async () => {
    mockAutomod.findByServer.mockRejectedValue(new Error('automod store down'));
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).rejects.toThrow('automod store down');
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it(`allows at most ${INTERACTION_REPLY_LIMIT} replies per invocation, counted per bot and invocation`, async () => {
    mockIncrement.mockResolvedValueOnce(INTERACTION_REPLY_LIMIT);
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'last allowed', NOW)).resolves.toMatchObject({ ok: true });
    expect(mockIncrement).toHaveBeenCalledWith('bot-interaction-replies:bot-1:inv-1', INTERACTION_REPLY_WINDOW_MS / 1000);

    mockMessages.create.mockClear();
    mockIncrement.mockResolvedValueOnce(INTERACTION_REPLY_LIMIT + 1);
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'one too many', NOW))
      .resolves.toEqual({ ok: false, status: 429, error: 'reply_limit' });
    expect(mockMessages.create).not.toHaveBeenCalled();
  });
});

describe('replyToInvocation — allowed', () => {
  it('stores a reply in the invocation channel as the bot, linked to the invocation', async () => {
    const result = await replyToInvocation(HOME_BOT, 'inv-1', '  pong <b>ok</b> ', NOW);
    expect(result.ok).toBe(true);
    expect(mockMessages.create).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'reply-1', channelId: 'ch-1', serverId: HOME, userId: 'bot:bot-1', botId: 'bot-1',
      username: 'Helper', displayName: 'Helper', createdAt: NOW,
      // Final21 Phase 16: a reply snapshot copies the referenced row, so it carries that
      // row's storage format (0 = legacy sanitized text).
      replyTo: { _id: 'inv-1', displayName: 'Invoker', content: '/ping hello', contentFormat: 0 },
    }));
    expect(mockResolvePermissions).toHaveBeenCalledWith('user-9', HOME, 'ch-1');
  });

  it('accepts the BIGINT timestamp PostgreSQL returns as a string', async () => {
    // Found by tools/bot-lifecycle-probe.mjs against a real server: every fresh
    // invocation was refused as expired because createdAt arrived as "1789…".
    mockMessages.findById.mockResolvedValue(invocation({ createdAt: String(NOW - 1_000) }));
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).resolves.toMatchObject({ ok: true });
    mockMessages.findById.mockResolvedValue(invocation({ createdAt: 'not-a-time' }));
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).resolves.toEqual({ ok: false, status: 403, error: 'interaction_expired' });
  });

  it('replies in another server only when the install granted messages:reply', async () => {
    mockMessages.findById.mockResolvedValue(invocation({ serverId: OTHER }));
    mockChannels.findById.mockResolvedValue({ _id: 'ch-1', serverId: OTHER });
    mockBots.findServerBot.mockResolvedValue({ botId: 'bot-1', serverId: OTHER, grantedScopes: ['commands', 'messages:reply'] });
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).resolves.toMatchObject({ ok: true });
    expect(mockBots.findServerBot).toHaveBeenCalledWith('bot-1', OTHER);
  });
});

describe('replyToInvocation — denied', () => {
  it.each([
    ['empty content', '   ', 400, 'content required'],
    ['non-string content', { text: 'x' }, 400, 'content required'],
    ['content over 2000 characters', 'x'.repeat(2001), 400, 'content too long'],
  ])('%s', async (_label, content, status, error) => {
    await expect(replyToInvocation(HOME_BOT, 'inv-1', content, NOW)).resolves.toEqual({ ok: false, status, error });
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing invocation', null, 404, 'Invocation not found'],
    ['a deleted invocation', invocation({ deletedAt: NOW - 10 }), 404, 'Invocation not found'],
    ['a plain chat message', invocation({ content: 'just chatting' }), 403, 'not_invoked'],
    ['another bot\'s command', invocation({ content: '/weather istanbul' }), 403, 'not_invoked'],
    ['an invocation older than the reply window', invocation({ createdAt: NOW - INTERACTION_REPLY_WINDOW_MS - 1 }), 403, 'interaction_expired'],
  ])('refuses %s', async (_label, row, status, error) => {
    mockMessages.findById.mockResolvedValue(row);
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).resolves.toEqual({ ok: false, status, error });
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it('refuses a server where the bot is not installed (e.g. after uninstall)', async () => {
    mockMessages.findById.mockResolvedValue(invocation({ serverId: OTHER }));
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).resolves.toEqual({ ok: false, status: 403, error: 'not_installed' });
  });

  it.each([
    ['base scope only', ['commands']],
    ['an unreadable grant', '{broken'],
  ])('refuses an install granted %s', async (_label, grantedScopes) => {
    mockMessages.findById.mockResolvedValue(invocation({ serverId: OTHER }));
    mockBots.findServerBot.mockResolvedValue({ botId: 'bot-1', serverId: OTHER, grantedScopes });
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).resolves.toEqual({ ok: false, status: 403, error: 'scope_required' });
  });

  it('refuses when the invoker could not invoke bots there (never delivered)', async () => {
    mockResolvePermissions.mockResolvedValue(PERMS.SEND_MESSAGES);
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).resolves.toEqual({ ok: false, status: 403, error: 'not_invoked' });
    mockResolvePermissions.mockRejectedValue(new Error('permission store down'));
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).resolves.toEqual({ ok: false, status: 403, error: 'not_invoked' });
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it('refuses when the channel no longer belongs to the server', async () => {
    mockChannels.findById.mockResolvedValue({ _id: 'ch-1', serverId: 'moved' });
    await expect(replyToInvocation(HOME_BOT, 'inv-1', 'pong', NOW)).resolves.toEqual({ ok: false, status: 404, error: 'Channel not found' });
  });
});

describe('routes', () => {
  const emitted: Array<{ room: string; event: string; data: any }> = [];
  const app = express();
  app.use(express.json());
  app.set('io', { to: (room: string) => ({ emit: (event: string, data: unknown) => emitted.push({ room, event, data }) }) });
  app.use('/api/bots', botsRouter);
  app.use('/api/servers', botsRouter);

  beforeEach(() => { emitted.length = 0; });

  it('POST /interactions/:id/reply needs a bot token', async () => {
    const res = await request(app).post('/api/bots/interactions/inv-1/reply').send({ content: 'pong' });
    expect(res.status).toBe(401);
    expect(mockMessages.create).not.toHaveBeenCalled();
  });

  it('POST /interactions/:id/reply stores and broadcasts the reply to the channel', async () => {
    const res = await request(app).post('/api/bots/interactions/inv-1/reply').set('Authorization', 'Bot valid').send({ content: 'pong' });
    expect(res.status).toBe(200);
    // The reply reaches the open channel AND the people watching the server for unread state
    // (channel:activity carries no content — Final21 Phase 15).
    expect(emitted).toEqual([
      { room: 'channel:ch-1', event: 'message:new', data: expect.objectContaining({ botId: 'bot-1', content: 'pong' }) },
      { room: 'watch:ch-1', event: 'channel:activity', data: expect.objectContaining({ messageId: 'reply-1', channelId: 'ch-1' }) },
    ]);
    expect(emitted[1]!.data).not.toHaveProperty('content');
  });

  it('POST /interactions/:id/reply maps the reply limit to 429', async () => {
    mockIncrement.mockResolvedValueOnce(INTERACTION_REPLY_LIMIT + 1);
    const res = await request(app).post('/api/bots/interactions/inv-1/reply').set('Authorization', 'Bot valid').send({ content: 'pong' });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'reply_limit' });
    expect(emitted).toEqual([]);
  });

  it('POST /interactions/:id/reply maps refusals and broadcasts nothing', async () => {
    mockMessages.findById.mockResolvedValue(invocation({ content: 'hello' }));
    const res = await request(app).post('/api/bots/interactions/inv-1/reply').set('Authorization', 'Bot valid').send({ content: 'pong' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not_invoked' });
    expect(emitted).toEqual([]);
  });

  describe('PATCH /:serverId/bots/:botId — owner publishing', () => {
    it('requires a boolean', async () => {
      const res = await request(app).patch(`/api/servers/${HOME}/bots/bot-1`).send({ isPublic: 'yes' });
      expect(res.status).toBe(400);
      expect(mockBots.updateByIdAndServer).not.toHaveBeenCalled();
    });

    it('requires MANAGE_SERVER on the bot\'s server', async () => {
      mockResolvePermissions.mockResolvedValue(PERMS.SEND_MESSAGES);
      const res = await request(app).patch(`/api/servers/${HOME}/bots/bot-1`).send({ isPublic: true });
      expect(res.status).toBe(403);
      expect(mockBots.updateByIdAndServer).not.toHaveBeenCalled();
    });

    it('does not reach a bot of another server', async () => {
      mockResolvePermissions.mockResolvedValue(PERMS.MANAGE_SERVER);
      mockBots.findByIdAndServer.mockResolvedValue(null);
      const res = await request(app).patch(`/api/servers/${HOME}/bots/foreign-bot`).send({ isPublic: true });
      expect(res.status).toBe(404);
      expect(mockBots.findByIdAndServer).toHaveBeenCalledWith('foreign-bot', HOME);
      expect(mockBots.updateByIdAndServer).not.toHaveBeenCalled();
    });

    it('publishes and never returns the token hash', async () => {
      mockResolvePermissions.mockResolvedValue(PERMS.MANAGE_SERVER);
      mockBots.findByIdAndServer
        .mockResolvedValueOnce({ _id: 'bot-1', serverId: HOME, username: 'Helper', tokenHash: 'secret', isPublic: false })
        .mockResolvedValueOnce({ _id: 'bot-1', serverId: HOME, username: 'Helper', tokenHash: 'secret', isPublic: true });
      const res = await request(app).patch(`/api/servers/${HOME}/bots/bot-1`).send({ isPublic: true });
      expect(res.status).toBe(200);
      expect(mockBots.updateByIdAndServer).toHaveBeenCalledWith('bot-1', HOME, { isPublic: true });
      expect(res.body).toMatchObject({ _id: 'bot-1', isPublic: true, name: 'Helper' });
      expect(res.body.tokenHash).toBeUndefined();
    });
  });
});
