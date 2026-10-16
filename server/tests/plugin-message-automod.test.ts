// server/tests/plugin-message-automod.test.ts
//
// A plugin posts into a server's channel with `plugin:sendMessage`. The text
// is the plugin's, but often built from that server's data (a welcome template
// with the joining member's display name), and every member of the channel
// reads it. The server's AutoMod rules apply to it, as they do to installed
// bots and incoming webhooks: one machine-principal owner
// (lib/messageContentPolicy.ts machineContentRefused).
//
//   - The principal is `plugin:<pluginId>`, never a member: no role exemptions,
//     no timeout to apply, so any matching rule refuses the post. Nothing is
//     stored or published, and the refusal is written to the rule's log channel.
//   - Rules are the target server's: another server's rules do not apply.
//   - Message-frequency rules count each plugin on its own.
//   - A rule-store failure refuses the post (fail closed).
//   - Bridge's own system/audit messages (the AutoMod alert itself) are not
//     moderated, so a refusal cannot recurse.
//   - The P7 per-account limits stay human-only: they bound one person's
//     posting, and a plugin is one instance-wide principal across servers.
//
// Through the real hook bus and action handlers, the real AutoMod evaluator and
// log writer, and the real channel send path as the control, on the in-memory DB.
process.env.NODE_ENV = 'test';

import { createMockDb, makeChannel, makeServer, makeUser } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../db/index', () => mockDb);
jest.mock('../lib/linkPreview', () => ({ extractUrls: () => [], fetchLinkPreview: jest.fn() }));
jest.mock('../lib/pushSender', () => ({ sendPushToUser: jest.fn(async () => undefined) }));

import { randomUUID } from 'crypto';
import { hooks } from '../plugins/loader';
import { registerPluginActionHandlers } from '../plugins/actions';
import { makePluginActionEnvelope } from '../plugins/capabilities';
import { sendChannelMessage } from '../socket/handlers/messages-send';
import { invalidatePerms } from '../lib/permCache';
import { Automod } from '../db/repositories';
import logger from '../lib/logger';

type Emitted = { ev: string; data: Record<string, unknown>; to?: string };
const emitted: Emitted[] = [];
const io = { to(room: string) { return { emit(ev: string, data: Record<string, unknown>) { emitted.push({ ev, data, to: room }); } }; } };

let owner: ReturnType<typeof makeUser>;
let member: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let channel: ReturnType<typeof makeChannel>;
let modLog: ReturnType<typeof makeChannel>;

beforeAll(() => registerPluginActionHandlers(hooks, io as never));

beforeEach(async () => {
  mockDb._reset();
  emitted.length = 0;
  owner = makeUser(); member = makeUser();
  server = makeServer(owner._id);
  channel = makeChannel(server._id);
  modLog = makeChannel(server._id, { name: 'mod-log' });
  for (const u of [owner, member]) {
    await mockDb.users.insert(u);
    await mockDb.members.insert({ userId: u._id, serverId: server._id, joinedAt: Date.now(), roles: '[]' });
  }
  await mockDb.servers.insert(server);
  await mockDb.channels.insert(channel);
  await mockDb.channels.insert(modLog);
  invalidatePerms(server._id);
});
afterEach(() => jest.restoreAllMocks());

const pluginSend = (content: string, pluginId = 'welcome-bot', target = channel) =>
  hooks.emit('plugin:sendMessage', makePluginActionEnvelope(pluginId, ['messages:send'], {
    channelId: target._id, serverId: target.serverId, content, botName: 'Welcome Bot',
  }));
const posted = async (target = channel) => mockDb.messages.find({ channelId: target._id });
const published = (target = channel) => emitted.filter(e => e.ev === 'message:new' && e.to === `channel:${target._id}`);
const logEntries = async () => (await mockDb.messages.find({ channelId: modLog._id })) as Array<{ userId?: string; autoModAlert?: boolean; content?: string }>;

async function addRule(type: string, config: Record<string, unknown>, serverId = server._id) {
  await mockDb.automodRules.insert({
    _id: randomUUID(), serverId, type, enabled: true,
    config: JSON.stringify({ action: 'delete', logChannelId: modLog._id, ...config }), createdAt: Date.now(),
  });
}

describe('server AutoMod applies to plugin messages', () => {
  it('a blocked word refused for a member is refused for a plugin: nothing stored or published, the refusal logged', async () => {
    await addRule('blocked_words', { words: ['forbiddenword'] });

    // Control: the canonical channel send refuses it.
    const socket = { id: 's1', rooms: new Set<string>(), emitted: [] as Emitted[], on() {}, to() { return { emit() {} }; }, join() {}, leave() {},
      emit(ev: string, data: Record<string, unknown>) { this.emitted.push({ ev, data }); } };
    await sendChannelMessage({ channelId: channel._id, serverId: server._id, content: 'welcome forbiddenword', ackId: 'ack-plugin-1' } as never,
      socket as never, io as never, member as never, new Map());
    expect(socket.emitted.find(e => e.ev === 'error:message')?.data.code).toBe('AUTOMOD_BLOCKED');

    await pluginSend('welcome forbiddenword');
    expect(await posted()).toEqual([]);
    expect(published()).toEqual([]);

    const logs = await logEntries();
    expect(logs).toHaveLength(2); // the member's refusal and the plugin's
    const pluginLog = logs.find(l => l.content?.includes('plugin:welcome-bot'));
    expect(pluginLog).toMatchObject({ userId: 'system', autoModAlert: true });
    // The alert quotes the refused text: Bridge's own audit message is not moderated.
    expect(pluginLog?.content).toContain('forbiddenword');
  });

  it('CONTROL: ordinary plugin text is stored and published once', async () => {
    await addRule('blocked_words', { words: ['forbiddenword'] });
    await pluginSend('welcome to the server, Ada');
    const rows = await posted() as Array<{ content?: string; type?: string; username?: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: 'welcome to the server, Ada', type: 'system', username: 'plugin-welcome-bot' });
    expect(published()).toHaveLength(1);
  });

  it('a link rule refuses a plugin link (no implicit integration exemption)', async () => {
    await addRule('links', {});
    await pluginSend('read the rules at https://example.org/rules');
    expect(await posted()).toEqual([]);
    expect(published()).toEqual([]);
  });

  it('a rule whose action is only a timeout still refuses: a plugin cannot be timed out', async () => {
    await addRule('blocked_words', { words: ['forbiddenword'], action: 'timeout', timeoutMs: 60_000 });
    await pluginSend('welcome forbiddenword');
    expect(await posted()).toEqual([]);
    expect(published()).toEqual([]);
  });

  it('another server\'s rules do not apply', async () => {
    const other = makeServer(owner._id);
    await mockDb.servers.insert(other);
    await addRule('blocked_words', { words: ['forbiddenword'] }, other._id);
    await pluginSend('welcome forbiddenword');
    expect(await posted()).toHaveLength(1);
  });

  it('a message-frequency rule counts each plugin on its own', async () => {
    await addRule('spam_messages', { maxMessages: 2, windowSecs: 60 });
    await pluginSend('welcome Ada');
    await pluginSend('welcome Grace');
    await pluginSend('welcome Edsger');
    expect(await posted()).toHaveLength(2);
    expect(published()).toHaveLength(2);

    await pluginSend('word filter: message removed', 'word-filter');
    expect(await posted()).toHaveLength(3);
  });

  it('a rule-store failure refuses the post (fail closed) and is logged', async () => {
    jest.spyOn(Automod, 'findByServer').mockRejectedValue(new Error('automod rule store unavailable'));
    const errors = jest.spyOn(logger, 'error');
    await pluginSend('welcome Ada');
    expect(await posted()).toEqual([]);
    expect(published()).toEqual([]);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'plugin.sendMessage', err: 'automod rule store unavailable' }),
      expect.any(String),
    );
  });
});
