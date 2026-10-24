/** A permanent bridge destination cannot authorize copying an expired source. */
import { Bridges, Messages } from '../../db/repositories';
import { publishPersistedMessage } from '../../lib/channelActivity';
import { Announcements } from '../../db/repositories/AnnouncementRepository';
import { sendChannelMessage } from '../../socket/handlers/messages-send';
import type { HandlerSocket, HandlerServer } from '../../socket/handler-contracts';
import type { AuthUser } from '../../socket/handlers/messages-types';

const db = require('../../db/loader').default;
const P = 'pgt-d2-bridge-source-' + process.pid + '-' + Date.now();
const USER = P + '-owner';
const SOURCE_SERVER = P + '-source-server';
const TARGET_SERVER = P + '-target-server';
const SOURCE = P + '-source';
const KEEPER = P + '-keeper';
const TARGET = P + '-target';
const BRIDGE = P + '-bridge';

describe('D2 deferred bridge source authority — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const events: Array<{ room: string; event: string; payload: unknown }> = [];
  const io: HandlerServer = { to: room => ({ emit(event, payload) { events.push({ room, event, payload }); } }) };
  const socket: HandlerSocket = {
    id: P + '-socket', rooms: new Set(), on() {}, join() {}, leave() {},
    to: io.to, emit() {},
  };
  let user: AuthUser;

  beforeAll(async () => {
    user = { _id: USER, username: USER, displayName: 'Synthetic bridge owner' };
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$1,1)', [USER]);
    for (const server of [SOURCE_SERVER, TARGET_SERVER]) {
      await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [server, USER]);
      await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,\'[]\'::jsonb,1)', [USER, server]);
    }
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1),($3,$4,$3,1)',
      [KEEPER, SOURCE_SERVER, TARGET, TARGET_SERVER]);
  });
  beforeEach(async () => {
    events.length = 0;
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1)', [SOURCE, SOURCE_SERVER]);
    const result = await Bridges.createOrReactivateAtomic({ id: BRIDGE, sourceChannelId: SOURCE,
      sourceServerId: SOURCE_SERVER, targetChannelId: TARGET, targetServerId: TARGET_SERVER,
      label: 'Synthetic bridge', createdBy: USER, createdAt: Date.now() });
    expect(result.status).toBe('created');
  });
  afterEach(async () => {
    await q('DELETE FROM channel_bridges WHERE _id=$1', [BRIDGE]);
    await q('DELETE FROM crosspost_log WHERE "sourceChannelId"=$1', [SOURCE]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [SOURCE]);
    await q('DELETE FROM messages WHERE "channelId" IN ($1,$2)', [SOURCE, TARGET]);
    await q('DELETE FROM channels WHERE _id=$1', [SOURCE]);
    await q('DELETE FROM upload_release_keys WHERE key=$1', ['uploads/' + P + '.png']);
  });
  afterAll(async () => {
    await q('DELETE FROM channels WHERE _id IN ($1,$2)', [KEEPER, TARGET]);
    await q('DELETE FROM members WHERE "serverId" IN ($1,$2)', [SOURCE_SERVER, TARGET_SERVER]);
    await q('DELETE FROM servers WHERE _id IN ($1,$2)', [SOURCE_SERVER, TARGET_SERVER]);
    await q('DELETE FROM users WHERE _id=$1', [USER]);
  });

  it.each(['live', 'expires-during-discovery'])('forwards according to the current source state: %s', async mode => {
    const find = Bridges.findActiveFromSourceChannel.bind(Bridges);
    const interleave = jest.spyOn(Bridges, 'findActiveFromSourceChannel').mockImplementation(async channelId => {
      const bridges = await find(channelId);
      expect(bridges.map(bridge => bridge._id)).toEqual([BRIDGE]);
      if (mode !== 'live') {
        await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
          "expiryVersion"=1 WHERE _id=$1`, [SOURCE]);
      }
      return bridges;
    });
    try {
      const content = 'Synthetic bridge copy ' + mode;
      await sendChannelMessage({ channelId: SOURCE, serverId: SOURCE_SERVER, content }, socket, io, user, new Map());
      // The source write and initial publication happened before expiry.
      expect((await q('SELECT content FROM messages WHERE "channelId"=$1', [SOURCE])).rows).toEqual([{ content }]);
      expect(interleave).toHaveBeenCalledWith(SOURCE);
      const rows = (await q('SELECT content FROM messages WHERE "channelId"=$1', [TARGET])).rows;
      const destinationEvents = events.filter(event => event.room === 'channel:' + TARGET);
      if (mode === 'live') {
        expect(rows).toEqual([{ content: '🌉 **[Synthetic bridge]** ' + content }]);
        expect(destinationEvents.map(event => event.event)).toEqual(['message:new']);
      } else {
        expect(rows).toEqual([]);
        expect(destinationEvents).toEqual([]);
      }
    } finally { interleave.mockRestore(); }
  });

  it('denies a direct copied INSERT from an expired source even into a live tenant', async () => {
    await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
      "expiryVersion"=1 WHERE _id=$1`, [SOURCE]);
    await expect(Messages.create({ _id: P + '-late-copy', channelId: TARGET, serverId: TARGET_SERVER,
      userId: USER, username: USER, displayName: 'Synthetic owner', content: 'late direct source copy',
      createdAt: Date.now(), bridgedFrom: { channelId: SOURCE, serverId: SOURCE_SERVER } }))
      .rejects.toMatchObject({ code: 'BX001' });
    expect((await q('SELECT _id FROM messages WHERE "channelId"=$1', [TARGET])).rows).toEqual([]);
  });

  it('does not publish a pre-expiry copy when its source expires after the copy commits', async () => {
    const message = await Messages.create({ _id: P + '-committed-copy', channelId: TARGET, serverId: TARGET_SERVER,
      userId: USER, username: USER, displayName: 'Synthetic owner', content: 'detached pre-expiry copy',
      createdAt: Date.now(), bridgedFrom: { channelId: SOURCE, serverId: SOURCE_SERVER } });
    await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
      "expiryVersion"=1 WHERE _id=$1`, [SOURCE]);
    expect(await publishPersistedMessage(io, message)).toBe(false);
    expect(events).toEqual([]);
    expect((await q('SELECT _id FROM messages WHERE _id=$1', [message._id])).rows).toHaveLength(1);
  });

  it.each(['missing', 'wrong-tenant', 'malformed', 'tombstoned'])('refuses a %s copy source through PostgreSQL', async mode => {
    if (mode === 'tombstoned') {
      await q(`INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")
        VALUES ($1,$2,1,1,FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT,'pending')`, [SOURCE, SOURCE_SERVER]);
    }
    // The adapter accepts already serialized JSON strings. Use syntactically
    // valid JSON so this reaches the source guard, not PostgreSQL's JSON parser.
    const source = mode === 'malformed' ? JSON.stringify('not-an-object') : {
      channelId: mode === 'missing' ? P + '-missing' : SOURCE,
      serverId: mode === 'wrong-tenant' ? TARGET_SERVER : SOURCE_SERVER,
    };
    await expect(Messages.create({ _id: P + '-invalid-copy', channelId: TARGET, serverId: TARGET_SERVER,
      userId: USER, username: USER, displayName: 'Synthetic owner', content: 'unavailable source fixture',
      createdAt: Date.now(), bridgedFrom: source })).rejects.toMatchObject({ code: 'BX001' });
    expect((await q('SELECT _id FROM messages WHERE "channelId"=$1', [TARGET])).rows).toEqual([]);
  });

  it('rolls back the crosspost idempotency log along with a refused source copy', async () => {
    const message = await Messages.create({ _id: P + '-announcement', channelId: SOURCE, serverId: SOURCE_SERVER,
      userId: USER, username: USER, displayName: 'Synthetic owner', content: 'announcement fixture', createdAt: Date.now() });
    await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
      "expiryVersion"=1 WHERE _id=$1`, [SOURCE]);
    await expect(Announcements.persistCrosspost({ bridgeMessageId: P + '-crosspost', sourceMessageId: message._id,
      sourceChannelId: SOURCE, sourceServerId: SOURCE_SERVER, targetChannelId: TARGET, targetServerId: TARGET_SERVER,
      userId: USER, username: USER, displayName: 'Synthetic owner', avatarColor: '#000000',
      content: 'announcement fixture', createdAt: Date.now() })).rejects.toMatchObject({ code: 'BX001' });
    expect((await q('SELECT * FROM crosspost_log WHERE "sourceChannelId"=$1', [SOURCE])).rows).toEqual([]);
    expect((await q('SELECT _id FROM messages WHERE "channelId"=$1', [TARGET])).rows).toEqual([]);
  });

  it('does not attach expired provenance to an existing permanent message', async () => {
    const message = await Messages.create({ _id: P + '-attach-source', channelId: TARGET, serverId: TARGET_SERVER,
      userId: USER, username: USER, displayName: 'Synthetic owner', content: 'ordinary fixture', createdAt: Date.now() });
    await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
      "expiryVersion"=1 WHERE _id=$1`, [SOURCE]);
    await expect(Messages.update(message._id, { bridgedFrom: { channelId: SOURCE, serverId: SOURCE_SERVER } }))
      .rejects.toMatchObject({ code: 'BX001' });
    expect((await q('SELECT "bridgedFrom" FROM messages WHERE _id=$1', [message._id])).rows).toEqual([{ bridgedFrom: null }]);
  });

  it('preserves edits of an existing authorized permanent copy and erasure of an expired destination', async () => {
    const permanent = await Messages.create({ _id: P + '-existing-copy', channelId: TARGET, serverId: TARGET_SERVER,
      userId: USER, username: USER, displayName: 'Synthetic owner', content: 'authorized copy fixture',
      createdAt: Date.now(), bridgedFrom: { channelId: SOURCE, serverId: SOURCE_SERVER } });
    const expiring = await Messages.create({ _id: P + '-erase-copy', channelId: SOURCE, serverId: SOURCE_SERVER,
      userId: USER, username: USER, displayName: 'Synthetic owner', content: 'erasure fixture',
      createdAt: Date.now(), bridgedFrom: { channelId: TARGET, serverId: TARGET_SERVER } });
    await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
      "expiryVersion"=1 WHERE _id=$1`, [SOURCE]);
    await Messages.update(permanent._id, { content: 'edited authorized permanent copy' });
    expect((await q('SELECT content FROM messages WHERE _id=$1', [permanent._id])).rows)
      .toEqual([{ content: 'edited authorized permanent copy' }]);
    await Messages.update(expiring._id, { deletedAt: Date.now(), deletedBy: USER, content: '[Mesaj silindi]' });
    const erased = (await q('SELECT content,"deletedAt" FROM messages WHERE _id=$1', [expiring._id])).rows[0];
    expect(erased.content).toBe('[Mesaj silindi]');
    expect(Number(erased.deletedAt)).toBeGreaterThan(0);
  });

  it('fails closed when an old repeatable-read snapshot predates source expiration', async () => {
    const writer = await db._pool.connect();
    try {
      await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await writer.query('SELECT _id FROM channels WHERE _id=$1', [SOURCE]);
      await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
        "expiryVersion"=1 WHERE _id=$1`, [SOURCE]);
      await expect(writer.query(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt","bridgedFrom")
        VALUES ($1,$2,$3,$4,$4,$4,'stale snapshot fixture',1,$5::jsonb)`,
      [P + '-stale-copy', TARGET, TARGET_SERVER, USER, JSON.stringify({ channelId: SOURCE, serverId: SOURCE_SERVER })]))
        .rejects.toMatchObject({ code: '40001' });
    } finally { await writer.query('ROLLBACK'); writer.release(); }
    expect((await q('SELECT _id FROM messages WHERE "channelId"=$1', [TARGET])).rows).toEqual([]);
  });

  it('denies a waiting source copy after the expiry worker commits its tombstone and deletion', async () => {
    const worker = await db._pool.connect();
    const writer = await db._pool.connect();
    const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let pending: Promise<unknown> | undefined;
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT _id FROM channels WHERE _id=$1 FOR UPDATE', [SOURCE]);
      pending = writer.query(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt","bridgedFrom")
        VALUES ($1,$2,$3,$4,$4,$4,'blocked source fixture',1,$5::jsonb)`,
      [P + '-blocked-copy', TARGET, TARGET_SERVER, USER, JSON.stringify({ channelId: SOURCE, serverId: SOURCE_SERVER })])
        .then(() => ({ committed: true }), (error: unknown) => error);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        if ((await q('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') {
          waiting = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await worker.query(`INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")
        VALUES ($1,$2,1,1,FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT,'pending')`, [SOURCE, SOURCE_SERVER]);
      await worker.query('DELETE FROM channels WHERE _id=$1', [SOURCE]);
      await worker.query('COMMIT');
      expect(await pending).toMatchObject({ code: 'BX001' });
      expect((await q('SELECT _id FROM messages WHERE "channelId"=$1', [TARGET])).rows).toEqual([]);
    } finally {
      await worker.query('ROLLBACK');
      if (pending) await pending;
      worker.release(); writer.release();
    }
  });

  it('rechecks a destination expiry after an INSERT waits on an upload-reference reservation', async () => {
    const key = 'uploads/' + P + '.png';
    await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+600000,
      "expiryVersion"=1 WHERE _id=$1`, [SOURCE]);
    const reserver = await db._pool.connect();
    const writer = await db._pool.connect();
    const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let pending: Promise<unknown> | undefined;
    try {
      await reserver.query('BEGIN');
      await reserver.query('INSERT INTO upload_release_keys (key,reserved) VALUES ($1,FALSE)', [key]);
      pending = writer.query(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt","fileUrl")
        VALUES ($1,$2,$3,$4,$4,$4,'delayed attachment fixture',1,$5)`, [P + '-attachment', SOURCE, SOURCE_SERVER, USER, '/' + key])
        .then(() => ({ committed: true }), (error: unknown) => error);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const state = (await q('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
        if (state?.wait_event_type === 'Lock') { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000 WHERE _id=$1`, [SOURCE]);
      await reserver.query('COMMIT');
      expect(await pending).toMatchObject({ code: 'BX001' });
      expect((await q('SELECT _id FROM messages WHERE _id=$1', [P + '-attachment'])).rows).toEqual([]);
    } finally {
      await reserver.query('ROLLBACK');
      if (pending) await pending;
      reserver.release(); writer.release();
    }
  });
});
