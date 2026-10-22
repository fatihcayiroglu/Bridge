// server/tests/pg-integration/report-evidence.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL — P7 B5 (#336) evidence-safe message reports, migration 085
// ════════════════════════════════════════════════════════════════════════════
// What only a real database can show:
//   · the schema: evidence columns, bounds and lifecycle CHECKs, no message FK;
//   · an administrator's account purge (hard DELETE of the member's messages)
//     no longer erases the reports against them — it used to, by ON DELETE CASCADE;
//   · account erasure anonymizes the reported author in the snapshot, keeps the text;
//   · the retention scrub satisfies the lifecycle CHECK (a partial scrub is refused);
//   · the reporter's personal-data export does not contain the reported message;
//   · the rollback refuses to destroy evidence or orphaned reports.
// Runs only with PG_TEST_URL; removes its own rows.

const P = 'pgt-rev';
const MOD = `${P}-mod`;
const REPORTER = `${P}-reporter`;
const AUTHOR = `${P}-author`;
const SRV = `${P}-srv`;
const CH = `${P}-ch`;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown; headers: Record<string, string | undefined> }, _res: unknown, next: () => void) => {
    req.user = { id: req.headers['x-test-user'] };
    next();
  },
  _invalidateTokenCache: () => undefined,
}));
jest.mock('../../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
// The export's step-up gate has its own suites; here only the exported columns matter.
jest.mock('../../lib/stepUp', () => ({
  ...jest.requireActual('../../lib/stepUp'),
  requireStepUp: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { Client } from 'pg';
import { captureReportEvidence } from '../../lib/reportEvidence';
import { eraseAccountData, type TransactionRunner } from '../../lib/accountDeletion';
import { TOMBSTONE_USER_ID } from '../../lib/accountLifecycle';

const db = require('../../db/loader').default;
const MessageReports = require('../../db/repositories/MessageReportRepository').default;
const Messages = require('../../db/repositories').Messages;
const accountRouter = require('../../routes/account').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const dir = path.resolve(__dirname, '../../db/migrations_pg');
const down = fs.readFileSync(path.join(dir, 'rollback/085_message_report_evidence.down.sql'), 'utf8');

RUN('real PostgreSQL — P7 B5 evidence-safe message reports (085)', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;

  const cleanup = async () => {
    await q(`DELETE FROM messages WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM channels WHERE _id LIKE $1`, [`${P}-%`]);   // reports cascade from the channel
    await q(`DELETE FROM members WHERE "serverId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [`${P}-%`]);
  };

  async function insertMessage(id: string, userId: string, content: string, extra: Record<string, unknown> = {}) {
    await q(
      `INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "contentFormat", type, "createdAt", "encryptedContent")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10)`,
      [id, CH, SRV, userId, String(extra.username ?? 'author'), String(extra.displayName ?? 'Abuser'), content,
        String(extra.type ?? 'normal'), Number(extra.createdAt ?? 1000), extra.encryptedContent ?? null],
    );
    return Messages.findById(id);
  }

  async function fileReport(messageId: string): Promise<string> {
    const msg = await Messages.findById(messageId);
    const { row } = await MessageReports.create({
      serverId: SRV, channelId: CH, messageId, reporterId: REPORTER, reason: 'harassment', detail: 'please look',
      evidence: captureReportEvidence(msg),
    });
    return String(row._id);
  }

  beforeAll(async () => {
    await cleanup();
    for (const [id, name] of [[MOD, 'Moderator'], [REPORTER, 'Reporter'], [AUTHOR, 'Abuser']]) {
      await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $2, $3, 'x', 1)`,
        [id, id.replace(/-/g, '_'), name]);
    }
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'Evidence', $2, 1)`, [SRV, MOD]);
    await q(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1, $2, 'general', 1)`, [CH, SRV]);
    for (const id of [MOD, REPORTER, AUTHOR]) {
      await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', 1)`, [id, SRV]);
    }
  });

  afterAll(async () => {
    await cleanup();
    try { await db._pool.end(); } catch { /* already closed */ }
  });

  it('schema: evidence columns exist and the message foreign key is gone', async () => {
    const cols = (await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'message_reports' AND column_name LIKE 'evidence%'`,
    )).map((r: { column_name: string }) => r.column_name).sort();
    expect(cols).toEqual([
      'evidenceAuthorId', 'evidenceAuthorName', 'evidenceCapturedAt', 'evidenceFileName', 'evidenceFileType',
      'evidenceMessageCreatedAt', 'evidenceMessageEditedAt', 'evidenceMessageType', 'evidenceScrubbedAt',
      'evidenceText', 'evidenceTextTruncated',
    ]);
    const fks = (await q(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'message_reports'::regclass AND contype = 'f'`,
    )).map((r: { def: string }) => r.def);
    expect(fks.some((d: string) => d.includes('REFERENCES messages'))).toBe(false);
    // Migration 088 (P7 D2): the channel key is gone too, so reports outlive an
    // expired or deleted channel. Server, reporter and resolver keys are unchanged.
    expect(fks.some((d: string) => d.includes('REFERENCES channels'))).toBe(false);
    expect(fks.filter((d: string) => /REFERENCES (servers|users)/.test(d))).toHaveLength(3);
  });

  it('an administrator purge of the author no longer erases the reports against them', async () => {
    const id = `${P}-m-purge`;
    await insertMessage(id, AUTHOR, 'raid spam that got the member purged');
    const reportId = await fileReport(id);

    const transaction = db._transaction as TransactionRunner;
    const { applied } = await eraseAccountData(db._pool, transaction, AUTHOR, { purgeChannelMessages: true });
    expect(applied.find(a => a.disposition === 'PURGE_BY_ADMIN')?.rows).toBeGreaterThanOrEqual(1);
    expect(await q(`SELECT 1 FROM messages WHERE _id = $1`, [id])).toHaveLength(0);

    const [row] = await q(`SELECT * FROM message_reports WHERE _id = $1`, [reportId]);
    expect(row).toBeDefined();
    expect(row.messageId).toBe(id);
    expect(row.evidenceText).toBe('raid spam that got the member purged');
    // Erasure anonymized the reported author in the snapshot (same policy as messages).
    expect(row.evidenceAuthorId).toBe(TOMBSTONE_USER_ID);
    expect(row.evidenceAuthorName).toBe('');

    // The author row is gone; put it back for the cases below.
    await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, 'pgt_rev_author', 'Abuser', 'x', 1)`, [AUTHOR]);
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', 1)`, [AUTHOR, SRV]);
  });

  it('an encrypted message is stored without its ciphertext', async () => {
    const id = `${P}-m-e2ee`;
    await insertMessage(id, AUTHOR, '', { type: 'e2ee', encryptedContent: 'PG-CIPHERTEXT' });
    const reportId = await fileReport(id);
    const [row] = await q(`SELECT * FROM message_reports WHERE _id = $1`, [reportId]);
    expect(row.evidenceText).toBe('');
    expect(row.evidenceMessageType).toBe('e2ee');
    expect(JSON.stringify(row)).not.toContain('PG-CIPHERTEXT');
  });

  it.each(['bot:pgt-rev-machine', 'webhook:pgt-rev-machine', 'bridge:pgt-rev-machine', 'crosspost:pgt-rev-machine', 'ap:pgt-rev-machine', 'system'])(
    'a machine principal without a users row keeps its attribution: %s', async principal => {
      const id = `${P}-m-${principal.replace(':', '-')}`;
      const msg = await insertMessage(id, principal, 'machine evidence');
      const { row } = await MessageReports.create({
        serverId: SRV, channelId: CH, messageId: id, reporterId: REPORTER,
        reason: 'spam', detail: '', evidence: captureReportEvidence(msg),
      });
      expect(row.evidenceAuthorId).toBe(principal);
      expect(row.evidenceAuthorName).toBe('Abuser');
    },
  );

  it('the CHECKs refuse oversized evidence and a partial scrub', async () => {
    const id = `${P}-m-check`;
    await insertMessage(id, AUTHOR, 'bounded');
    const reportId = await fileReport(id);
    await expect(q(`UPDATE message_reports SET "evidenceText" = repeat('x', 4001) WHERE _id = $1`, [reportId]))
      .rejects.toThrow(/message_reports_evidence_bounds_check/);
    await expect(q(`UPDATE message_reports SET "evidenceScrubbedAt" = 5 WHERE _id = $1`, [reportId]))
      .rejects.toThrow(/message_reports_evidence_lifecycle_check/);
    await expect(q(`UPDATE message_reports SET "evidenceCapturedAt" = NULL WHERE _id = $1`, [reportId]))
      .rejects.toThrow(/message_reports_evidence_lifecycle_check/);
  });

  it('retention clears only reports resolved before the cutoff, within the CHECKs', async () => {
    const oldId = `${P}-m-old`;
    const openId = `${P}-m-open`;
    await insertMessage(oldId, AUTHOR, 'resolved long ago');
    await insertMessage(openId, AUTHOR, 'still open');
    const oldReport = await fileReport(oldId);
    const openReport = await fileReport(openId);
    await q(`UPDATE message_reports SET status = 'resolved', resolution = 'resolved', "resolvedAt" = 100, "resolvedBy" = $2 WHERE _id = $1`,
      [oldReport, MOD]);

    expect(await MessageReports.scrubEvidenceResolvedBefore(200, 300)).toBeGreaterThanOrEqual(1);
    const [old] = await q(`SELECT * FROM message_reports WHERE _id = $1`, [oldReport]);
    expect(old).toMatchObject({ evidenceText: null, evidenceAuthorId: null, evidenceAuthorName: null, status: 'resolved' });
    expect(Number(old.evidenceScrubbedAt)).toBe(300);
    expect(Number(old.evidenceCapturedAt)).toBeGreaterThan(0);
    const [open] = await q(`SELECT * FROM message_reports WHERE _id = $1`, [openReport]);
    expect(open.evidenceText).toBe('still open');
    expect(await MessageReports.scrubEvidenceResolvedBefore(200, 400)).toBe(0);
  });

  it("the reporter's personal-data export has their reports without the reported message", async () => {
    const id = `${P}-m-export`;
    await insertMessage(id, AUTHOR, 'EXPORT-SHOULD-NOT-CONTAIN-THIS');
    await fileReport(id);
    const app = express();
    app.use(express.json());
    app.use('/api/account', accountRouter);
    const res = await request(app).get('/api/account/export').set('x-test-user', REPORTER);
    expect(res.status).toBe(200);
    const reports = res.body.data.messageReports as Array<Record<string, unknown>>;
    expect(reports.some(r => r.messageId === id && r.reason === 'harassment' && r.detail === 'please look')).toBe(true);
    for (const r of reports) expect(Object.keys(r).filter(k => k.startsWith('evidence'))).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('EXPORT-SHOULD-NOT-CONTAIN-THIS');
  });

  async function raceAuthor(suffix: string): Promise<{ userId: string; messageId: string; evidence: ReturnType<typeof captureReportEvidence> }> {
    const userId = `${P}-race-${suffix}`;
    const messageId = `${P}-m-race-${suffix}`;
    await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $2, 'Race Author', 'x', 1)`,
      [userId, userId.replace(/-/g, '_')]);
    const msg = await insertMessage(messageId, userId, 'race evidence');
    return { userId, messageId, evidence: captureReportEvidence(msg) };
  }

  function raceInput(messageId: string, evidence: ReturnType<typeof captureReportEvidence>) {
    return { serverId: SRV, channelId: CH, messageId, reporterId: REPORTER,
      reason: 'harassment' as const, detail: 'race', evidence };
  }

  async function waitForBlocked(queryFragment: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await q(
        `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND query LIKE $1 AND cardinality(pg_blocking_pids(pid)) > 0`,
        [`%${queryFragment}%`]);
      if (rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Expected PostgreSQL row-lock wait: ${queryFragment}`);
  }

  function expectErasedEvidence(row: Record<string, unknown>, userId: string): void {
    expect(row.evidenceText).toBe('race evidence');
    expect(row.evidenceAuthorId).toBe(TOMBSTONE_USER_ID);
    expect(row.evidenceAuthorName).toBe('');
    expect(JSON.stringify({ id: row.evidenceAuthorId, name: row.evidenceAuthorName })).not.toContain(userId);
  }

  it('erasure gets the user lock first: a blocked report writes no stale human identity, including on retry', async () => {
    const { userId, messageId, evidence } = await raceAuthor('erase-first');
    let unlock!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const transaction: TransactionRunner = async fn => {
      const client = new Client({ connectionString: PG_URL });
      await client.connect();
      await client.query('BEGIN');
      try {
        const result = await fn({
          query: async (sql: string, params?: unknown[]) => {
            const answer = await client.query(sql, params);
            if (sql.includes('FOR UPDATE')) { locked(); await held; }
            return answer;
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { await client.end(); }
    };
    const erasure = eraseAccountData(db._pool, transaction, userId);
    await acquired;
    const report = MessageReports.create(raceInput(messageId, evidence));
    await waitForBlocked('FOR SHARE');
    unlock();
    await erasure;
    const created = await report;
    expectErasedEvidence(created.row, userId);
    const retried = await MessageReports.create(raceInput(messageId, evidence));
    expect(retried.created).toBe(false);
    expectErasedEvidence(retried.row, userId);
  });

  it('report gets the user lock first: erasure waits, then scrubs the committed report', async () => {
    const { userId, messageId, evidence } = await raceAuthor('report-first');
    const holder = new Client({ connectionString: PG_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT _id FROM users WHERE _id = $1 FOR SHARE', [userId]);
      const erasure = eraseAccountData(db._pool, db._transaction as TransactionRunner, userId);
      await waitForBlocked('FOR UPDATE');
      const created = await MessageReports.create(raceInput(messageId, evidence));
      expect(created.row.evidenceAuthorId).toBe(userId);
      await holder.query('COMMIT');
      await erasure;
      const [row] = await q(`SELECT * FROM message_reports WHERE _id = $1`, [created.row._id]);
      expectErasedEvidence(row, userId);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  });

  it('a crashed erasure rolls back; an older node deleting the user later still scrubs committed evidence', async () => {
    const { userId, messageId, evidence } = await raceAuthor('crash');
    const holder = new Client({ connectionString: PG_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT _id FROM users WHERE _id = $1 FOR UPDATE', [userId]);
    const report = MessageReports.create(raceInput(messageId, evidence));
    await waitForBlocked('FOR SHARE');
    await holder.end(); // connection loss aborts the uncommitted erasure and releases its lock
    const created = await report;
    expect(created.row.evidenceAuthorId).toBe(userId); // account still exists
    await q(`DELETE FROM users WHERE _id = $1`, [userId]); // older application node, unaware of evidence columns
    const [row] = await q(`SELECT * FROM message_reports WHERE _id = $1`, [created.row._id]);
    expectErasedEvidence(row, userId);
  });

  describe('rollback 085 fails closed', () => {
    async function inDisposableTransaction(body: (client: Client) => Promise<void>): Promise<void> {
      const client = new Client({ connectionString: PG_URL });
      await client.connect();
      try {
        await client.query('BEGIN');
        try { await body(client); } finally { await client.query('ROLLBACK'); }
      } finally {
        await client.end();
      }
    }

    it('refuses while any report holds evidence', async () => {
      await inDisposableTransaction(async client => {
        const n = await client.query(`SELECT count(*)::int AS n FROM message_reports WHERE "evidenceCapturedAt" IS NOT NULL`);
        expect(n.rows[0].n).toBeGreaterThan(0);
        await expect(client.query(down)).rejects.toThrow(/hold captured evidence/);
      });
    });

    it('refuses while a report points at a message that no longer exists', async () => {
      await inDisposableTransaction(async client => {
        await client.query(`DELETE FROM message_reports WHERE "evidenceCapturedAt" IS NOT NULL OR "evidenceScrubbedAt" IS NOT NULL`);
        await client.query(
          `INSERT INTO message_reports (_id, "serverId", "channelId", "messageId", "reporterId", reason, "createdAt")
           VALUES ($1, $2, $3, $4, $5, 'spam', 1)`,
          [`${P}-orphan`, SRV, CH, `${P}-never-existed`, REPORTER],
        );
        await expect(client.query(down)).rejects.toThrow(/no longer exist/);
      });
    });

    it('reverses cleanly when nothing would be lost, restoring the CASCADE foreign key', async () => {
      await inDisposableTransaction(async client => {
        await client.query(`DELETE FROM message_reports r WHERE "evidenceCapturedAt" IS NOT NULL OR "evidenceScrubbedAt" IS NOT NULL
                              OR NOT EXISTS (SELECT 1 FROM messages m WHERE m._id = r."messageId")`);
        await client.query(down);
        const cols = await client.query(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name = 'message_reports' AND column_name LIKE 'evidence%'`,
        );
        expect(cols.rows[0].n).toBe(0);
        const fk = await client.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'message_reports'::regclass AND conname = 'message_reports_messageId_fkey'`,
        );
        expect(fk.rows[0]?.def).toBe('FOREIGN KEY ("messageId") REFERENCES messages(_id) ON DELETE CASCADE');
      });
    });
  });
});
