// server/tests/pg-integration/dm-read-receipt.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL: A DM READ RECEIPT WRITES ONLY ITS OWN CURSOR, NEVER LOSES
// THE OTHER PARTICIPANT'S, AND NEVER LETS AN OUTSIDER WRITE
// ════════════════════════════════════════════════════════════════════════════
// `Dms.markReadWithReceipt` keeps every participant's read cursor in one JSONB
// object (`dm_conversations."readAt"`: userId → timestamp). In production it
// is a read-modify-write under `SELECT … FOR UPDATE`, so two participants who
// open the same DM at the same moment cannot overwrite each other's entry.
// Unit tests run the in-memory branch (NODE_ENV=test), so this SQL path —
// the one production uses — had never executed. Proven here on PostgreSQL:
//   - a participant writes only their own cursor; the other one is kept;
//   - a non-participant or an unknown DM writes nothing;
//   - a conversation with no cursor yet (the column defaults to '{}') gets one;
//   - both participants marking read concurrently, many times over, never
//     lose either cursor (the row lock serializes them);
//   - the unread preview and count use the cursor exactly.

import { Dms } from '../../db/repositories';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-dmread';
const ALICE = `${P}-alice`;
const BOB = `${P}-bob`;
const EVE = `${P}-eve`;
const DM = `${P}-dm`;

RUN('real PostgreSQL — DM read receipts', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = async () => {
    await q(`DELETE FROM dm_messages WHERE "dmId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM dm_conversations WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [`${P}-%`]);
  };
  const cursors = async (dmId = DM): Promise<Record<string, number> | null> =>
    (await q(`SELECT "readAt" FROM dm_conversations WHERE _id = $1`, [dmId]))[0]?.readAt ?? null;
  const message = async (id: string, from: string, createdAt: number) => q(
    `INSERT INTO dm_messages (_id, "dmId", "userId", "displayName", content, "createdAt") VALUES ($1, $2, $3, $3, $1, $4)`,
    [`${P}-${id}`, DM, from, createdAt],
  );

  beforeEach(async () => {
    await cleanup();
    for (const id of [ALICE, BOB, EVE]) {
      await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [id]);
    }
    await q(
      `INSERT INTO dm_conversations (_id, participants, "createdAt", "lastMessageAt") VALUES ($1, $2::jsonb, 1, 1)`,
      [DM, JSON.stringify([ALICE, BOB])],
    );
  });
  afterAll(async () => { await cleanup(); });

  it('a conversation with no cursor yet gets the reader\'s cursor, and the receipt names both participants', async () => {
    expect(await cursors()).toEqual({});
    const before = Date.now();
    const receipt = await Dms.markReadWithReceipt(DM, ALICE);
    expect(receipt).toEqual({ participants: [ALICE, BOB], readAt: expect.any(Number) });
    expect(receipt!.readAt).toBeGreaterThanOrEqual(before);
    expect(await cursors()).toEqual({ [ALICE]: receipt!.readAt });
  });

  it('a participant writes only their own cursor; the other participant\'s is kept', async () => {
    await q(`UPDATE dm_conversations SET "readAt" = $2::jsonb WHERE _id = $1`, [DM, JSON.stringify({ [BOB]: 1234 })]);
    const receipt = await Dms.markReadWithReceipt(DM, ALICE);
    expect(await cursors()).toEqual({ [BOB]: 1234, [ALICE]: receipt!.readAt });
  });

  it('a non-participant, an unknown DM and empty ids write nothing', async () => {
    await q(`UPDATE dm_conversations SET "readAt" = $2::jsonb WHERE _id = $1`, [DM, JSON.stringify({ [BOB]: 1234 })]);
    await expect(Dms.markReadWithReceipt(DM, EVE)).resolves.toBeNull();
    await expect(Dms.markReadWithReceipt(`${P}-missing`, ALICE)).resolves.toBeNull();
    await expect(Dms.markReadWithReceipt('', ALICE)).resolves.toBeNull();
    await expect(Dms.markReadWithReceipt(DM, '')).resolves.toBeNull();
    await expect(Dms.markRead(DM, EVE)).resolves.toBe(false);
    expect(await cursors()).toEqual({ [BOB]: 1234 });
    // The rejected attempts released their row locks: a participant can still write.
    await expect(Dms.markRead(DM, ALICE)).resolves.toBe(true);
  });

  it('both participants marking read at the same moment never lose either cursor', async () => {
    for (let round = 0; round < 25; round++) {
      await q(`UPDATE dm_conversations SET "readAt" = '{}'::jsonb WHERE _id = $1`, [DM]);
      const [a, b] = await Promise.all([Dms.markReadWithReceipt(DM, ALICE), Dms.markReadWithReceipt(DM, BOB)]);
      const stored = await cursors();
      expect({ round, stored }).toEqual({ round, stored: { [ALICE]: a!.readAt, [BOB]: b!.readAt } });
    }
  });

  it('the unread preview and count use the cursor exactly, and ignore the reader\'s own messages', async () => {
    await message('m1', BOB, 1000);
    await message('m2', ALICE, 2000);
    await message('m3', BOB, 3000);
    await message('m4', BOB, 4000);

    await expect(Dms.countUnread(DM, ALICE)).resolves.toBe(3);
    await expect(Dms.countUnread(DM, ALICE, 3000)).resolves.toBe(1);
    expect((await Dms.findLatestUnread(DM, ALICE))?._id).toBe(`${P}-m4`);
    expect((await Dms.findLatestUnread(DM, ALICE, 4000))).toBeNull();
    expect((await Dms.findLatestUnread(DM, BOB))?._id).toBe(`${P}-m2`);
    await expect(Dms.countUnread('', ALICE)).resolves.toBe(0);
  });
});
