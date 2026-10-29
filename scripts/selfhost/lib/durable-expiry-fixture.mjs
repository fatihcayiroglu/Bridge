// D2/D3 recovery fixture for the existing real PostgreSQL backup/restore drill.
// Called only on the harness's disposable installation while its app is stopped.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const CHANNEL = 'selfhost-d2-deleted-channel';
const DELETED_KEY = 'uploads/selfhost-d2-deleted.bin';
const LIVE_KEY = 'uploads/selfhost-d2-live.bin';
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

function snapshot(inst) {
  const value = JSON.parse(inst.psql('bridge', `SELECT jsonb_build_object(
    'reports', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r._id) FROM message_reports r WHERE "channelId" = '${CHANNEL}'),
    'tombstones', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t."channelId") FROM channel_expiry_tombstones t WHERE "channelId" = '${CHANNEL}'),
    'outbox', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.url) FROM channel_object_release_outbox o WHERE "channelId" = '${CHANNEL}'),
    'fences', (SELECT jsonb_agg(to_jsonb(k) ORDER BY k.key) FROM upload_release_keys k WHERE key IN ('${DELETED_KEY}', '${LIVE_KEY}'))
  )`));
  // Non-empty, distinct lifecycle states are required; an empty backup cannot pass.
  assert.equal(value.reports?.length, 3, 'All three report states must survive');
  assert.deepEqual(value.reports.map(report => report.status).sort(), ['dismissed', 'open', 'resolved']);
  assert(value.reports.every(report => report.channelVisibility === 'restricted'), 'Deleted private-channel policy must survive');
  assert.equal(value.tombstones?.length, 1, 'Durable tombstone must survive');
  assert.equal(value.outbox?.length, 3, 'Pending, leased and completed release rows must survive');
  assert.equal(value.fences?.length, 2, 'Reserved and unreserved keys must survive');
  // Only a digest leaves this function. Never include moderation snapshots in artifacts.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function seedDurableExpiryBackup(inst, fixture) {
  assert(!inst.app || inst.app.exited, 'Stop the disposable app before seeding recovery states');
  const now = Date.now();
  inst.psql('bridge', `BEGIN;
    INSERT INTO channel_expiry_tombstones ("channelId", "serverId", "expiredAt", "expiryVersion", "recordedAt", "cleanupState")
      VALUES ('${CHANNEL}', ${literal(fixture.serverId)}, ${now - 1000}, 3, ${now}, 'converged');
    INSERT INTO message_reports (_id, "serverId", "channelId", "messageId", "reporterId", reason, status,
      "createdAt", "resolvedAt", "evidenceCapturedAt", "evidenceText", "evidenceAuthorId", "evidenceAuthorName", "channelVisibility")
      SELECT 'selfhost-d2-report-' || status, ${literal(fixture.serverId)}, '${CHANNEL}', 'selfhost-deleted-message',
        ${literal(fixture.users.a.id)}, 'harassment', status, ${now - 1000},
        CASE WHEN status = 'open' THEN NULL ELSE ${now} END,
        ${now - 1000}, 'bounded synthetic report evidence', ${literal(fixture.users.b.id)}, 'synthetic fixture author', 'restricted'
      FROM unnest(ARRAY['open', 'resolved', 'dismissed']) AS states(status);
    INSERT INTO channel_object_release_outbox ("channelId", url, "enqueuedAt", state, attempts, "nextAttemptAt", "finishedAt", "lastError") VALUES
      ('${CHANNEL}', '/uploads/selfhost-d2-pending.bin', ${now}, 'pending', 0, ${now + 86_400_000}, NULL, NULL),
      ('${CHANNEL}', '/uploads/selfhost-d2-leased.bin', ${now}, 'pending', 2, ${now + 86_400_000}, NULL, 'synthetic crash recovery fixture'),
      ('${CHANNEL}', '/uploads/selfhost-d2-deleted.bin', ${now}, 'released', 1, ${now}, ${now}, NULL);
    INSERT INTO upload_release_keys (key, reserved) VALUES ('${DELETED_KEY}', true), ('${LIVE_KEY}', false);
    COMMIT;`);
  return snapshot(inst);
}

export function verifyDurableExpiryBackup(inst, fixture, expectedDigest) {
  assert.equal(snapshot(inst), expectedDigest, 'Restored D2 graph must match every seeded column, not just row counts');
  // Execute the restored trigger. Catalog existence alone does not prove that
  // a deleted object cannot be attached again after restoring the database.
  inst.psql('bridge', `DO $$ BEGIN
    BEGIN
      UPDATE users SET "avatarUrl" = '/${DELETED_KEY}' WHERE _id = ${literal(fixture.users.b.id)};
      RAISE EXCEPTION 'Restored upload fence allowed a stale reference';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
  END $$;`);
  // Exercise the restored erasure trigger, then roll back the entire probe so
  // the existing API smoke still verifies the original accounts and messages.
  inst.psql('bridge', `BEGIN;
    DELETE FROM users WHERE _id = ${literal(fixture.users.b.id)};
    DO $$ BEGIN
      IF (SELECT count(*) FROM message_reports WHERE "channelId" = '${CHANNEL}'
        AND "evidenceAuthorId" = 'deleted-user' AND "evidenceAuthorName" = '') <> 3 THEN
        RAISE EXCEPTION 'Restored evidence erasure trigger failed';
      END IF;
    END $$;
    ROLLBACK;`);
  assert.equal(snapshot(inst), expectedDigest, 'Recovery probes must not mutate the restored evidence or pending queue');
}
