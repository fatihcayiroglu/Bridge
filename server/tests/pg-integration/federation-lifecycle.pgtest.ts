// P6 — ActivityPub lifecycle/tombstone proof on real PostgreSQL.
// Runs with PG_TEST_URL after the normal schema/migration setup.

import { Federation } from '../../db/repositories';
const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const P = 'pgt-aplife';

RUN('real PostgreSQL — ActivityPub message lifecycle (P6)', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = () => q(`DELETE FROM ap_messages WHERE _id LIKE $1 OR "apId" LIKE $2`, [`${P}-%`, `https://${P}.test/%`]);

  beforeAll(cleanup);
  afterAll(cleanup);

  it('migration 079 owns a NOT NULL lifecycle clock and nullable tombstone timestamp', async () => {
    const rows = await q(
      `SELECT column_name, is_nullable, data_type, column_default
         FROM information_schema.columns
        WHERE table_name='ap_messages' AND column_name IN ('updatedAt','deletedAt')
        ORDER BY column_name`,
    );
    expect(rows).toHaveLength(2);
    const deleted = rows.find((r: any) => r.column_name === 'deletedAt');
    const updated = rows.find((r: any) => r.column_name === 'updatedAt');
    expect(deleted).toEqual(expect.objectContaining({ is_nullable: 'YES', data_type: 'bigint' }));
    expect(updated).toEqual(expect.objectContaining({ is_nullable: 'NO', data_type: 'bigint' }));
    expect(String(updated.column_default || '')).toMatch(/clock_timestamp|extract/i);
  });

  it('an old generation cannot overwrite a newer row through the repository predicate', async () => {
    const id = `${P}-ordering`;
    const apId = `https://${P}.test/notes/ordering`;
    await q(
      `INSERT INTO ap_messages (_id,"actorUrl","apId",content,visibility,"updatedAt","createdAt")
       VALUES ($1,$2,$3,'newest','public',2000,1000)`,
      [id, `https://${P}.test/users/bob`, apId],
    );

    await Federation.updateApMessage(
      { apId, actorUrl: `https://${P}.test/users/bob`, deletedAt: null, updatedAt: { $lt: 1500 } },
      { $set: { content: 'STALE', updatedAt: 1500 } },
    );
    let [row] = await q(`SELECT content,"updatedAt" FROM ap_messages WHERE _id=$1`, [id]);
    expect(row).toEqual({ content: 'newest', updatedAt: '2000' });

    await Federation.updateApMessage(
      { apId, actorUrl: `https://${P}.test/users/bob`, deletedAt: null, updatedAt: { $lt: 2500 } },
      { $set: { content: 'newer', updatedAt: 2500 } },
    );
    [row] = await q(`SELECT content,"updatedAt" FROM ap_messages WHERE _id=$1`, [id]);
    expect(row).toEqual({ content: 'newer', updatedAt: '2500' });
  });

  it('a tombstone keeps the AP object id occupied across restart-era redelivery', async () => {
    const apId = `https://${P}.test/notes/deleted`;
    await Federation.insertApMessage({
      _id: `${P}-tomb`,
      actorUrl: `https://${P}.test/users/bob`,
      apId,
      channelId: null,
      targetUserId: null,
      visibility: 'direct',
      content: '',
      summary: null,
      sensitive: false,
      inReplyTo: null,
      attachments: [],
      tags: [],
      published: null,
      updatedAt: 3000,
      deletedAt: 3000,
      createdAt: 3000,
    });

    const [tomb] = await q(`SELECT "apId",content,"deletedAt","updatedAt" FROM ap_messages WHERE _id=$1`, [`${P}-tomb`]);
    expect(tomb).toEqual({ apId, content: '', deletedAt: '3000', updatedAt: '3000' });

    // CONTROL: physically deleting the tombstone would make this insert pass.
    // While it is retained, PostgreSQL's existing UNIQUE(apId) rejects the
    // late Create generation before it can create a second object row.
    await expect(Federation.insertApMessage({
      _id: `${P}-late-create`,
      actorUrl: `https://${P}.test/users/bob`,
      apId,
      visibility: 'public',
      content: 'resurrected',
      updatedAt: 1000,
      createdAt: 1000,
    })).rejects.toThrow(/duplicate|unique/i);
  });

  it('the partial live/direct index excludes tombstones by contract', async () => {
    const rows = await q(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename='ap_messages'
          AND indexname IN ('idx_ap_messages_live_actor_published','idx_ap_messages_direct_target_live')
        ORDER BY indexname`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => /deletedAt.*IS NULL/i.test(r.indexdef))).toBe(true);
  });
});
