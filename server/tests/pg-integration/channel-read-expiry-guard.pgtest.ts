/**
 * P7 D2: real PostgreSQL + HTTP evidence.
 *
 * This deliberately seeds an expiry via SQL: no public API enables creating
 * ephemeral channels yet. Verify cached message bodies never bypass a live
 * channel expiry/tombstone preflight.
 */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: OWNER };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { channelLiveForMessageRead } from '../../lib/channelReadExpiryGuard';

const db = require('../../db/loader').default;
const messagesRouter = require('../../routes/messages');
const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const STEM = 'pgt-d2-read-' + process.pid + '-' + Date.now();
const OWNER = STEM + '-owner';
const SERVER = STEM + '-server';
const CHANNEL = STEM + '-channel';
const MESSAGE = STEM + '-msg';
const validTime = () => Date.now() + 120_000;

RUN('P7 D2 authoritative message read — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const app = express();
  app.use(express.json());
  app.use('/api/channels', messagesRouter);

  async function cleanup() {
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM channel_read_positions WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM messages WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM channels WHERE _id=$1', [CHANNEL]);
    await q('DELETE FROM members WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM servers WHERE _id=$1', [SERVER]);
    await q('DELETE FROM users WHERE _id=$1', [OWNER]);
  }

  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$2,1)',
      [OWNER, 'owner', 'Owner', 'irrelevant']);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,1)',
      [SERVER, 'expiry-guard-server', OWNER]);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)',
      [OWNER, SERVER, '[]']);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,1)',
      [CHANNEL, SERVER, 'expiry-guard-channel']);
    await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [MESSAGE, CHANNEL, SERVER, OWNER, 'owner', 'Owner', 'pre-existing secret body', Date.now()]);
  });
  afterAll(cleanup);

  it('checks a tenant-scoped permanent channel on real PostgreSQL', async () => {
    expect(await channelLiveForMessageRead(db._pool, CHANNEL, SERVER)).toBe(true);
    expect(await channelLiveForMessageRead(db._pool, CHANNEL, 'wrong-server')).toBe(false);
  });

  it('blocks expired channel before cached first-page response is served', async () => {
    const baseline = await request(app).get('/api/channels/' + CHANNEL + '/messages');
    expect(baseline.status).toBe(200);
    expect(baseline.body.messages.some((m: { _id: string }) => m._id === MESSAGE)).toBe(true);

    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=1 WHERE _id=$2',
      [Date.now() - 1000, CHANNEL]);
    const blocked = await request(app).get('/api/channels/' + CHANNEL + '/messages');
    expect(blocked.status).toBe(404);
    expect(JSON.stringify(blocked.body)).not.toContain('pre-existing secret body');
    expect(await channelLiveForMessageRead(db._pool, CHANNEL, SERVER)).toBe(false);

    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2',
      [validTime(), CHANNEL]);
    const restored = await request(app).get('/api/channels/' + CHANNEL + '/messages');
    expect(restored.status).toBe(200);
  });

  it('rejects tombstoned channel across message, pinned and history endpoints', async () => {
    const expiredAt = Date.now() - 1000;
    await q('INSERT INTO channel_expiry_tombstones' +
      ' ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")' +
      ' VALUES ($1,$2,$3,2,$4,$5)',
      [CHANNEL, SERVER, expiredAt, Date.now(), 'pending']);
    const paths = [
      '/api/channels/' + CHANNEL + '/messages',
      '/api/channels/' + CHANNEL + '/pinned',
      '/api/channels/' + MESSAGE + '/history',
    ];
    for (const path of paths) {
      const reply = await request(app).get(path);
      expect({ path, status: reply.status }).toEqual({ path, status: 404 });
      expect(JSON.stringify(reply.body)).not.toContain('pre-existing secret body');
    }
    expect(await channelLiveForMessageRead(db._pool, CHANNEL, SERVER)).toBe(false);
  });
});
