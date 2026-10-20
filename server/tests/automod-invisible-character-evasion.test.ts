// server/tests/automod-invisible-character-evasion.test.ts
//
// AutoMod matched the raw payload, while a channel message is stored without
// C0/C1 control characters (lib/storedText.ts normalizeMessageText). A member
// could therefore split a blocked word with an invisible control character:
// `forbidden\u0001word` passed AutoMod and was stored, and shown, as
// `forbiddenword`. Measured on the socket send path before this fix: no
// refusal, stored content "say forbiddenword now". Message edits had the same
// gap.
//
// Unicode format characters (zero-width space and joiners, soft hyphen, bidi
// controls, BOM) are kept in storage but render as nothing, so a word split by
// one reads as the whole word. AutoMod now matches the visible text: every
// rule sees the content without either class of invisible character.
//
// Each integration case runs the plain blocked word first as the control,
// through the real handlers, the real AutoMod evaluator and abuse policy, and
// the real permission resolver on the in-memory DB.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../db/index', () => mockDb);
jest.mock('../lib/linkPreview', () => ({ extractUrls: () => [], fetchLinkPreview: jest.fn() }));
jest.mock('../lib/pushSender', () => ({ sendPushToUser: jest.fn(async () => undefined) }));
jest.mock('../middleware/rateLimit', () => {
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { limits: new Proxy({}, { get: () => pass }), rateLimit: pass };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { sendChannelMessage } from '../socket/handlers/messages-send';
import { editChannelMessage } from '../lib/messageMutations';
import { machineContentRefused } from '../lib/messageContentPolicy';
import { evaluateAutomodRules } from '../lib/automodPolicy';
import { visibleMessageText } from '../lib/storedText';
import { ABUSE_POLICY } from '../lib/abusePolicy';
import threadsRouter from '../routes/threads';
import { invalidatePerms } from '../lib/permCache';
import { errorHandler } from '../middleware/errorHandler';

type Emitted = { ev: string; data: Record<string, unknown>; to?: string };

function makeIo() {
  const emitted: Emitted[] = [];
  return { emitted, to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; } };
}
function makeSocket() {
  const emitted: Emitted[] = [];
  return {
    id: `sock-${randomUUID()}`, rooms: new Set<string>(), emitted,
    on() {},
    emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data }); },
    to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; },
    join() {}, leave() {},
  };
}

// Invisible characters, by class. Storage strips the first group; the second
// is stored but renders as nothing.
const STRIPPED_BY_STORAGE: Array<[string, string]> = [
  ['U+0001 (C0 SOH)', '\u0001'], ['U+0007 (C0 BEL)', '\u0007'], ['U+001F (C0 US)', '\u001F'],
  ['U+007F (DEL)', '\u007F'], ['U+0085 (C1 NEL)', '\u0085'], ['U+009B (C1 CSI)', '\u009B'],
];
const FORMAT_CHARACTERS: Array<[string, string]> = [
  ['U+200B (zero-width space)', '​'], ['U+200C (ZWNJ)', '‌'], ['U+200D (ZWJ)', '‍'],
  ['U+2060 (word joiner)', '⁠'], ['U+FEFF (BOM)', '﻿'], ['U+00AD (soft hyphen)', '­'],
  ['U+202E (RTL override)', '‮'], ['U+2066 (LTR isolate)', '⁦'],
];
const ALL_INVISIBLE = [...STRIPPED_BY_STORAGE, ...FORMAT_CHARACTERS];

const blockedRule = (word = 'forbiddenword') => ({
  _id: 'rule-1', serverId: 'srv', type: 'blocked_words', enabled: true,
  config: JSON.stringify({ words: [word], action: 'delete' }),
});
const evaluate = (content: string, rule = blockedRule()) => evaluateAutomodRules(
  [rule], { serverId: 'srv', userId: 'u1', content, memberRoleIds: [] }, async () => 1,
);

describe('visibleMessageText', () => {
  it.each(ALL_INVISIBLE)('removes %s', (_label, char) => {
    expect(visibleMessageText(`forbidden${char}word`)).toBe('forbiddenword');
  });

  it('keeps TAB, LF, CR and every visible character, and never truncates', () => {
    const text = `a\tb\nc\r\nd 👍 é ü 中文 ${'x'.repeat(40_000)}`;
    expect(visibleMessageText(text)).toBe(text);
  });
});

describe('the AutoMod evaluator matches the visible text', () => {
  it('control: the plain blocked word matches', async () => {
    expect((await evaluate('say forbiddenword now')).deleteMessage).toBe(true);
  });

  it.each(ALL_INVISIBLE)('a blocked word split by %s still matches', async (_label, char) => {
    expect((await evaluate(`say forbidden${char}word now`)).deleteMessage).toBe(true);
  });

  it('a link split by a zero-width space still matches the link filter', async () => {
    const rule = { ...blockedRule(), type: 'link_filter', config: JSON.stringify({ action: 'delete' }) };
    expect((await evaluate('go https://example.com', rule)).deleteMessage).toBe(true);
    expect((await evaluate('go http​s://exa​mple.com', rule)).deleteMessage).toBe(true);
  });

  it.each([
    ['a newline between the halves', 'forbidden\nword'],
    ['a tab between the halves', 'forbidden\tword'],
    ['a space between the halves', 'forbidden word'],
    ['an emoji ZWJ sequence', 'family 👨‍👩‍👧 photo'],
  ])('no false positive: %s', async (_label, content) => {
    expect((await evaluate(content)).matched).toBe(false);
  });

  it('a machine principal (webhook) gets the same matching', async () => {
    await mockDb.automodRules.insert({ ...blockedRule(), _id: randomUUID(), serverId: 'srv-m' });
    const post = (content: string) => machineContentRefused(
      { principalId: 'webhook:w1', serverId: 'srv-m', channelId: 'ch-m', displayName: 'Hook', content }, null,
    );
    expect(await post('forbiddenword')).toBe(true);
    expect(await post('forbidden​word')).toBe(true);
    expect(await post('forbidden\u0001word')).toBe(true);
    expect(await post('forbidden word')).toBe(false);
  });
});

let owner: ReturnType<typeof makeUser>;
let member: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let channel: ReturnType<typeof makeChannel>;
let io: ReturnType<typeof makeIo>;
let app: express.Express;

beforeEach(async () => {
  mockDb._reset();
  owner = makeUser(); member = makeUser();
  server = makeServer(owner._id);
  channel = makeChannel(server._id);
  for (const u of [owner, member]) {
    await mockDb.users.insert(u);
    await mockDb.members.insert({ userId: u._id, serverId: server._id, joinedAt: Date.now(), roles: '[]' });
  }
  await mockDb.servers.insert(server);
  await mockDb.channels.insert(channel);
  invalidatePerms(server._id);
  io = makeIo();
  app = express();
  app.set('io', io);
  app.set('socketUsers', new Map());
  app.use(express.json());
  app.use('/api/threads', threadsRouter);
  app.use(errorHandler);
});

async function blockWord(word = 'forbiddenword') {
  await mockDb.automodRules.insert({
    _id: randomUUID(), serverId: server._id, type: 'blocked_words', enabled: true,
    config: JSON.stringify({ words: [word], action: 'delete' }), createdAt: Date.now(),
  });
}

async function channelSend(content: string) {
  const socket = makeSocket();
  await sendChannelMessage(
    { channelId: channel._id, serverId: server._id, content, ackId: `ack-${randomUUID()}` } as never,
    socket as never, io as never, member as never, new Map(),
  );
  const refused = socket.emitted.find(e => e.ev === 'error:message' || e.ev === 'error:spam');
  return refused ? String(refused.data.code ?? refused.data.reason) : null;
}
const storedContents = async () =>
  ((await mockDb.messages.find({ channelId: channel._id })) as Array<{ content?: string }>).map(m => m.content);

describe('channel send: an invisible character cannot carry a blocked word past AutoMod', () => {
  it('control: the plain word is refused', async () => {
    await blockWord();
    expect(await channelSend('say forbiddenword now')).toBe('AUTOMOD_BLOCKED');
    expect(await storedContents()).toEqual([]);
  });

  it.each(ALL_INVISIBLE)('split by %s: refused, nothing stored', async (_label, char) => {
    await blockWord();
    expect(await channelSend(`say forbidden${char}word now`)).toBe('AUTOMOD_BLOCKED');
    expect(await storedContents()).toEqual([]);
  });

  it('no false positive: an emoji ZWJ sequence is stored unchanged', async () => {
    await blockWord();
    const text = 'family 👨‍👩‍👧 photo';
    expect(await channelSend(text)).toBeNull();
    expect(await storedContents()).toEqual([text]);
  });
});

describe('the P7 repeat limit counts what a reader sees', () => {
  it(`control: the same text more than ${ABUSE_POLICY.repeat.max} times is refused (the duplicate guard may answer first)`, async () => {
    for (let i = 0; i < ABUSE_POLICY.repeat.max; i += 1) expect(await channelSend('buy cheap stuff now')).toBeNull();
    expect(await channelSend('buy cheap stuff now')).toMatch(/^spam_(duplicate|repeat)$/);
  });

  it('variants that differ only by where an invisible character sits are the same text', async () => {
    const variants = ['b​uy cheap stuff now', 'bu​y cheap stuff now', 'buy­ cheap stuff now', 'buy ch⁠eap stuff now'];
    for (let i = 0; i < ABUSE_POLICY.repeat.max; i += 1) expect(await channelSend(variants[i]!)).toBeNull();
    expect(await channelSend(variants[ABUSE_POLICY.repeat.max]!)).toBe('spam_repeat');
  });
});

describe('message edit: an invisible character cannot carry a blocked word past AutoMod', () => {
  it.each([['control (plain word)', ''], ...ALL_INVISIBLE])('%s', async (_label, char) => {
    await mockDb.messages.insert({
      _id: 'msg-1', channelId: channel._id, serverId: server._id, userId: member._id,
      content: 'benign', type: 'normal', createdAt: Date.now(),
    });
    await blockWord();
    const result = await editChannelMessage(io as never, {
      actorId: member._id, messageId: 'msg-1', channelId: channel._id, content: `now forbidden${char}word`,
    });
    expect(result).toMatchObject({ ok: false, code: 'AUTOMOD_BLOCKED' });
    expect(await storedContents()).toEqual(['benign']);
  });
});

describe('thread reply: an invisible character cannot carry a blocked word past AutoMod', () => {
  beforeEach(async () => {
    await mockDb.messages.insert({ _id: 'parent-msg', channelId: channel._id, serverId: server._id, userId: owner._id, content: 'topic', createdAt: 1 });
    await mockDb.threads.insert({
      _id: 'thread-1', channelId: channel._id, serverId: server._id, parentMessageId: 'parent-msg', name: 'topic',
      createdBy: owner._id, createdAt: 1, lastMessageAt: 1, messageCount: 0,
    });
  });
  const reply = (content: string) => request(app).post('/api/threads/thread-1/messages')
    .set('Authorization', `Bearer ${jwt.sign({ id: member._id, username: 'tester', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`)
    .send({ content });

  it.each([['control (plain word)', ''], ['U+0001', '\u0001'], ['U+200B', '​']])('%s: refused, nothing stored', async (_label, char) => {
    await blockWord();
    const res = await reply(`say forbidden${char}word now`);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'AUTOMOD_BLOCKED' });
    expect(await mockDb.threadMessages.find({ threadId: 'thread-1' })).toEqual([]);
  });
});
