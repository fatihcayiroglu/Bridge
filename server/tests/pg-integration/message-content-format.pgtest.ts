// server/tests/pg-integration/message-content-format.pgtest.ts
//
// Final21 Phase 16 — channel message text stored RAW, on REAL PostgreSQL.
//
// Why this exists: every unit test passed while every channel message send failed on the live
// server with "[pgCollection] Unknown column name: contentFormat" — the mock DB has no column
// allowlist. Only the real repository against the real table proves the write path.
// Runs only with PG_TEST_URL; removes its own rows.

import { Messages } from '../../db/repositories';
import { RAW_TEXT_FORMAT, storedMessageText } from '../../lib/storedText';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const P = 'pgt-fmt';

RUN('gerçek PostgreSQL — mesaj metni yazıldığı gibi saklanır', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = () => q(`DELETE FROM messages WHERE _id LIKE $1`, [`${P}-%`]);

  beforeAll(cleanup);
  afterAll(cleanup);

  it('the column exists with the LEGACY default, so every pre-existing row reads as legacy', async () => {
    const rows = await q(
      `SELECT data_type, column_default, is_nullable FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'contentFormat'`,
    );
    expect(rows).toEqual([{ data_type: 'smallint', column_default: '0', is_nullable: 'NO' }]);
  });

  it('Messages.create stores RAW text through the real repository (allowlist included)', async () => {
    const typed = 'let v: Vec<String> = a<b && c>d; <img src=x onerror=alert(1)> &amp;';
    await Messages.create({
      _id: `${P}-raw`, channelId: `${P}-ch`, serverId: `${P}-srv`, userId: `${P}-u`,
      username: 'u', displayName: 'U', content: typed, createdAt: Date.now(),
    });
    const [row] = await q(`SELECT content, "contentFormat" FROM messages WHERE _id = $1`, [`${P}-raw`]);
    expect(row).toEqual({ content: typed, contentFormat: RAW_TEXT_FORMAT });
    expect(storedMessageText(row)).toBe(typed);
  });

  it('a row written before 074 (no format given) is LEGACY and is decoded once', async () => {
    await q(
      `INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
       VALUES ($1, $2, $3, $4, 'u', 'U', 'a &lt; b &amp;&amp; c', 1)`,
      [`${P}-legacy`, `${P}-ch`, `${P}-srv`, `${P}-u`],
    );
    const [row] = await q(`SELECT content, "contentFormat" FROM messages WHERE _id = $1`, [`${P}-legacy`]);
    expect(row.contentFormat).toBe(0);
    expect(storedMessageText(row)).toBe('a < b && c');
  });

  it('Messages.update can switch a row to RAW (update path is allowlisted too)', async () => {
    await Messages.update(`${P}-legacy`, { content: 'x<y', contentFormat: RAW_TEXT_FORMAT });
    const [row] = await q(`SELECT content, "contentFormat" FROM messages WHERE _id = $1`, [`${P}-legacy`]);
    expect(row).toEqual({ content: 'x<y', contentFormat: RAW_TEXT_FORMAT });
  });
  // Final21 Phase 16: a soft-deleted row is audit state. It must not come back in the list or
  // the pinned panel — measured before the fix: a deleted message reappeared after a reload as
  // a '[Mesaj silindi]' line, in Turkish for every locale (p16-tombstone-probe).
  it('the channel list and the pinned panel skip soft-deleted rows', async () => {
    const channelId = `${P}-ch2`;
    const base = { channelId, serverId: `${P}-srv`, userId: `${P}-u`, username: 'u', displayName: 'U' };
    await Messages.create({ ...base, _id: `${P}-live`, content: 'still here', pinned: 1, createdAt: 10 });
    await Messages.create({ ...base, _id: `${P}-dead`, content: 'to delete', pinned: 1, createdAt: 20 });
    await q(`UPDATE messages SET content = '[Mesaj silindi]', "deletedAt" = 99 WHERE _id = $1`, [`${P}-dead`]);

    const page = await Messages.findByChannel(channelId, { limit: 50 }) as Array<{ _id: string }>;
    const pinned = await Messages.findPinned(channelId) as Array<{ _id: string }>;

    expect(page.map((r) => r._id)).toEqual([`${P}-live`]);
    expect(pinned.map((r) => r._id)).toEqual([`${P}-live`]);
  });
});
