// server/tests/pg-integration/report-retention.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL — P7 D2 x B5: moderation reports outlive their channel (088)
// ════════════════════════════════════════════════════════════════════════════
// Owner decision on #321: expiring or deleting a channel must not destroy its
// moderation reports or their 085 evidence snapshots. Retention follows the
// report: kept while open, scrubbed 90 days after resolution by the existing
// worker. Adversarial cases:
//   · the expiry worker and ordinary channel deletion remove the conversation
//     but keep open AND resolved reports with their evidence;
//   · server deletion still removes the server's reports (tenant ownership);
//   · once the channel is gone only SERVER-level moderators see or resolve its
//     reports; a channel-override moderator, a plain member and another
//     server's owner do not; an expired-but-unclaimed channel's live rows are
//     never shown, only the snapshot;
//   · the retention worker scrubs evidence of a gone channel's report after the
//     window, never an open one or one inside the window;
//   · author erasure anonymizes the snapshot; reporter erasure removes the report;
//   · 088's down refuses while a report points at a missing channel.
// Runs only with PG_TEST_URL; removes its own rows.

const P = 'pgt-rret-' + process.pid;
const OWNER = `${P}-owner`;
const MOD = `${P}-mod`;
const ADMIN = `${P}-admin`;
const CHMOD = `${P}-chmod`;
const MEMBER = `${P}-member`;
const REPORTER = `${P}-reporter`;
const AUTHOR = `${P}-author`;
const OTHER_OWNER = `${P}-other-owner`;
const SRV = `${P}-srv`;
const OTHER_SRV = `${P}-other-srv`;
const KEEP = `${P}-keep`;
const MOD_ROLE = `${P}-role-mod`;
const HELPER_ROLE = `${P}-role-helper`;
const ADMIN_ROLE = `${P}-role-admin`;
const DAY = 24 * 60 * 60 * 1000;

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
import { captureReportEvidence } from '../../lib/reportEvidence';
import { runChannelExpiryTick } from '../../lib/channelExpiryWorker';
import { runReportEvidenceRetentionTick } from '../../jobs/reportEvidenceRetention';
import { PERMS } from '../../lib/permissions';

const db = require('../../db/loader').default;
const MessageReports = require('../../db/repositories/MessageReportRepository').default;
const { Messages, Channels, Servers } = require('../../db/repositories');
const moderationRouter = require('../../routes/moderation').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const down088 = fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg/rollback/088_message_report_channel_retention.down.sql'), 'utf8');

type Row = Record<string, unknown>;

RUN('real PostgreSQL — reports outlive expired and deleted channels (088)', () => {
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db._pool.query(sql, params)).rows;
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId', moderationRouter);
  const list = (user: string, server = SRV) =>
    request(app).get(`/api/servers/${server}/reports`).set('x-test-user', user);
  const resolve = (user: string, id: string, server = SRV) =>
    request(app).put(`/api/servers/${server}/reports/${id}`).set('x-test-user', user).send({ resolution: 'resolved' });
  let seq = 0;
  const id = (label: string) => `${P}-${label}-${++seq}`;

  async function cleanup() {
    for (const s of [SRV, OTHER_SRV]) {
      await q('DELETE FROM message_reports WHERE "serverId"=$1', [s]);
      await q('DELETE FROM messages WHERE "serverId"=$1', [s]);
      await q('DELETE FROM channel_permissions WHERE "serverId"=$1', [s]);
      await q('DELETE FROM channel_overrides WHERE "channelId" LIKE $1', [`${P}-%`]);
      await q('DELETE FROM channel_expiry_tombstones WHERE "serverId"=$1', [s]);
      await q('DELETE FROM audit_logs WHERE "serverId"=$1', [s]);
      await q('DELETE FROM channels WHERE "serverId"=$1', [s]);
      await q('DELETE FROM roles WHERE "serverId"=$1', [s]);
      await q('DELETE FROM members WHERE "serverId"=$1', [s]);
      await q('DELETE FROM servers WHERE _id=$1', [s]);
    }
    await q('DELETE FROM users WHERE _id LIKE $1', [`${P}-%`]);
  }

  async function channel(label: string, expiring = false): Promise<string> {
    const cid = id(label);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$3,1,$4,$5)',
      [cid, SRV, label, expiring ? Date.now() + 600_000 : null, expiring ? 1 : 0]);
    return cid;
  }
  async function message(channelId: string, text: string): Promise<string> {
    const mid = id('msg');
    await q(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"contentFormat",type,"createdAt")
             VALUES ($1,$2,$3,$4,'author','Abuser',$5,1,'normal',$6)`, [mid, channelId, SRV, AUTHOR, text, Date.now()]);
    return mid;
  }
  async function report(channelId: string, messageId: string): Promise<string> {
    const msg = await Messages.findById(messageId);
    const { row } = await MessageReports.create({
      serverId: SRV, channelId, messageId, reporterId: REPORTER, reason: 'harassment', detail: 'see this',
      evidence: captureReportEvidence(msg),
    });
    return String(row._id);
  }
  const reportRow = async (rid: string) => (await q('SELECT * FROM message_reports WHERE _id=$1', [rid]))[0];
  const expire = (cid: string) => q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [Date.now() - 1000, cid]);
  async function drainExpiry() {
    for (let i = 0; i < 200; i++) {
      const r = await runChannelExpiryTick(db._pool);
      if (!r.claimed.length && !r.converged.length && !r.deleted) return;
    }
  }
  const ids = (res: { body: { reports?: Array<{ id: string }> } }) => (res.body.reports ?? []).map(r => r.id).sort();

  beforeAll(async () => {
    await cleanup();
    for (const u of [OWNER, MOD, ADMIN, CHMOD, MEMBER, REPORTER, AUTHOR, OTHER_OWNER]) {
      await q(`INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$2,'x',1)`, [u, u.replace(/-/g, '_')]);
    }
    await q(`INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,'Retention',$2,1)`, [SRV, OWNER]);
    await q(`INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,'Other',$2,1)`, [OTHER_SRV, OTHER_OWNER]);
    const base = PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;
    await q(`INSERT INTO roles (_id,"serverId",name,permissions,position,"createdAt") VALUES ($1,$2,'mod',$3,2,1),($4,$2,'helper',$5,1,1),($6,$2,'admin',$7,3,1)`,
      [MOD_ROLE, SRV, base | PERMS.MANAGE_MESSAGES, HELPER_ROLE, base, ADMIN_ROLE, base | PERMS.ADMIN]);
    const members: Array<[string, string, string[]]> = [
      [OWNER, SRV, []], [MOD, SRV, [MOD_ROLE]], [ADMIN, SRV, [ADMIN_ROLE]], [CHMOD, SRV, [HELPER_ROLE]], [MEMBER, SRV, [HELPER_ROLE]],
      [REPORTER, SRV, []], [AUTHOR, SRV, []], [OTHER_OWNER, OTHER_SRV, []],
    ];
    for (const [u, s, roles] of members) {
      await q(`INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)`, [u, s, JSON.stringify(roles)]);
    }
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,1)', [KEEP, SRV, 'keep']);
  });
  afterAll(cleanup);

  it('schema: no channel foreign key, server/reporter/resolver keys and the channel queue index remain', async () => {
    const fks = (await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                          WHERE conrelid='message_reports'::regclass AND contype='f'`)).map(r => String(r.def));
    expect(fks.some(d => d.includes('REFERENCES channels'))).toBe(false);
    expect(fks.some(d => d.includes('REFERENCES messages'))).toBe(false);
    expect(fks.filter(d => /REFERENCES servers\(_id\) ON DELETE CASCADE/.test(d))).toHaveLength(1);
    expect(fks.filter(d => /REFERENCES users\(_id\)/.test(d))).toHaveLength(2);
    const idx = (await q(`SELECT indexname FROM pg_indexes WHERE tablename='message_reports'`)).map(r => String(r.indexname));
    expect(idx).toEqual(expect.arrayContaining(['idx_message_reports_channel_open', 'idx_message_reports_server_open', 'idx_message_reports_message']));
  });

  it('channel expiry removes the conversation but keeps open and resolved reports with their evidence', async () => {
    const eph = await channel('eph', true);
    const m1 = await message(eph, 'you are worthless');
    const m2 = await message(eph, 'leave or else');
    await message(eph, 'unreported chatter');
    const open = await report(eph, m1);
    const closed = await report(eph, m2);
    expect((await resolve(OWNER, closed)).status).toBe(200);

    await expire(eph);
    await drainExpiry();
    expect((await q('SELECT 1 FROM channel_expiry_tombstones WHERE "channelId"=$1 AND "cleanupState"=$2', [eph, 'converged'])).length).toBe(1);
    expect(await q('SELECT 1 FROM messages WHERE "channelId"=$1', [eph])).toHaveLength(0);
    expect(await q('SELECT 1 FROM channels WHERE _id=$1', [eph])).toHaveLength(0);

    const o = await reportRow(open);
    const c = await reportRow(closed);
    expect(o).toMatchObject({ channelId: eph, status: 'open', evidenceText: 'you are worthless', evidenceAuthorId: AUTHOR });
    expect(c).toMatchObject({ channelId: eph, status: 'resolved', evidenceText: 'leave or else' });
    // Only the bounded snapshot survives: no conversation, no other message text.
    expect(JSON.stringify(await q('SELECT * FROM message_reports WHERE "channelId"=$1', [eph]))).not.toContain('unreported chatter');
  });

  it('ordinary channel deletion keeps the channel\'s reports; server deletion removes them', async () => {
    const gone = await channel('deleted');
    const rid = await report(gone, await message(gone, 'slur'));
    expect(await Channels.deleteGraphAtomic(gone, SRV)).toBe('deleted');
    expect(await q('SELECT 1 FROM messages WHERE "channelId"=$1', [gone])).toHaveLength(0);
    expect(await reportRow(rid)).toMatchObject({ channelId: gone, evidenceText: 'slur', status: 'open' });

    // A separate server proves deletion of the owning server still removes its reports.
    const tmpServer = id('tmp-srv');
    const tmpChannel = id('tmp-ch');
    const tmpKeep = id('tmp-keep');
    await q(`INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,'Tmp',$2,1)`, [tmpServer, OWNER]);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$3,$1,1),($2,$3,$2,1)', [tmpChannel, tmpKeep, tmpServer]);
    await q(`INSERT INTO message_reports (_id,"serverId","channelId","messageId","reporterId",reason,"createdAt")
             VALUES ($1,$2,$3,'m',$4,'spam',1)`, [id('tmp-report'), tmpServer, tmpChannel, REPORTER]);
    await Servers.deleteGraphAtomic(tmpServer);
    expect(await q('SELECT 1 FROM message_reports WHERE "serverId"=$1', [tmpServer])).toHaveLength(0);
  });

  it('a gone channel nothing hid stays reviewable by server-level moderators only; tenants stay isolated', async () => {
    const live = await channel('override-live');
    // HELPER gets MANAGE_MESSAGES on this one channel only (CHMOD and MEMBER share the role).
    await q(`INSERT INTO channel_permissions (_id,"channelId","roleId","serverId",allow,deny,"createdAt") VALUES ($1,$2,$3,$4,$5,0,1)`,
      [id('override'), live, HELPER_ROLE, SRV, PERMS.MANAGE_MESSAGES]);
    const rid = await report(live, await message(live, 'threat'));
    // While the channel is live the channel moderator sees it.
    expect(ids(await list(CHMOD))).toContain(rid);

    expect(await Channels.deleteGraphAtomic(live, SRV)).toBe('deleted');
    const asOwner = await list(OWNER);
    const entry = asOwner.body.reports.find((r: { id: string }) => r.id === rid);
    expect(entry).toMatchObject({
      channelId: live, channel: { _id: live, name: null, available: false },
      evidence: expect.objectContaining({ state: 'captured', text: 'threat' }),
      message: { preview: '' }, currentState: 'removed',
    });
    expect(ids(await list(ADMIN))).toContain(rid);
    // 090 recorded that no override hid this channel: server-level moderators keep it.
    expect((await reportRow(rid)).channelVisibility).toBe('open');
    expect(ids(await list(MOD))).toContain(rid);
    // The override died with the channel: no channel-level authority remains.
    expect(ids(await list(CHMOD))).not.toContain(rid);
    expect(ids(await list(MEMBER))).not.toContain(rid);
    expect((await resolve(CHMOD, rid)).status).toBe(403);
    expect((await resolve(MEMBER, rid)).status).toBe(403);
    // Another server's owner: not in their queue and not resolvable through their server.
    expect(ids(await list(OTHER_OWNER, OTHER_SRV))).not.toContain(rid);
    expect((await list(OTHER_OWNER)).body.reports ?? []).toHaveLength(0);
    expect((await resolve(OTHER_OWNER, rid, OTHER_SRV)).status).toBe(404);
    expect((await resolve(OTHER_OWNER, rid)).status).toBe(403);
    expect((await reportRow(rid)).status).toBe('open');

    expect((await resolve(MOD, rid)).status).toBe(200);
    expect(await reportRow(rid)).toMatchObject({ status: 'resolved', resolvedBy: MOD, evidenceText: 'threat' });
  });

  it('090: an unrecorded gone channel (gone before 090, or recorded value lost) is ADMIN only', async () => {
    const legacy = await channel('legacy');
    const rid = await report(legacy, await message(legacy, 'legacy evidence'));
    expect(await Channels.deleteGraphAtomic(legacy, SRV)).toBe('deleted');
    await q('UPDATE message_reports SET "channelVisibility"=NULL WHERE _id=$1', [rid]);   // as before 090
    expect(ids(await list(MOD))).not.toContain(rid);
    expect((await resolve(MOD, rid)).status).toBe(403);
    expect(ids(await list(ADMIN))).toContain(rid);
    await expect(q(`UPDATE message_reports SET "channelVisibility"='public' WHERE _id=$1`, [rid])).rejects.toThrow(/channel_visibility_check/);
  });

  it('a private channel\'s reports never reach a moderator it hid, before or after it is gone', async () => {
    const priv = await channel('private');
    // Server-level moderators are denied this channel.
    await q(`INSERT INTO channel_permissions (_id,"channelId","roleId","serverId",allow,deny,"createdAt") VALUES ($1,$2,$3,$4,0,$5,1)`,
      [id('deny'), priv, MOD_ROLE, SRV, PERMS.VIEW_CHANNELS]);
    const rid = await report(priv, await message(priv, 'private secret'));
    const hidden = async () => {
      const res = await list(MOD);
      expect(ids(res)).not.toContain(rid);
      expect(JSON.stringify(res.body)).not.toContain('private secret');
      expect((await resolve(MOD, rid)).status).toBe(403);
    };
    await hidden();                                   // live: no VIEW_CHANNELS there
    expect(ids(await list(OWNER))).toContain(rid);

    await expire(priv);                               // expired, not yet claimed (nothing recorded)
    await hidden();
    await drainExpiry();                              // claimed and cleaned: the override is gone
    expect((await q('SELECT 1 FROM channel_permissions WHERE "channelId"=$1', [priv]))).toHaveLength(0);
    expect((await reportRow(rid)).channelVisibility).toBe('restricted');   // recorded at claim, before the drain
    await hidden();
    expect(ids(await list(ADMIN))).toContain(rid);
    expect((await reportRow(rid)).status).toBe('open');
  });

  it('090: every override the resolver enforces counts — legacy channel_overrides rows and a MANAGE_MESSAGES deny', async () => {
    // Each case hides the channel's reports from MOD while it is live; the
    // recorded visibility must keep them hidden once it is gone.
    const cases: Array<[string, (cid: string) => Promise<unknown>]> = [
      ['legacy-role-deny', (cid) => q(`INSERT INTO channel_overrides (_id,"channelId","targetId","targetType",allow,deny) VALUES ($1,$2,$3,'role',0,$4)`,
        [id('ovr'), cid, MOD_ROLE, PERMS.VIEW_CHANNELS])],
      ['legacy-user-deny', (cid) => q(`INSERT INTO channel_overrides (_id,"channelId","targetId","targetType",allow,deny) VALUES ($1,$2,$3,'user',0,$4)`,
        [id('ovr'), cid, MOD, PERMS.VIEW_CHANNELS])],
      ['manage-deny', (cid) => q(`INSERT INTO channel_permissions (_id,"channelId","roleId","serverId",allow,deny,"createdAt") VALUES ($1,$2,$3,$4,0,$5,1)`,
        [id('deny'), cid, MOD_ROLE, SRV, PERMS.MANAGE_MESSAGES])],
    ];
    for (const [label, hide] of cases) {
      for (const how of ['delete', 'expire'] as const) {
        const cid = await channel(`${label}-${how}`, how === 'expire');
        await hide(cid);
        const rid = await report(cid, await message(cid, `${label} secret`));
        expect(ids(await list(MOD))).not.toContain(rid);          // live: hidden by the override
        if (how === 'delete') expect(await Channels.deleteGraphAtomic(cid, SRV)).toBe('deleted');
        else { await expire(cid); await drainExpiry(); }
        expect((await q('SELECT 1 FROM channel_overrides WHERE "channelId"=$1', [cid]))).toHaveLength(0);
        expect([label, how, (await reportRow(rid)).channelVisibility]).toEqual([label, how, 'restricted']);
        const res = await list(MOD);
        expect(ids(res)).not.toContain(rid);
        expect(JSON.stringify(res.body)).not.toContain(`${label} secret`);
        expect((await resolve(MOD, rid)).status).toBe(403);
        expect(ids(await list(ADMIN))).toContain(rid);
      }
    }
  });

  it('never shows an expired-but-unclaimed channel\'s live rows, only the snapshot', async () => {
    const eph = await channel('unclaimed', true);
    const mid = await message(eph, 'original');
    const rid = await report(eph, mid);
    await q('UPDATE messages SET content=$1 WHERE _id=$2', ['edited after report', mid]);
    await expire(eph);   // no worker tick: the rows are still there
    const res = await list(OWNER);
    const entry = res.body.reports.find((r: { id: string }) => r.id === rid);
    expect(entry).toMatchObject({ channel: { available: false, name: null }, message: { preview: '' },
      evidence: expect.objectContaining({ text: 'original' }) });
    expect(JSON.stringify(res.body)).not.toContain('edited after report');
  });

  it('the retention worker scrubs a gone channel\'s evidence after the window, not before and never while open', async () => {
    const eph = await channel('retention', true);
    const old = await report(eph, await message(eph, 'old abuse'));
    const recent = await report(eph, await message(eph, 'recent abuse'));
    const stillOpen = await report(eph, await message(eph, 'open abuse'));
    for (const r of [old, recent]) expect((await resolve(OWNER, r)).status).toBe(200);
    const now = Date.now();
    await q('UPDATE message_reports SET "resolvedAt"=$1 WHERE _id=$2', [now - 91 * DAY, old]);
    await q('UPDATE message_reports SET "resolvedAt"=$1 WHERE _id=$2', [now - 89 * DAY, recent]);
    await q('UPDATE message_reports SET "createdAt"=$1 WHERE _id=$2', [now - 400 * DAY, stillOpen]);
    await expire(eph);
    await drainExpiry();

    await runReportEvidenceRetentionTick(now);
    const o = await reportRow(old);
    expect(o).toMatchObject({ status: 'resolved', evidenceText: null, evidenceAuthorId: null, evidenceAuthorName: null,
      evidenceFileName: null, reason: 'harassment', reporterId: REPORTER, channelId: eph });
    expect(Number(o.evidenceScrubbedAt)).toBeGreaterThan(0);
    expect(await reportRow(recent)).toMatchObject({ evidenceText: 'recent abuse', evidenceScrubbedAt: null });
    expect(await reportRow(stillOpen)).toMatchObject({ status: 'open', evidenceText: 'open abuse', evidenceScrubbedAt: null });
  });

  it('author erasure anonymizes a gone channel\'s snapshot; reporter erasure removes the report', async () => {
    const author2 = id('author2');
    const reporter2 = id('reporter2');
    for (const u of [author2, reporter2]) {
      await q(`INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,'x',1)`, [u]);
      await q(`INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,'[]',1)`, [u, SRV]);
    }
    const eph = await channel('erasure', true);
    const mid = id('msg');
    await q(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"contentFormat",type,"createdAt")
             VALUES ($1,$2,$3,$4,'a2','Author Two','abusive text',1,'normal',1)`, [mid, eph, SRV, author2]);
    const byReporter2 = String((await MessageReports.create({
      serverId: SRV, channelId: eph, messageId: mid, reporterId: reporter2, reason: 'hate', detail: '',
      evidence: captureReportEvidence(await Messages.findById(mid)),
    })).row._id);
    const byReporter = await report(eph, mid);
    await expire(eph);
    await drainExpiry();

    // The 085 trigger runs in the same transaction as the user delete, on every node.
    await q('DELETE FROM members WHERE "userId"=$1', [author2]);
    await q('DELETE FROM users WHERE _id=$1', [author2]);
    expect(await reportRow(byReporter)).toMatchObject({ evidenceAuthorId: 'deleted-user', evidenceAuthorName: '',
      evidenceText: 'abusive text' });

    await q('DELETE FROM members WHERE "userId"=$1', [reporter2]);
    await q('DELETE FROM users WHERE _id=$1', [reporter2]);
    expect(await reportRow(byReporter2)).toBeUndefined();
  });

  it('088 down refuses while a report points at a missing channel', async () => {
    const client = await db._pool.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(down088)).rejects.toThrow(/Cannot roll back 088/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const fks = await q(`SELECT 1 FROM pg_constraint WHERE conrelid='message_reports'::regclass AND conname='message_reports_channelId_fkey'`);
    expect(fks).toHaveLength(0);
  });
});
