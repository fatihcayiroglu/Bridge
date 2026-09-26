// server/tests/pg-integration/voice-message-columns.pgtest.ts
//
// Final21 Phase 16 — `voice_messages."displayName"` is NOT NULL with no default, and
// routes/voicemsg.ts never wrote it: sending a voice message could only fail on a real
// database (the unit-test store does not enforce NOT NULL). This test states both halves:
// the column really is required, and the field set the route now sends is accepted.
// Runs only with PG_TEST_URL; removes its own rows.

import { VoiceMessages } from '../../db/repositories';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const P = 'pgt-vm';

RUN('gerçek PostgreSQL — sesli mesaj zorunlu sütunları', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = () => q(`DELETE FROM voice_messages WHERE _id LIKE $1`, [`${P}-%`]);

  beforeAll(cleanup);
  afterAll(cleanup);

  it('displayName is NOT NULL with no default', async () => {
    const [row] = await q(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'voice_messages' AND column_name = 'displayName'`,
    );
    expect(row).toEqual({ is_nullable: 'NO', column_default: null });
  });

  it('the field set the route sends is accepted', async () => {
    await VoiceMessages.insert({
      _id: `${P}-ok`, channelId: `${P}-ch`, serverId: `${P}-srv`, userId: `${P}-u`,
      displayName: 'Alice', url: '/uploads/a.webm', duration: 3, createdAt: Date.now(),
    });
    const [row] = await q(`SELECT "displayName" FROM voice_messages WHERE _id = $1`, [`${P}-ok`]);
    expect(row).toEqual({ displayName: 'Alice' });
  });

  it('CONTROL: the same insert without displayName is refused by the database', async () => {
    await expect(VoiceMessages.insert({
      _id: `${P}-bad`, channelId: `${P}-ch`, serverId: `${P}-srv`, userId: `${P}-u`,
      url: '/uploads/b.webm', duration: 3, createdAt: Date.now(),
    })).rejects.toThrow(/displayName|not-null|null value/i);
  });
});
