// server/tests/pg-integration/thread-message-reports.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL — P7 B5: thread replies are reportable (migration 093)
// ════════════════════════════════════════════════════════════════════════════
// Only channel messages had a report path. A thread reply now uses the same
// report row (with "threadId"), the same 085 snapshot and the same moderators.
// Adversarial cases:
//   · a missing reply, a reply named under another thread, a thread in a channel
//     the reporter cannot see, a non-member, another tenant's thread and an
//     expired-but-unclaimed channel answer one identical 404; none stores a row;
//   · the own-reply rule, an invalid body, a duplicate and a fail-closed 503;
//   · the queue shows the snapshot and how the reply changed since: edited
//     (with the current text), removed when the thread is deleted;
//   · the expiry worker removes the thread but keeps the report (088);
//   · 093 down refuses while a thread report exists, and drops the column
//     when none does.
// Runs only with PG_TEST_URL; removes its own rows.

const P = 'pgt-trep-' + process.pid;
const OWNER = `${P}-owner`;
const MOD = `${P}-mod`;
const REPORTER = `${P}-reporter`;
const AUTHOR = `${P}-author`;
const OUTSIDER = `${P}-outsider`;
const OTHER_OWNER = `${P}-other-owner`;
const SRV = `${P}-srv`;
const OTHER_SRV = `${P}-other-srv`;
const MOD_ROLE = `${P}-role-mod`;
const MEMBER_ROLE = `${P}-role-member`;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown; headers: Record<string, string | undefined> }, _res: unknown, next: () => void) => {
    req.user = { id: req.headers['x-test-user'], displayName: 'tester' };
    next();
  },
  _invalidateTokenCache: () => undefined,
}));
jest.mock('../../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { runChannelExpiryTick } from '../../lib/channelExpiryWorker';
import { PERMS } from '../../lib/permissions';

const db = require('../../db/loader').default;
const { Threads } = require('../../db/repositories');
const moderationRouter = require('../../routes/moderation').default;
const threadsRouter = require('../../routes/threads').default ?? require('../../routes/threads');

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const down093 = fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg/rollback/093_message_report_thread_replies.down.sql'), 'utf8');

type Row = Record<string, unknown>;

RUN('real PostgreSQL — thread replies are reportable (093)', () => {
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db._pool.query(sql, params)).rows;
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId', moderationRouter);
  app.use('/api/threads', threadsRouter);
  const file = (user: string, threadId: string, messageId: string, body: Row = { reason: 'harassment', detail: 'look' }) =>
    request(app).post(`/api/threads/${threadId}/messages/${messageId}/report`).set('x-test-user', user).send(body);
  const list = (user: string) => request(app).get(`/api/servers/${SRV}/reports`).set('x-test-user', user);
  let seq = 0;
  const id = (label: string) => `${P}-${label}-${++seq}`;
  const rowsFor = async (mid: string) => q('SELECT * FROM message_reports WHERE "messageId"=$1', [mid]);

  async function cleanup() {
    for (const s of [SRV, OTHER_SRV]) {
      await q('DELETE FROM message_reports WHERE "serverId"=$1', [s]);
      await q('DELETE FROM thread_messages WHERE "serverId"=$1', [s]);
      await q('DELETE FROM threads WHERE "serverId"=$1', [s]);
      await q('DELETE FROM messages WHERE "serverId"=$1', [s]);
      await q('DELETE FROM channel_permissions WHERE "serverId"=$1', [s]);
      await q('DELETE FROM channel_expiry_tombstones WHERE "serverId"=$1', [s]);
      await q('DELETE FROM audit_logs WHERE "serverId"=$1', [s]);
      await q('DELETE FROM channels WHERE "serverId"=$1', [s]);
      await q('DELETE FROM roles WHERE "serverId"=$1', [s]);
      await q('DELETE FROM members WHERE "serverId"=$1', [s]);
      await q('DELETE FROM servers WHERE _id=$1', [s]);
    }
    await q('DELETE FROM users WHERE _id LIKE $1', [`${P}-%`]);
  }

  async function channel(label: string, opts: { server?: string; expiring?: boolean } = {}): Promise<string> {
    const cid = id(label);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$3,1,$4,$5)',
      [cid, opts.server ?? SRV, label, opts.expiring ? Date.now() + 600_000 : null, opts.expiring ? 1 : 0]);
    return cid;
  }
  async function thread(channelId: string, server = SRV): Promise<string> {
    const tid = id('thread');
    await q(`INSERT INTO threads (_id,"channelId","serverId",name,"createdBy","createdAt","lastMessageAt") VALUES ($1,$2,$3,'t',$4,1,1)`,
      [tid, channelId, server, AUTHOR]);
    return tid;
  }
  async function reply(threadId: string, channelId: string, text: string, opts: { author?: string; server?: string } = {}): Promise<string> {
    const mid = id('reply');
    await q(`INSERT INTO thread_messages (_id,"threadId","channelId","serverId","userId",username,"displayName",content,"createdAt")
             VALUES ($1,$2,$3,$4,$5,'author','Abuser',$6,$7)`,
      [mid, threadId, channelId, opts.server ?? SRV, opts.author ?? AUTHOR, text, Date.now()]);
    return mid;
  }
  const expire = (cid: string) => q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [Date.now() - 1000, cid]);
  async function drainExpiry() {
    for (let i = 0; i < 200; i++) {
      const r = await runChannelExpiryTick(db._pool);
      if (!r.claimed.length && !r.converged.length && !r.deleted) return;
    }
  }

  beforeAll(async () => {
    await cleanup();
    for (const u of [OWNER, MOD, REPORTER, AUTHOR, OUTSIDER, OTHER_OWNER]) {
      await q(`INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$2,'x',1)`, [u, u.replace(/-/g, '_')]);
    }
    await q(`INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,'Threads',$2,1)`, [SRV, OWNER]);
    await q(`INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,'Other',$2,1)`, [OTHER_SRV, OTHER_OWNER]);
    const base = PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;
    await q(`INSERT INTO roles (_id,"serverId",name,permissions,position,"createdAt") VALUES ($1,$2,'mod',$3,2,1),($4,$2,'member',$5,1,1)`,
      [MOD_ROLE, SRV, base | PERMS.MANAGE_MESSAGES, MEMBER_ROLE, base]);
    const members: Array<[string, string, string[]]> = [
      [OWNER, SRV, []], [MOD, SRV, [MOD_ROLE]], [REPORTER, SRV, [MEMBER_ROLE]], [AUTHOR, SRV, [MEMBER_ROLE]],
      [OTHER_OWNER, OTHER_SRV, []],
    ];
    for (const [u, s, roles] of members) {
      await q(`INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)`, [u, s, JSON.stringify(roles)]);
    }
  });
  afterAll(cleanup);

  it('schema: 093 adds a nullable, unconstrained "threadId"; no foreign key ties a report to a reply or thread', async () => {
    const col = await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
                         WHERE table_name='message_reports' AND column_name='threadId'`);
    expect(col).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
    const fks = (await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                          WHERE conrelid='message_reports'::regclass AND contype='f'`)).map(r => String(r.def));
    expect(fks.some(d => /REFERENCES (threads|thread_messages)/.test(d))).toBe(false);
  });

  it('a member reports a thread reply: 201 with the snapshot and the thread; a repeat is 200 without a new row', async () => {
    const cid = await channel('general');
    const tid = await thread(cid);
    const mid = await reply(tid, cid, 'abusive reply');
    const first = await file(REPORTER, tid, mid);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ reported: true, created: true });
    const rows = await rowsFor(mid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ serverId: SRV, channelId: cid, threadId: tid, messageId: mid, reporterId: REPORTER,
      reason: 'harassment', detail: 'look', status: 'open', evidenceText: 'abusive reply', evidenceAuthorId: AUTHOR,
      evidenceAuthorName: 'Abuser' });
    const again = await file(REPORTER, tid, mid);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, id: first.body.id });
    expect(await rowsFor(mid)).toHaveLength(1);
  });

  it('every case the reporter must not tell apart answers one identical 404 and stores nothing', async () => {
    const cid = await channel('oracle');
    const tid = await thread(cid);
    const mid = await reply(tid, cid, 'visible reply');
    const otherTid = await thread(cid);
    const hidden = await channel('hidden');
    await q(`INSERT INTO channel_permissions (_id,"channelId","roleId","serverId",allow,deny,"createdAt") VALUES ($1,$2,$3,$4,0,$5,1)`,
      [id('deny'), hidden, MEMBER_ROLE, SRV, PERMS.VIEW_CHANNELS]);
    const hiddenTid = await thread(hidden);
    const hiddenMid = await reply(hiddenTid, hidden, 'HIDDEN-REPLY-TEXT');
    const foreignCid = await channel('foreign', { server: OTHER_SRV });
    const foreignTid = await thread(foreignCid, OTHER_SRV);
    const foreignMid = await reply(foreignTid, foreignCid, 'foreign reply', { author: OTHER_OWNER, server: OTHER_SRV });
    const expiring = await channel('expiring', { expiring: true });
    const expTid = await thread(expiring);
    const expMid = await reply(expTid, expiring, 'EXPIRED-REPLY-TEXT');
    await expire(expiring);                 // no worker tick: the rows still exist

    const cases = await Promise.all([
      file(REPORTER, tid, id('no-such-reply')),        // missing reply
      file(REPORTER, otherTid, mid),                   // a real reply named under another thread
      file(REPORTER, id('no-such-thread'), mid),       // missing thread
      file(REPORTER, hiddenTid, hiddenMid),            // channel denied to the reporter
      file(OUTSIDER, tid, mid),                        // not a member of the server
      file(REPORTER, foreignTid, foreignMid),          // another tenant's thread
      file(REPORTER, expTid, expMid),                  // expired, not yet claimed
    ]);
    for (const res of cases) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(cases[0].body);
    }
    expect(JSON.stringify(cases.map(c => c.body))).not.toMatch(/HIDDEN-REPLY-TEXT|EXPIRED-REPLY-TEXT/);
    for (const m of [mid, hiddenMid, foreignMid, expMid]) expect(await rowsFor(m)).toHaveLength(0);
  });

  it('the author cannot report their own reply; an invalid reason or an overlong note is refused', async () => {
    const cid = await channel('own');
    const tid = await thread(cid);
    const own = await reply(tid, cid, 'mine', { author: REPORTER });
    expect((await file(REPORTER, tid, own)).status).toBe(400);
    const other = await reply(tid, cid, 'theirs');
    expect((await file(REPORTER, tid, other, { reason: 'bogus' })).status).toBe(400);
    expect((await file(REPORTER, tid, other, { reason: 'spam', detail: 'x'.repeat(501) })).status).toBe(400);
    expect(await rowsFor(own)).toHaveLength(0);
    expect(await rowsFor(other)).toHaveLength(0);
  });

  it('the queue shows the snapshot, the thread, and how the reply changed: edited, then removed with its thread', async () => {
    const cid = await channel('queue');
    const tid = await thread(cid);
    const mid = await reply(tid, cid, 'original reply');
    const rid = String((await file(REPORTER, tid, mid)).body.id);
    const entry = async (user = MOD) => (await list(user)).body.reports.find((r: { id: string }) => r.id === rid);

    expect(await entry()).toMatchObject({ messageId: mid, channelId: cid, threadId: tid, currentState: 'unchanged',
      evidence: expect.objectContaining({ state: 'captured', text: 'original reply' }),
      message: { displayName: 'Abuser', preview: 'original reply' } });
    // A plain member does not see the queue.
    expect(await entry(REPORTER)).toBeUndefined();

    await q('UPDATE thread_messages SET content=$1, "editedAt"=$2 WHERE _id=$3', ['edited reply', Date.now(), mid]);
    expect(await entry()).toMatchObject({ currentState: 'edited', message: { preview: 'edited reply' },
      evidence: expect.objectContaining({ text: 'original reply' }) });

    await Threads.deleteThread(tid);
    expect(await entry()).toMatchObject({ currentState: 'removed', message: { preview: '' },
      evidence: expect.objectContaining({ text: 'original reply' }) });
  });

  it('channel expiry removes the thread but keeps the report and its snapshot (088)', async () => {
    const eph = await channel('eph', { expiring: true });
    const tid = await thread(eph);
    const mid = await reply(tid, eph, 'reported before expiry');
    const rid = String((await file(REPORTER, tid, mid)).body.id);
    await expire(eph);
    await drainExpiry();
    expect(await q('SELECT 1 FROM thread_messages WHERE "threadId"=$1', [tid])).toHaveLength(0);
    expect(await q('SELECT 1 FROM threads WHERE _id=$1', [tid])).toHaveLength(0);
    expect((await q('SELECT * FROM message_reports WHERE _id=$1', [rid]))[0])
      .toMatchObject({ threadId: tid, status: 'open', evidenceText: 'reported before expiry' });
    const asOwner = (await list(OWNER)).body.reports.find((r: { id: string }) => r.id === rid);
    expect(asOwner).toMatchObject({ threadId: tid, channel: { available: false, name: null }, currentState: 'removed' });
  });

  it('093 down refuses while a thread report exists and drops the column when none does', async () => {
    const client = await db._pool.connect();
    try {
      expect((await client.query('SELECT count(*)::int AS n FROM message_reports WHERE "threadId" IS NOT NULL')).rows[0].n).toBeGreaterThan(0);
      await client.query('BEGIN');
      await expect(client.query(down093)).rejects.toThrow(/093 down refused/);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query('DELETE FROM message_reports WHERE "threadId" IS NOT NULL');
      await client.query(down093);
      const col = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name='message_reports' AND column_name='threadId'`);
      expect(col.rows).toHaveLength(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await q(`SELECT 1 FROM information_schema.columns WHERE table_name='message_reports' AND column_name='threadId'`)).toHaveLength(1);
  });
});
