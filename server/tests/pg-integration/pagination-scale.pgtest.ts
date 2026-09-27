// Real PostgreSQL scale/cursor evidence. This suite is intentionally outside
// the default unit gate; run it against a disposable database with PG_TEST_URL.

import crypto from 'crypto';

const RUN = process.env.PG_TEST_URL ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = require('../../db/loader').default;
import { Members, Messages, Servers } from '../../db/repositories';

const runId = `page_${crypto.randomBytes(6).toString('hex')}`;
const ownerId = `${runId}_owner`;
const messageServerId = `${runId}_message_server`;
const channelId = `${runId}_channel`;
const memberServerId = `${runId}_member_server`;
const listUserId = `${runId}_list_user`;
const MESSAGE_COUNT = 10_000;
const BACKGROUND_MESSAGE_COUNT = 90_000;
const MEMBER_COUNT = 5_000;
const SERVER_COUNT = 1_000;
const PAGE_SIZE = 100;

async function q(sql: string, params: unknown[] = []) {
  return db._pool.query(sql, params);
}

function planText(result: { rows: Array<Record<string, unknown>> }): string {
  return JSON.stringify(result.rows[0]?.['QUERY PLAN'] ?? null);
}

function planMetrics(result: { rows: Array<Record<string, unknown>> }) {
  const raw = result.rows[0]?.['QUERY PLAN'];
  const document = Array.isArray(raw) && raw[0] && typeof raw[0] === 'object'
    ? raw[0] as Record<string, unknown>
    : {};
  const plan = document.Plan && typeof document.Plan === 'object'
    ? document.Plan as Record<string, unknown>
    : {};
  return {
    rootNode: String(plan['Node Type'] ?? 'unknown'),
    planningMs: Number(document['Planning Time'] ?? 0),
    executionMs: Number(document['Execution Time'] ?? 0),
  };
}

RUN('real PostgreSQL — deterministic pagination at scale', () => {
  beforeAll(async () => {
    const timestamp = Date.now();
    await q(
      'INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1,$2,$3,$4,$5)',
      [listUserId, `${runId}_list_user`, 'List User', 'x', timestamp],
    );
    await q(
      'INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1,$2,$3,$4),($5,$6,$3,$4)',
      [messageServerId, 'Message Scale', ownerId, timestamp, memberServerId, 'Member Scale'],
    );
    await q(
      'INSERT INTO channels (_id, "serverId", name, type, "createdAt") VALUES ($1,$2,$3,$4,$5)',
      [channelId, messageServerId, 'scale', 'text', timestamp],
    );
  });

  afterAll(async () => {
    await q('DELETE FROM messages WHERE "serverId" = $1', [messageServerId]).catch(() => {});
    await q('DELETE FROM channels WHERE "serverId" = $1', [messageServerId]).catch(() => {});
    await q('DELETE FROM servers WHERE _id LIKE $1', [`${runId}%`]).catch(() => {});
    await q('DELETE FROM users WHERE _id LIKE $1', [`${runId}%`]).catch(() => {});
    try { await db._pool.end(); } catch { /* already closed */ }
  });

  it('walks 10,000 same-timestamp-burst messages exactly once', async () => {
    const base = Date.now() - 1_000_000;
    const seedStart = performance.now();
    await q(
      `INSERT INTO messages
         (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
       SELECT $1 || '_m_' || lpad(i::text, 5, '0'), $2, $3, $4, 'scale', 'Scale',
              'message ' || i,
              $5::bigint + floor((i - 1) / 137)::bigint
         FROM generate_series(1, $6::int) AS i`,
      [runId, channelId, messageServerId, ownerId, base, MESSAGE_COUNT],
    );
    // Real tables contain many channels. Without background traffic a global
    // createdAt index can look artificially cheap because every row matches
    // the target channel, which is not the production selectivity regime.
    await q(
      `INSERT INTO messages
         (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
       SELECT $1 || '_background_' || lpad(i::text, 5, '0'),
              $1 || '_background_channel_' || (i % 50),
              $2, $3, 'scale', 'Scale', 'background ' || i,
              $4::bigint + (i % 74)::bigint
         FROM generate_series(1, $5::int) AS i`,
      [runId, messageServerId, ownerId, base, BACKGROUND_MESSAGE_COUNT],
    );
    await q('ANALYZE messages');
    const seedMs = performance.now() - seedStart;

    const seen = new Set<string>();
    const pageTimes: number[] = [];
    const pageBytes: number[] = [];
    let cursor: { before: number; beforeId: string } | undefined;
    let pages = 0;
    for (;;) {
      const started = performance.now();
      const page = await Messages.findByChannel(channelId, {
        limit: PAGE_SIZE,
        before: cursor?.before,
        beforeId: cursor?.beforeId,
      });
      pageTimes.push(performance.now() - started);
      if (!page.length) break;
      pageBytes.push(Buffer.byteLength(JSON.stringify(page), 'utf8'));
      pages++;
      for (const row of page) {
        expect(seen.has(String(row._id))).toBe(false);
        seen.add(String(row._id));
      }
      const oldest = page[0];
      cursor = { before: Number(oldest.createdAt), beforeId: String(oldest._id) };
    }

    expect(seen.size).toBe(MESSAGE_COUNT);
    expect(pages).toBe(Math.ceil(MESSAGE_COUNT / PAGE_SIZE));
    const sortedTimes = [...pageTimes].sort((a, b) => a - b);
    const p95 = sortedTimes[Math.ceil(sortedTimes.length * 0.95) - 1] ?? 0;

    const boundaryId = `${runId}_m_09950`;
    const boundary = await q('SELECT "createdAt" FROM messages WHERE _id = $1', [boundaryId]);
    const explain = await q(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT * FROM messages
        WHERE "channelId" = $1
          AND ("createdAt" < $2 OR ("createdAt" = $2 AND _id < $3))
        ORDER BY "createdAt" DESC, _id DESC
        LIMIT 100`,
      [channelId, boundary.rows[0].createdAt, boundaryId],
    );
    const plan = planText(explain);
    const metrics = planMetrics(explain);
    expect(plan).toContain('idx_messages_channel_cursor');
    expect(plan).not.toContain('Seq Scan');

    console.log('[pagination-scale]', JSON.stringify({
      case: 'messages', rows: seen.size, pages, pageSize: PAGE_SIZE,
      tableRows: MESSAGE_COUNT + BACKGROUND_MESSAGE_COUNT,
      seedMs: Number(seedMs.toFixed(2)), p95PageMs: Number(p95.toFixed(2)),
      maxPageBytes: Math.max(...pageBytes),
      planRoot: metrics.rootNode,
      planPlanningMs: Number(metrics.planningMs.toFixed(3)),
      planExecutionMs: Number(metrics.executionMs.toFixed(3)),
      index: 'idx_messages_channel_cursor',
    }));
  });

  it('walks 5,000 active members exactly once, excludes banned rows, and uses the composite index', async () => {
    const base = Date.now() - 500_000;
    const seedStart = performance.now();
    await q(
      `INSERT INTO users (_id, username, "displayName", password, "createdAt")
       SELECT $1 || '_member_' || lpad(i::text, 5, '0'),
              $1 || '_member_' || lpad(i::text, 5, '0'), 'Member', 'x', $2::bigint
         FROM generate_series(1, $3::int) AS i`,
      [runId, base, MEMBER_COUNT],
    );
    await q(
      `INSERT INTO users (_id, username, "displayName", password, "createdAt")
       SELECT $1 || '_banned_' || lpad(i::text, 3, '0'),
              $1 || '_banned_' || lpad(i::text, 3, '0'), 'Banned', 'x', $2::bigint
         FROM generate_series(1, 50) AS i`,
      [runId, base],
    );
    await q(
      `INSERT INTO members ("userId", "serverId", roles, "joinedAt", banned)
       SELECT $1 || '_member_' || lpad(i::text, 5, '0'), $2, '[]'::jsonb,
              $3::bigint + floor((i - 1) / 211)::bigint, FALSE
         FROM generate_series(1, $4::int) AS i`,
      [runId, memberServerId, base, MEMBER_COUNT],
    );
    await q(
      `INSERT INTO members ("userId", "serverId", roles, "joinedAt", banned)
       SELECT $1 || '_banned_' || lpad(i::text, 3, '0'), $2, '[]'::jsonb, $3::bigint, TRUE
         FROM generate_series(1, 50) AS i`,
      [runId, memberServerId, base - 1],
    );
    await q('ANALYZE members');
    const seedMs = performance.now() - seedStart;

    const seen = new Set<string>();
    const pageTimes: number[] = [];
    const pageBytes: number[] = [];
    let cursor: { joinedAt: number; userId: string } | undefined;
    let pages = 0;
    for (;;) {
      const started = performance.now();
      const raw = await Members.findPageByServer(memberServerId, { limit: PAGE_SIZE + 1, cursor });
      pageTimes.push(performance.now() - started);
      const hasMore = raw.length > PAGE_SIZE;
      const page = hasMore ? raw.slice(0, PAGE_SIZE) : raw;
      if (!page.length) break;
      pageBytes.push(Buffer.byteLength(JSON.stringify(page), 'utf8'));
      pages++;
      for (const row of page) {
        expect(seen.has(String(row.userId))).toBe(false);
        seen.add(String(row.userId));
        expect(row.banned).toBe(false);
      }
      const boundary = page[page.length - 1];
      cursor = { joinedAt: Number(boundary.joinedAt), userId: String(boundary.userId) };
      if (!hasMore) break;
    }

    expect(seen.size).toBe(MEMBER_COUNT);
    expect(pages).toBe(Math.ceil(MEMBER_COUNT / PAGE_SIZE));
    const sortedTimes = [...pageTimes].sort((a, b) => a - b);
    const p95 = sortedTimes[Math.ceil(sortedTimes.length * 0.95) - 1] ?? 0;

    const explain = await q(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT * FROM members
        WHERE "serverId" = $1 AND banned = FALSE
          AND ("joinedAt", "userId") > ($2::bigint, $3::text)
        ORDER BY "joinedAt" ASC, "userId" ASC
        LIMIT 101`,
      [memberServerId, base, `${runId}_member_00100`],
    );
    const plan = planText(explain);
    const metrics = planMetrics(explain);
    expect(plan).toContain('idx_members_server_page');
    expect(plan).not.toContain('Seq Scan');

    console.log('[pagination-scale]', JSON.stringify({
      case: 'members', rows: seen.size, bannedExcluded: 50, pages, pageSize: PAGE_SIZE,
      seedMs: Number(seedMs.toFixed(2)), p95PageMs: Number(p95.toFixed(2)),
      maxPageBytes: Math.max(...pageBytes),
      planRoot: metrics.rootNode,
      planPlanningMs: Number(metrics.planningMs.toFixed(3)),
      planExecutionMs: Number(metrics.executionMs.toFixed(3)),
      index: 'idx_members_server_page',
    }));
  });

  it('returns a 1,000-server membership list without truncation', async () => {
    const started = performance.now();
    await q(
      `INSERT INTO servers (_id, name, "ownerId", "createdAt")
       SELECT $1 || '_list_server_' || lpad(i::text, 4, '0'), 'List ' || i, $2, $3::bigint + i
         FROM generate_series(1, $4::int) AS i`,
      [runId, ownerId, Date.now() - SERVER_COUNT, SERVER_COUNT],
    );
    await q(
      `INSERT INTO members ("userId", "serverId", roles, "joinedAt", banned)
       SELECT $1, $2 || '_list_server_' || lpad(i::text, 4, '0'), '[]'::jsonb, $3::bigint + i, FALSE
         FROM generate_series(1, $4::int) AS i`,
      [listUserId, runId, Date.now() - SERVER_COUNT, SERVER_COUNT],
    );
    await q('ANALYZE members');
    await q('ANALYZE servers');
    const seedMs = performance.now() - started;

    const queryStart = performance.now();
    const servers = await Servers.findJoinedByUser(listUserId);
    const queryMs = performance.now() - queryStart;
    expect(servers).toHaveLength(SERVER_COUNT);
    expect(new Set(servers.map(server => server._id)).size).toBe(SERVER_COUNT);

    console.log('[pagination-scale]', JSON.stringify({
      case: 'server-list', rows: servers.length,
      seedMs: Number(seedMs.toFixed(2)), queryMs: Number(queryMs.toFixed(2)),
    }));
  });

  it('has both migration-060 cursor indexes with the intended definitions', async () => {
    const result = await q(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [['idx_members_server_page', 'idx_messages_channel_cursor']],
    );
    expect(result.rows).toHaveLength(2);
    const definitions = Object.fromEntries(result.rows.map(row => [row.indexname, row.indexdef]));
    expect(definitions.idx_messages_channel_cursor).toContain('"channelId", "createdAt" DESC, _id DESC');
    expect(definitions.idx_members_server_page).toContain('"serverId", "joinedAt", "userId"');
    expect(definitions.idx_members_server_page).not.toContain('WHERE');
  });
});
