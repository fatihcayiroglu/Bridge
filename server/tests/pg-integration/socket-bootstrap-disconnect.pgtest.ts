import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as SocketServer, type Socket as ServerSocket } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { createClient } from 'redis';

if (!process.env.PG_TEST_URL || !process.env.REDIS_TEST_URL) {
  throw new Error('Socket bootstrap integration requires explicit PG_TEST_URL and REDIS_TEST_URL');
}
const previousRedisUrl = process.env.REDIS_URL;
const previousInstance = process.env.INSTANCE_ID;
process.env.REDIS_URL = process.env.REDIS_TEST_URL;
process.env.INSTANCE_ID = `pg-bootstrap-${process.pid}-${Date.now()}`;

const runtime = require('../../socket/index') as typeof import('../../socket/index');
const presence = require('../../lib/presenceCache') as typeof import('../../lib/presenceCache');
const adapter = require('../../lib/redisAdapter') as typeof import('../../lib/redisAdapter');
const { makeToken } = require('../../middleware/auth') as typeof import('../../middleware/auth');
const db = require('../../db/loader').default as { _pool: import('pg').Pool };
const raw = createClient({ url: process.env.REDIS_TEST_URL });
const redisErrors: string[] = [];
raw.on('error', error => { redisErrors.push(error.name); });

const STEM = `pgt-bootstrap-${process.pid}-${Date.now()}`;
const OWNER = `${STEM}-owner`;
const SERVER = `${STEM}-server`;
const actors: string[] = [OWNER];
const clients: ClientSocket[] = [];
const sockets = new Map<string, ServerSocket>();
const initializations = new Map<string, Promise<void>>();
const disconnections: Promise<unknown>[] = [];

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Socket bootstrap condition not observed: ${label}`);
}

describe('socket bootstrap cancellation — real PostgreSQL row lock, Redis and Socket.IO', () => {
  const http = createServer();
  const io = new SocketServer(http);
  let url = '';

  async function seedUser(id: string): Promise<void> {
    await db._pool.query('INSERT INTO users (_id,username,"displayName",password,"createdAt",status,"tokenVersion") VALUES ($1,$1,$1,$2,1,$3,0)', [id, 'unused-test-password', 'offline']);
  }

  beforeAll(async () => {
    await raw.connect();
    expect(await adapter.applyAdapter(io)).toBe(true);
    runtime.setupSocket(io);
    await until(async () => adapter.isRedisAvailable(), 'real Redis adapter ready');

    // Observe completion of the actual async connection/disconnect callbacks.
    // No repository, authorization, presence operation or transport is mocked.
    const connection = io.listeners('connection')[0] as (socket: ServerSocket) => Promise<void>;
    expect(typeof connection).toBe('function');
    io.off('connection', connection);
    io.on('connection', socket => {
      sockets.set(socket.id, socket);
      type ObserveOn = (event: string, listener: (...args: unknown[]) => unknown) => ServerSocket;
      const on = socket.on.bind(socket) as ObserveOn;
      (socket as unknown as { on: ObserveOn }).on = (event, listener) => {
        if (event !== 'disconnect') return on(event, listener);
        return on(event, (...args) => {
          const completion = Promise.resolve(listener.apply(socket, args));
          disconnections.push(completion);
          void completion.catch(() => undefined); // Original promise is awaited at teardown.
          return completion;
        });
      };
      const completion = Promise.resolve(connection(socket));
      initializations.set(socket.id, completion);
      void completion.catch(() => undefined); // Tests await this exact promise.
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    await seedUser(OWNER);
    await db._pool.query('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [SERVER, OWNER]);
    await db._pool.query('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)', [OWNER, SERVER, '[]']);
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await io.close();
    await Promise.all(initializations.values());
    await Promise.all(disconnections);
    // Cleanup is scoped to this suite's fixtures, after every product assertion.
    // Failed baseline bootstrap entries must not contaminate other PG suites.
    for (const [id, socket] of sockets) {
      const user = runtime.socketUsers.get(id);
      if (user && actors.includes(user._id)) {
        await presence.releaseSocket(user._id, socket.id);
        runtime.socketUsers.delete(id);
      }
    }
    presence.stopPresenceReaper();
    await adapter.disconnect();
    for (const user of actors) {
      await raw.del([`bridge:cache:presence:sockets:${user}`, `bridge:cache:presence:visibility:${user}`, `bridge:cache:presence:online:${user}`]);
      await raw.zRem('bridge:cache:presence:users', user);
    }
    await raw.quit();
    await db._pool.query('DELETE FROM members WHERE "serverId"=$1', [SERVER]);
    await db._pool.query('DELETE FROM servers WHERE _id=$1', [SERVER]);
    await db._pool.query('DELETE FROM users WHERE _id=ANY($1::text[])', [actors]);
    await db._pool.end();
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousRedisUrl;
    if (previousInstance === undefined) delete process.env.INSTANCE_ID; else process.env.INSTANCE_ID = previousInstance;
    expect(redisErrors).toEqual([]);
  });

  function connect(user: string): { socket: ClientSocket; transport: Promise<void>; ready: Promise<void> } {
    const socket = connectClient(url, {
      auth: { token: makeToken({ _id: user, username: user, tokenVersion: 0 }) },
      autoConnect: false, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5_000,
    });
    clients.push(socket);
    const transport = new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve()); socket.once('connect_error', reject);
    });
    const ready = new Promise<void>((resolve, reject) => {
      socket.once('userAuthenticated', () => resolve()); socket.once('connect_error', reject);
    });
    void ready.catch(() => undefined);
    socket.connect();
    return { socket, transport, ready };
  }

  test.each([false, true])('disconnect during a blocked status write releases only its own lease (surviving tab: %s)', async survivor => {
    const actor = `${STEM}-${survivor ? 'survivor' : 'last'}`;
    actors.push(actor);
    await seedUser(actor);
    await db._pool.query('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)', [actor, SERVER, '[]']);
    let live: ReturnType<typeof connect> | undefined;
    if (survivor) {
      live = connect(actor); await live.transport; await live.ready;
      expect(await raw.zCard(`bridge:cache:presence:sockets:${actor}`)).toBe(1);
    }

    const lock = await db._pool.connect();
    let transactionOpen = false;
    let cancelled: ReturnType<typeof connect> | undefined;
    let serverSocket: ServerSocket | undefined;
    try {
      await lock.query('BEGIN'); transactionOpen = true;
      await lock.query('SELECT _id FROM users WHERE _id=$1 FOR UPDATE', [actor]);
      const blocker = Number((await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      cancelled = connect(actor); await cancelled.transport;
      const id = cancelled.socket.id!;
      serverSocket = sockets.get(id);
      expect(serverSocket).toBeDefined();
      await until(async () => Number((await db._pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))', [blocker],
      )).rows[0].n) > 0, 'production status UPDATE blocked by the PostgreSQL row lock');
      expect(runtime.socketUsers.has(id)).toBe(true);
      expect(await raw.zCard(`bridge:cache:presence:sockets:${actor}`)).toBe(survivor ? 2 : 1);
      const disconnected = new Promise<void>(resolve => serverSocket!.once('disconnect', () => resolve()));
      cancelled.socket.disconnect(); await disconnected;
      await lock.query('COMMIT'); transactionOpen = false;
      await initializations.get(id);

      expect(serverSocket!.connected).toBe(false);
      const state = await db._pool.query<{ status: string }>('SELECT status FROM users WHERE _id=$1', [actor]);
      expect({
        closedSocketRegistered: runtime.socketUsers.has(id),
        redisLeases: await raw.zCard(`bridge:cache:presence:sockets:${actor}`),
        authoritativeOnline: await presence.isUserOnline(actor),
        databaseStatus: state.rows[0].status,
      }).toEqual({
        closedSocketRegistered: false,
        redisLeases: survivor ? 1 : 0,
        authoritativeOnline: survivor,
        databaseStatus: survivor ? 'online' : 'offline',
      });
      if (live) expect(live.socket.connected).toBe(true);
    } finally {
      if (transactionOpen) await lock.query('ROLLBACK');
      lock.release();
      cancelled?.socket.close();
      live?.socket.close();
    }
  });
});
