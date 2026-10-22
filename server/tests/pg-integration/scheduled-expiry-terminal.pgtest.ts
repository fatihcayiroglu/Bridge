/**
 * P7 D2: a scheduled post whose channel expired (or was tombstoned) after it
 * was scheduled is refused by the PostgreSQL write barrier (SQLSTATE BX001).
 * The dispatcher must record that refusal as terminal on the first attempt,
 * not retry it; a live channel's schedule in the same batch still posts.
 * Real PostgreSQL: the refusal comes from the migration 086 trigger itself.
 */
const db = require('../../db/loader').default;
const { _dispatchDueForTest } = require('../../jobs/scheduledMessages');

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const P = 'pgt-d2-sched-' + process.pid + '-' + Date.now();
const OWNER = P + '-owner';
const SERVER = P + '-server';
const LIVE = P + '-live';
const EXPIRING = P + '-expiring';
const TOMBED = P + '-tombed';

RUN('P7 D2 scheduled posts into unavailable channels — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);

  async function cleanup() {
    await q('DELETE FROM scheduled_msgs WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM messages WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM channels WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM members WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM servers WHERE _id=$1', [SERVER]);
    await q('DELETE FROM users WHERE _id=$1', [OWNER]);
  }
  async function schedule(channelId: string) {
    const sid = P + '-s-' + channelId.slice(P.length + 1);
    await q(`INSERT INTO scheduled_msgs (_id,"channelId","serverId","userId","displayName",username,content,"sendAt","createdAt")
             VALUES ($1,$2,$3,$4,'Owner','owner',$5,$6,$6)`, [sid, channelId, SERVER, OWNER, 'scheduled for ' + channelId, Date.now() - 1000]);
    return sid;
  }
  const state = async (sid: string) => (await q(
    'SELECT sent, "failureReason", "dispatchAttempts", "claimOwner", "lastError" FROM scheduled_msgs WHERE _id=$1', [sid])).rows[0];
  const posted = async (channelId: string) =>
    Number((await q('SELECT COUNT(*)::int AS n FROM messages WHERE "channelId"=$1', [channelId])).rows[0].n);

  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,1)',
      [OWNER, 'owner-' + process.pid, 'Owner', 'irrelevant']);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [SERVER, OWNER]);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)', [OWNER, SERVER, '[]']);
    for (const cid of [LIVE, EXPIRING, TOMBED]) {
      await q('INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$1,1,$3,$4)',
        [cid, SERVER, cid === LIVE ? null : Date.now() + 600_000, cid === LIVE ? 0 : 1]);
    }
  });
  afterAll(cleanup);

  it('fails an expired or tombstoned channel schedule terminally on attempt 1 and still posts the live one', async () => {
    const live = await schedule(LIVE);
    const expired = await schedule(EXPIRING);
    const tombed = await schedule(TOMBED);
    // Both channels become unavailable after the posts were scheduled.
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [Date.now() - 1000, EXPIRING]);
    await q(`INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")
             VALUES ($1,$2,$3,1,$3,'pending')`, [TOMBED, SERVER, Date.now()]);

    await _dispatchDueForTest();

    expect(await state(live)).toMatchObject({ sent: true });
    expect(await posted(LIVE)).toBe(1);
    for (const sid of [expired, tombed]) {
      const s = await state(sid);
      expect(s).toMatchObject({ sent: false, failureReason: 'channel_unavailable' });
      expect(s.claimOwner).toBeNull();  // terminal: no lease left to re-claim
    }
    expect(await posted(EXPIRING)).toBe(0);
    expect(await posted(TOMBED)).toBe(0);

    // A later tick does not pick the refused posts up again.
    await _dispatchDueForTest();
    expect(await state(expired)).toMatchObject({ sent: false, failureReason: 'channel_unavailable' });
    expect(await posted(EXPIRING)).toBe(0);
  });
});
