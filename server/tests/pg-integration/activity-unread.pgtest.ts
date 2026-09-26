// server/tests/pg-integration/activity-unread.pgtest.ts
//
// Final21 Phase 15 — the unread channel snapshot query on REAL PostgreSQL.
// (db/queries/activityUnread.ts; route: GET /api/notification-prefs/unread-channels.)
//
// Every rule the query encodes is a row here, with a channel that must and one that
// must not be reported. Runs only with PG_TEST_URL; removes its own rows.

import { ACTIVITY_UNREAD_SQL, MESSAGE_CHANNEL_TYPES, queryActivityUnreadChannels } from '../../db/queries/activityUnread';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-unr';
const ME = `${P}-me`;
const OTHER = `${P}-other`;
const JOINED = 1_000;

RUN('gerçek PostgreSQL — okunmamış kanal etkinliği', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = async () => {
    await q(`DELETE FROM channel_read_positions WHERE "userId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM messages WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM channels WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM members WHERE "userId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [`${P}-%`]);
  };
  const channel = (id: string, serverId: string, type = 'text') =>
    q(`INSERT INTO channels (_id, "serverId", name, type, "createdAt") VALUES ($1, $2, $1, $3, 1)`, [`${P}-${id}`, serverId, type]);
  const message = (id: string, channelId: string, userId: string, createdAt: number, deletedAt: number | null = null) =>
    q(
      `INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt", "deletedAt")
       VALUES ($1, $2, $3, $4, 'u', 'U', 'm', $5, $6)`,
      [`${P}-${id}`, `${P}-${channelId}`, `${P}-srv`, userId, createdAt, deletedAt],
    );

  beforeAll(async () => {
    await cleanup();
    for (const id of [ME, OTHER]) {
      await q(`INSERT INTO users (_id, username, password, "displayName", "createdAt") VALUES ($1, $1, 'x', 'u', 1)`, [id]);
    }
    for (const srv of ['srv', 'banned-srv', 'not-member-srv']) {
      await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, $1, $2, 1)`, [`${P}-${srv}`, OTHER]);
    }
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', $3)`, [ME, `${P}-srv`, JOINED]);
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt", banned) VALUES ($1, $2, '[]', $3, TRUE)`, [ME, `${P}-banned-srv`, JOINED]);

    // Reported:
    await channel('new-since-join', `${P}-srv`);           await message('a1', 'new-since-join', OTHER, JOINED + 5);
    await channel('newer-than-cursor', `${P}-srv`);        await message('b1', 'newer-than-cursor', OTHER, 2_000); await message('b2', 'newer-than-cursor', OTHER, 3_000);
    await channel('announcement', `${P}-srv`, 'announcement'); await message('c1', 'announcement', OTHER, 2_000);
    await channel('same-time-later-id', `${P}-srv`);       await message('d1', 'same-time-later-id', OTHER, 2_000); await message('d2', 'same-time-later-id', OTHER, 2_000);
    // Not reported:
    await channel('before-join', `${P}-srv`);              await message('e1', 'before-join', OTHER, JOINED - 1);
    await channel('only-mine', `${P}-srv`);                await message('f1', 'only-mine', ME, 5_000);
    await channel('read-to-latest', `${P}-srv`);           await message('g1', 'read-to-latest', OTHER, 2_000);
    await channel('only-deleted', `${P}-srv`);             await message('h1', 'only-deleted', OTHER, 2_000, 2_500);
    await channel('voice', `${P}-srv`, 'voice');           await message('i1', 'voice', OTHER, 2_000);
    await channel('banned-server-channel', `${P}-banned-srv`); await message('j1', 'banned-server-channel', OTHER, 2_000);
    await channel('not-member-channel', `${P}-not-member-srv`); await message('k1', 'not-member-channel', OTHER, 2_000);
    await channel('mine-after-cursor', `${P}-srv`);        await message('l1', 'mine-after-cursor', OTHER, 2_000); await message('l2', 'mine-after-cursor', ME, 4_000);

    const cursor = (channelId: string, at: number, messageId: string) =>
      q(`INSERT INTO channel_read_positions ("userId", "channelId", "lastReadAt", "lastReadMessageId", "updatedAt") VALUES ($1, $2, $3, $4, 1)`,
        [ME, `${P}-${channelId}`, at, `${P}-${messageId}`]);
    await cursor('newer-than-cursor', 2_000, 'b1');
    await cursor('read-to-latest', 2_000, 'g1');
    await cursor('same-time-later-id', 2_000, 'd1');
    await cursor('mine-after-cursor', 2_000, 'l1');
  });

  afterAll(cleanup);

  it('reports exactly the channels with unseen messages from others', async () => {
    const rows = await queryActivityUnreadChannels(db._pool, ME);
    const ids = rows.map((row) => row.channelId.replace(`${P}-`, '')).sort();
    expect(ids).toEqual(['announcement', 'new-since-join', 'newer-than-cursor', 'same-time-later-id']);
    expect(new Set(rows.map((row) => row.serverId))).toEqual(new Set([`${P}-srv`]));
  });

  it('honours the limit', async () => {
    await expect(queryActivityUnreadChannels(db._pool, ME, 2)).resolves.toHaveLength(2);
  });

  it('probes messages through the channel cursor index, not a scan of messages', async () => {
    // A plan is only meaningful against known statistics. The correctness fixture above is a
    // handful of rows, and without ANALYZE the planner used whatever the shared test database
    // last recorded (another suite's leftovers, an empty-table autoanalyze) — the same query
    // got an index probe on one run and a Seq Scan on the next. Like the other plan suites
    // (keyset-pagination-plan, first-unread-scan-window), seed realistic volume and ANALYZE.
    // The volume lives in a server the user is not a member of, so it is never reported.
    await q(`INSERT INTO channels (_id, "serverId", name, type, "createdAt")
             SELECT $1 || '-vol-' || c, $2, 'vol' || c, 'text', 1 FROM generate_series(1, 40) c`, [P, `${P}-not-member-srv`]);
    await q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt", "deletedAt")
             SELECT $1 || '-volm-' || c || '-' || m, $1 || '-vol-' || c, $2, $3, 'u', 'U', 'm', 10000 + m, NULL
             FROM generate_series(1, 40) c, generate_series(1, 200) m`, [P, `${P}-not-member-srv`, OTHER]);
    for (const table of ['messages', 'channels', 'members', 'channel_read_positions']) await q(`ANALYZE ${table}`);
    const plan =(await q(`EXPLAIN (FORMAT JSON) ${ACTIVITY_UNREAD_SQL}`, [ME, MESSAGE_CHANNEL_TYPES, 1000]))[0]['QUERY PLAN'];
    const nodes: Array<Record<string, unknown>> = [];
    const walk = (node: Record<string, unknown>) => { nodes.push(node); for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child); };
    walk((plan as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
    const onMessages = nodes.filter((node) => node['Relation Name'] === 'messages');
    expect(onMessages.length).toBeGreaterThan(0);
    expect(onMessages.every((node) => String(node['Node Type']).startsWith('Index'))).toBe(true);
    expect(onMessages.some((node) => String(node['Index Name']).startsWith('idx_messages_channel'))).toBe(true);
  });
});
