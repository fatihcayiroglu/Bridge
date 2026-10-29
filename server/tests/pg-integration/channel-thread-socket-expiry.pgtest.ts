/** Real PG and Socket.IO admission evidence, with test-only handler completion events.
 * This verifies fresh joins, not expiry eviction or delivery to existing subscribers.
 */
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as SocketServer, type Socket as ServerSocket } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import type { HandlerSocket } from '../../socket/handler-contracts';
import { registerThreadSocketEvents } from '../../socket/handlers/messages-thread';
import { setupMemberships } from '../../socket/handlers/members';

const db = require('../../db/loader').default;
const RUN = process.env.PG_TEST_URL ? describe : describe.skip;
const STEM = 'pgt-d2-joins-' + process.pid + '-' + Date.now();
const OWNER = STEM + '-owner';
const OUTSIDER = STEM + '-outsider';
const SERVER = STEM + '-server';
const OTHER_SERVER = STEM + '-other-server';
const CHANNEL = STEM + '-channel';
const THREAD = STEM + '-thread';
type ObservedSocket = HandlerSocket & { currentChannel?: string };

RUN('P7 D2 fresh channel/thread admission — real PostgreSQL + Socket.IO', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);

  /**
   * A thread row whose server disagrees with its channel can no longer be
   * written (the D2 write barrier refuses tenant_mismatch). This models a row
   * that predates the barrier: the trigger is disabled only inside this one
   * transaction (ACCESS EXCLUSIVE; no other session ever sees it disabled).
   */
  async function legacyThreadServer(serverId: string, threadId: string): Promise<void> {
    const legacy = await db._pool.connect();
    try {
      await legacy.query('BEGIN');
      await legacy.query('ALTER TABLE threads DISABLE TRIGGER channel_write_barrier');
      await legacy.query('UPDATE threads SET "serverId"=$1 WHERE _id=$2', [serverId, threadId]);
      await legacy.query('ALTER TABLE threads ENABLE TRIGGER channel_write_barrier');
      await legacy.query('COMMIT');
    } catch (err) {
      await legacy.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      legacy.release();
    }
  }
  const http = createServer();
  const io = new SocketServer(http);
  const sockets = new Map<string, { real: ServerSocket; observed: ObservedSocket }>();
  const clients: ClientSocket[] = [];
  let url: string;

  async function cleanup() {
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM threads WHERE _id=$1', [THREAD]);
    await q('DELETE FROM channels WHERE _id=$1', [CHANNEL]);
    await q('DELETE FROM members WHERE "serverId" IN ($1,$2)', [SERVER, OTHER_SERVER]);
    await q('DELETE FROM servers WHERE _id IN ($1,$2)', [SERVER, OTHER_SERVER]);
    await q('DELETE FROM users WHERE _id IN ($1,$2)', [OWNER, OUTSIDER]);
  }

  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$2,1),($3,$3,$3,$2,1)',
      [OWNER, 'irrelevant', OUTSIDER]);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$3,1),($2,$2,$3,1)',
      [SERVER, OTHER_SERVER, OWNER]);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$4::jsonb,1),($1,$3,$4::jsonb,1)',
      [OWNER, SERVER, OTHER_SERVER, '[]']);

    io.on('connection', (socket) => {
      // Forward the handler contract to a real Socket.IO socket. The only
      // instrumentation is an event after the registered handler's promise
      // settles, so a denied join is observable without timing-based sleeps.
      const observed: ObservedSocket = {
        id: socket.id,
        rooms: socket.rooms,
        on<A extends unknown[]>(event: string, listener: (...args: A) => unknown) {
          return socket.on(event, (...args: unknown[]) => {
            void Promise.resolve(listener(...args as A)).then(() => {
              socket.emit('test:handler-finished', event);
            }, () => { socket.emit('test:handler-error', event); });
          });
        },
        emit: (event, ...args) => socket.emit(event, ...args),
        join: room => socket.join(room),
        leave: room => socket.leave(room),
        to: room => socket.to(room),
      };
      sockets.set(socket.id, { real: socket, observed });
      const userId = String(socket.handshake.auth.userId);
      registerThreadSocketEvents(observed, io, { _id: userId, username: userId });
      void setupMemberships(observed, { _id: userId }).then(() => {
        socket.emit('test:ready');
      }, () => { socket.emit('test:setup-error'); });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    url = 'http://127.0.0.1:' + (http.address() as AddressInfo).port;
  });

  beforeEach(async () => {
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM threads WHERE _id=$1', [THREAD]);
    await q('DELETE FROM channels WHERE _id=$1', [CHANNEL]);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1)', [CHANNEL, SERVER]);
    await q('INSERT INTO threads (_id,"channelId","serverId",name,"createdBy","createdAt","lastMessageAt","messageCount")' +
      ' VALUES ($1,$2,$3,$1,$4,1,1,0)', [THREAD, CHANNEL, SERVER, OWNER]);
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    sockets.clear();
  });
  afterAll(async () => {
    await io.close();
    await cleanup();
  });

  async function connect(userId = OWNER) {
    const client = connectClient(url, { transports: ['websocket'], reconnection: false, auth: { userId } });
    clients.push(client);
    const joined: unknown[] = [];
    client.on('thread:joined', payload => joined.push(payload));
    await new Promise<void>((resolve, reject) => {
      client.once('test:ready', resolve);
      client.once('connect_error', reject);
      client.once('test:setup-error', () => reject(new Error('socket setup failed')));
    });
    const selected = sockets.get(String(client.id));
    if (!selected) throw new Error('connected socket was not registered');
    await selected.real.join(['channel:previous', 'thread:previous']);
    selected.observed.currentChannel = 'previous';
    return { client, selected, joined };
  }

  async function join(client: ClientSocket, event: 'channel:join' | 'thread:join', id: string) {
    const completed = new Promise<void>((resolve, reject) => {
      client.once('test:handler-finished', handled => {
        if (handled === event) resolve();
        else reject(new Error('unexpected handler completion: ' + String(handled)));
      });
      client.once('test:handler-error', () => reject(new Error('registered handler failed')));
    });
    client.emit(event, id);
    await completed;
  }

  async function expectBothDenied(userId = OWNER) {
    const { client, selected, joined } = await connect(userId);
    await join(client, 'channel:join', CHANNEL);
    await join(client, 'thread:join', THREAD);
    expect(selected.real.rooms.has('channel:' + CHANNEL)).toBe(false);
    expect(selected.real.rooms.has('thread:' + THREAD)).toBe(false);
    expect(selected.real.rooms.has('channel:previous')).toBe(true);
    expect(selected.real.rooms.has('thread:previous')).toBe(true);
    expect(selected.observed.currentChannel).toBe('previous');
    expect(joined).toEqual([]);
  }

  it.each(['permanent', 'active'])('admits a %s channel and its thread through actual socket events', async state => {
    if (state === 'active') {
      await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=1 WHERE _id=$2', [Date.now() + 120_000, CHANNEL]);
    }
    const { client, selected, joined } = await connect();
    await join(client, 'channel:join', CHANNEL);
    await join(client, 'thread:join', THREAD);
    expect(selected.real.rooms.has('channel:' + CHANNEL)).toBe(true);
    expect(selected.real.rooms.has('thread:' + THREAD)).toBe(true);
    expect(selected.real.rooms.has('channel:previous')).toBe(false);
    expect(selected.real.rooms.has('thread:previous')).toBe(false);
    expect(selected.observed.currentChannel).toBe(CHANNEL);
    expect(joined).toEqual([{ threadId: THREAD }]);
  });

  it('denies fresh subscriptions after a direct PostgreSQL expiry update', async () => {
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=1 WHERE _id=$2', [Date.now() - 1_000, CHANNEL]);
    await expectBothDenied();
  });

  it('denies a tombstone even when its retained channel row is permanent', async () => {
    await q('INSERT INTO channel_expiry_tombstones' +
      ' ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState") VALUES ($1,$2,$3,1,$4,$5)',
      [CHANNEL, SERVER, Date.now() - 1_000, Date.now(), 'pending']);
    await expectBothDenied();
  });

  it('denies a thread whose canonical parent channel has disappeared', async () => {
    await q('DELETE FROM channels WHERE _id=$1', [CHANNEL]);
    await expectBothDenied();
  });

  it('denies a thread with mismatched parent tenant despite membership in both servers', async () => {
    await legacyThreadServer(OTHER_SERVER, THREAD);
    const { client, selected, joined } = await connect();
    await join(client, 'thread:join', THREAD);
    expect(selected.real.rooms.has('thread:' + THREAD)).toBe(false);
    expect(selected.real.rooms.has('thread:previous')).toBe(true);
    expect(joined).toEqual([]);
  });

  it('retains the current membership denial for permanent channels', async () => {
    await expectBothDenied(OUTSIDER);
  });
});
