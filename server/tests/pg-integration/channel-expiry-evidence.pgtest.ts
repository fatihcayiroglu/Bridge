/** P7 D2: real PostgreSQL evidence, no mock and no persistent fixtures. */
import { Client } from 'pg';
import { readAndClassifyChannelExpiry } from '../../lib/channelExpiryEvidence';

const RUN = process.env.PG_TEST_URL ? describe : describe.skip;

RUN('P7 D2 atomic tombstone read — PostgreSQL', () => {
  it('reads permanent, active and expired rows then retains deletion markers', async () => {
    const client = new Client({ connectionString: process.env.PG_TEST_URL });
    const now = 1_800_000_000_000;
    const id = 'pgt-d2-evidence-' + process.pid + '-' + Date.now();
    const channel = id + '-channel';
    await client.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(
          'INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)',
          [id, 'pgt-d2-evidence-owner'],
        );
        await client.query(
          'INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1)',
          [channel, id],
        );
        // Tombstone absence is proven by one joined PostgreSQL statement.
        expect(await readAndClassifyChannelExpiry(client, channel, id, now))
          .toEqual({ state: 'permanent', accessible: true });
        await client.query(
          'UPDATE channels SET "expiresAt"=$1, "expiryVersion"=1 WHERE _id=$2',
          [String(now + 1000), channel],
        );
        expect(await readAndClassifyChannelExpiry(client, channel, id, now))
          .toEqual({ state: 'active', accessible: true });
        expect(await readAndClassifyChannelExpiry(client, channel, id, now + 1000))
          .toEqual({ state: 'expired', accessible: false });

        await client.query(
          'INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,$3,2,$4)',
          [channel, id, String(now + 1000), String(now + 1001)],
        );
        await client.query('DELETE FROM channels WHERE _id=$1', [channel]);
        expect(await readAndClassifyChannelExpiry(client, channel, id, now - 100_000))
          .toEqual({ state: 'tombstoned', accessible: false });

        expect(await readAndClassifyChannelExpiry(client, channel, 'foreign-server', now))
          .toEqual({ state: 'invalid', accessible: false });
        expect(await readAndClassifyChannelExpiry(client, id + '-missing', id, now))
          .toEqual({ state: 'invalid', accessible: false });
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      await client.end();
    }
  });

  it('denies access when the PostgreSQL expiry evidence is unavailable, then recovers', async () => {
    // A transactional search_path restriction produces a REAL PostgreSQL
    // relation-resolution failure without dropping tables or changing fixtures.
    // The unavailable tombstone lookup must never be treated as no tombstone.
    const client = new Client({ connectionString: process.env.PG_TEST_URL });
    const id = 'pgt-d2-outage-' + process.pid + '-' + Date.now();
    const channel = id + '-channel';
    const now = 1_800_000_000_000;
    await client.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(
          'INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)',
          [id, 'pgt-d2-evidence-owner'],
        );
        await client.query(
          'INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1)',
          [channel, id],
        );
        expect(await readAndClassifyChannelExpiry(client, channel, id, now))
          .toEqual({ state: 'permanent', accessible: true });

        await client.query('SAVEPOINT missing_expiry_evidence');
        await client.query('SET LOCAL search_path TO pg_catalog');
        expect(await readAndClassifyChannelExpiry(client, channel, id, now))
          .toEqual({ state: 'unverified', accessible: false });
        await client.query('ROLLBACK TO SAVEPOINT missing_expiry_evidence');

        // Recovery must use a fresh complete SELECT, not a cached negative.
        expect(await readAndClassifyChannelExpiry(client, channel, id, now))
          .toEqual({ state: 'permanent', accessible: true });
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      await client.end();
    }
  });
  it('never observes a half-committed channel deletion and durable tombstone across clients', async () => {
    // Separate actual PG connections: a worker must eventually create the
    // tombstone and delete the channel in ONE committed transaction. This
    // proves the evidence SELECT sees a consistent committed snapshot, not
    // that all mutation paths are yet protected (they are NOT wired).
    const reader = new Client({ connectionString: process.env.PG_TEST_URL });
    const writer = new Client({ connectionString: process.env.PG_TEST_URL });
    const now = 1_800_000_000_000;
    const id = 'pgt-d2-snapshot-' + process.pid + '-' + Date.now();
    const channel = id + '-channel';
    await reader.connect();
    try {
      await writer.connect();
      try {
        await reader.query(
          'INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)',
          [id, 'pgt-d2-evidence-owner'],
        );
        await reader.query(
          'INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$1,1,$3,1)',
          [channel, id, String(now)],
        );
        expect(await readAndClassifyChannelExpiry(reader, channel, id, now))
          .toEqual({ state: 'expired', accessible: false });

        await writer.query('BEGIN');
        await writer.query(
          'INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,$3,1,$4)',
          [channel, id, String(now), String(now + 1)],
        );
        await writer.query('DELETE FROM channels WHERE _id=$1 AND "serverId"=$2', [channel, id]);

        // The reader is not in the writer transaction: it sees the complete
        // pre-commit expired row, never an uncommitted partial state.
        expect(await readAndClassifyChannelExpiry(reader, channel, id, now))
          .toEqual({ state: 'expired', accessible: false });
        await writer.query('COMMIT');

        // On a fresh READ COMMITTED statement, the channel has disappeared
        // but the durable marker is already visible; clock rollback denies.
        expect(await readAndClassifyChannelExpiry(reader, channel, id, now - 1000))
          .toEqual({ state: 'tombstoned', accessible: false });
        expect((await reader.query(
          'SELECT _id FROM channels WHERE _id=$1', [channel],
        )).rows).toHaveLength(0);
      } finally {
        // If the transaction is still open after a failing assertion, abort it
        // before cleanup; no committed fixture may leak to other tests.
        await writer.query('ROLLBACK');
        await reader.query(
          'DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [channel],
        );
        await reader.query('DELETE FROM channels WHERE _id=$1', [channel]);
        await reader.query('DELETE FROM servers WHERE _id=$1', [id]);
        await writer.end();
      }
    } finally {
      await reader.end();
    }
  });

});
