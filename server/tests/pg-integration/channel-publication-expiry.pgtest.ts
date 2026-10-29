import '../helpers/realRedisFixture';

/** A deferred publisher must not emit a previously committed row after expiry. */
import { publishPersistedMessage, broadcastPersistedMessage } from '../../lib/channelActivity';
import { Bots, Messages } from '../../db/repositories';
import { dispatchRegisteredBotCommand } from '../../lib/botCommandDispatch';
import { sendChannelMessage } from '../../socket/handlers/messages-send';
import type { HandlerSocket, HandlerServer } from '../../socket/handler-contracts';
import type { AuthUser } from '../../socket/handlers/messages-types';

const db = require('../../db/loader').default;
const P = 'pgt-d2-publication-' + process.pid + '-' + Date.now();
const USER = P + '-user';
const SERVER = P + '-server';
const CHANNEL = P + '-channel';
const PERMANENT = P + '-permanent';
const MESSAGE = P + '-message';
const BOT = P + '-bot';

describe('D2 post-commit publication — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = { to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }) };

  beforeAll(async () => {
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$1,1)', [USER]);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [SERVER, USER]);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,\'[]\'::jsonb,1)', [USER, SERVER]);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1)', [PERMANENT, SERVER]);
    await q(`INSERT INTO bots (_id,"serverId","ownerId",username,"tokenHash","slashCommands","createdAt")
      VALUES ($1,$2,$3,$1,$1,'[{"name":"ping"}]'::jsonb,1)`, [BOT, SERVER, USER]);
  });
  beforeEach(async () => {
    emitted.length = 0;
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1)', [CHANNEL, SERVER]);
  });
  afterEach(async () => {
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM messages WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM channels WHERE _id=$1', [CHANNEL]);
  });
  afterAll(async () => {
    await q('DELETE FROM bots WHERE _id=$1', [BOT]);
    await q('DELETE FROM channels WHERE _id=$1', [PERMANENT]);
    await q('DELETE FROM members WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM servers WHERE _id=$1', [SERVER]);
    await q('DELETE FROM users WHERE _id=$1', [USER]);
  });

  async function persist(content = 'deferred private content') {
    const message = await Messages.create({
      _id: MESSAGE, channelId: CHANNEL, serverId: SERVER, userId: USER,
      username: USER, displayName: 'Synthetic fixture', content,
      contentFormat: 1, type: 'normal', reactions: {}, createdAt: Date.now(),
    });
    expect(message._id).toBe(MESSAGE);
    expect(message.content).toBe(content);
    if (typeof message.content !== 'string') throw new Error('Persisted fixture must have plaintext content');
    return { ...message, content: message.content };
  }

  it.each(['permanent', 'future'])('publishes a committed message in a %s channel', async mode => {
    if (mode === 'future') {
      await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+600000,
        "expiryVersion"=1 WHERE _id=$1`, [CHANNEL]);
    }
    expect(await publishPersistedMessage(io, await persist())).toBe(true);
    expect(emitted.map(item => item.event)).toEqual(['message:new', 'channel:activity']);
    expect(emitted[0]?.payload).toMatchObject({ _id: MESSAGE, content: 'deferred private content' });
  });

  it.each(['publish', 'broadcast'])('refuses expired content held by a deferred %s after COMMIT', async mode => {
    const message = await persist();
    await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
      "expiryVersion"=1 WHERE _id=$1`, [CHANNEL]);
    // No cleanup worker ran: the durable row and its detached in-memory copy
    // both still exist. Admission/INSERT guards alone cannot stop this leak.
    expect((await q('SELECT count(*)::int AS n FROM messages WHERE _id=$1', [MESSAGE])).rows[0].n).toBe(1);
    const allowed = mode === 'publish' ? await publishPersistedMessage(io, message) : await broadcastPersistedMessage(io, message);
    expect(allowed).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('refuses a detached row when its channel is tombstoned despite future expiry metadata', async () => {
    const message = await persist();
    await q(`INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")
      VALUES ($1,$2,1,1,FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT,'pending')`, [CHANNEL, SERVER]);
    expect(await publishPersistedMessage(io, message)).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('does not deliver a real row under a forged tenant identity', async () => {
    const message = await persist();
    expect(await publishPersistedMessage(io, { ...message, serverId: P + '-other-server' })).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('checks the database even without io before an HTTP caller returns a detached row', async () => {
    const message = await persist();
    expect(await broadcastPersistedMessage(null, message)).toBe(true);
    await q('DELETE FROM messages WHERE _id=$1', [MESSAGE]);
    await q('DELETE FROM channels WHERE _id=$1', [CHANNEL]);
    expect(await broadcastPersistedMessage(null, message)).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('ACKs the real socket write but does not broadcast if expiry occurs after its INSERT commits', async () => {
    const socketEvents: Array<{ event: string; payload: unknown }> = [];
    const socket: HandlerSocket = {
      id: P + '-socket', rooms: new Set(), on() {}, join() {}, leave() {},
      to: io.to,
      emit(event, payload) { socketEvents.push({ event, payload }); },
    };
    const user = (await q('SELECT * FROM users WHERE _id=$1', [USER])).rows[0] as AuthUser;
    // Pause the production handler at an actual COMMIT, then let a different
    // PostgreSQL statement expire the channel before the handler resumes.
    const create = Messages.create.bind(Messages);
    const committedIds: string[] = [];
    const interleave = jest.spyOn(Messages, 'create').mockImplementation(async row => {
      const message = await create(row);
      committedIds.push(String(message._id));
      await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
        "expiryVersion"=1 WHERE _id=$1`, [CHANNEL]);
      return message;
    });
    try {
      await sendChannelMessage({ channelId: CHANNEL, serverId: SERVER, content: 'committed socket fixture',
        _tmpId: 'expiry-after-commit' }, socket, io as HandlerServer, user, new Map());
      expect(committedIds).toHaveLength(1);
      expect((await q('SELECT content FROM messages WHERE _id=$1', [committedIds[0]])).rows)
        .toEqual([{ content: 'committed socket fixture' }]);
      expect(socketEvents).toEqual([{ event: 'message:ack', payload: expect.objectContaining({
        tmpId: 'expiry-after-commit', messageId: committedIds[0], channelId: CHANNEL,
      }) }]);
      expect(JSON.stringify(socketEvents)).not.toContain('committed socket fixture');
      expect(emitted).toEqual([]);
    } finally {
      interleave.mockRestore();
    }
  });

  it('does not deliver a slash command if expiry occurs during deferred bot discovery', async () => {
    const message = await persist('/ping private arguments');
    const find = Bots.findInstalledForServer.bind(Bots);
    const discovery = jest.spyOn(Bots, 'findInstalledForServer').mockImplementation(async () => {
      const bots = await find(SERVER);
      expect(bots.map(bot => bot._id)).toEqual([BOT]);
      await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
        "expiryVersion"=1 WHERE _id=$1`, [CHANNEL]);
      return bots;
    });
    try {
      expect(await dispatchRegisteredBotCommand(io, message)).toBe(0);
      expect(discovery).toHaveBeenCalledWith(SERVER);
      expect(emitted).toEqual([]);
    } finally {
      discovery.mockRestore();
    }
  });

  it('still delivers a live slash invocation only to its registered bot', async () => {
    const message = await persist('/ping live arguments');
    expect(await dispatchRegisteredBotCommand(io, message)).toBe(1);
    expect(emitted).toEqual([{ room: 'bot:' + BOT, event: 'message:new', payload: message }]);
  });
});
