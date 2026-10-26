/**
 * P7 D2 performance measurement (issue #321): time-to-expiry, bounded cleanup
 * pass latency, object release throughput, sibling-channel write latency during
 * the drain, and the write barrier's per-insert overhead — on REAL PostgreSQL.
 *
 *   BENCH_DATABASE_URL=postgresql://... npx ts-node --project tsconfig.json \
 *     scripts/bench-channel-expiry.ts [messages=50000] [batch=500]
 *
 * Use a disposable database: the script creates and removes its own rows
 * (prefix bench-d2-*) and never drops schema. Results are printed as JSON and
 * depend on the host; do not read them as production numbers.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import {
  claimExpiredChannel, cleanupNextTombstone, releaseChannelObjects, type ExpiryPool,
} from '../lib/channelExpiryWorker';
import { createChannelObjectReleaser } from '../lib/channelObjectRelease';

const URL_ = process.env.BENCH_DATABASE_URL;
if (!URL_) { console.error('BENCH_DATABASE_URL is required (a disposable database)'); process.exit(2); }
const MESSAGES = Number(process.argv[2] ?? 50_000);
const BATCH = Number(process.argv[3] ?? 500);
const P = `bench-d2-${process.pid}`;
const pool = new Pool({ connectionString: URL_, max: 8 });

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!.toFixed(2));
}
const stats = (v: number[]) => ({ n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: pct(v, 100) });
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;

async function seed(uploads: string) {
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await q(`INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,'Bench','x',1)`, [`${P}-u`]);
  await q(`INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)`, [`${P}-s`, `${P}-u`]);
  await q(`INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,'live',1)`, [`${P}-live`, `${P}-s`]);
  await q(`INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,'eph',1,$3,1)`,
    [`${P}-eph`, `${P}-s`, Date.now() + 3_600_000]);
  // 10% of messages carry an attachment (a real local file) so URL capture and release are measured.
  await q(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,type,"fileUrl","createdAt")
           SELECT $1 || '-m-' || g, $2, $3, $4, 'u', 'U', repeat('x', 200),
                  CASE WHEN g % 10 = 0 THEN 'file' ELSE 'normal' END,
                  CASE WHEN g % 10 = 0 THEN '/uploads/' || $1 || '-f-' || g || '.bin' END, g
             FROM generate_series(1, $5::int) g`, [P, `${P}-eph`, `${P}-s`, `${P}-u`, MESSAGES]);
  for (let g = 10; g <= MESSAGES; g += 10) fs.writeFileSync(path.join(uploads, `${P}-f-${g}.bin`), 'x');
  const threads = Math.max(1, Math.floor(MESSAGES / 100));
  await q(`INSERT INTO threads (_id,"channelId","serverId","parentMessageId",name,"createdBy","createdAt","lastMessageAt")
           SELECT $1 || '-t-' || g, $2, $3, $1 || '-m-' || (g * 100), 't', $4, 1, 1 FROM generate_series(1, $5::int) g`,
    [P, `${P}-eph`, `${P}-s`, `${P}-u`, threads]);
  await q(`INSERT INTO thread_messages (_id,"threadId","channelId","serverId","userId",username,"displayName",content,"createdAt")
           SELECT $1 || '-tm-' || g, $1 || '-t-' || (1 + g % $5::int), $2, $3, $4, 'u', 'U', 'reply', g
             FROM generate_series(1, $6::int) g`, [P, `${P}-eph`, `${P}-s`, `${P}-u`, threads, Math.floor(MESSAGES / 5)]);
  await q(`INSERT INTO notifications (_id,"userId",type,"serverId","channelId","messageId",read,"createdAt")
           SELECT $1 || '-n-' || g, $4, 'mention', $3, $2, $1 || '-m-' || g, FALSE, g FROM generate_series(1, $5::int) g`,
    [P, `${P}-eph`, `${P}-s`, `${P}-u`, Math.floor(MESSAGES / 10)]);
  await q('ANALYZE messages; ANALYZE threads; ANALYZE thread_messages; ANALYZE notifications');
}

async function cleanup() {
  for (const t of ['thread_messages', 'threads', 'messages', 'notifications']) {
    await pool.query(`DELETE FROM ${t} WHERE "channelId" LIKE $1`, [`${P}%`]);
  }
  await pool.query('DELETE FROM channel_object_release_outbox WHERE "channelId" LIKE $1', [`${P}%`]);
  await pool.query('DELETE FROM channel_expiry_tombstones WHERE "channelId" LIKE $1', [`${P}%`]);
  await pool.query('DELETE FROM channels WHERE _id LIKE $1', [`${P}%`]);
  await pool.query('DELETE FROM servers WHERE _id LIKE $1', [`${P}%`]);
  await pool.query('DELETE FROM users WHERE _id LIKE $1', [`${P}%`]);
}

async function insertLatency(channelId: string, n: number, label: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    await pool.query(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")
                      VALUES ($1,$2,$3,$4,'u','U','live write',$5)`, [`${P}-${label}-${i}`, channelId, `${P}-s`, `${P}-u`, Date.now()]);
    out.push(ms(t));
  }
  return out;
}

async function main() {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-d2-uploads-'));
  process.env.BRIDGE_UPLOAD_ROOT = uploads;
  const report: Record<string, unknown> = {
    host: { cpus: os.cpus().length, platform: `${os.platform()} ${os.release()}` },
    postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
    messages: MESSAGES, batchSize: BATCH,
  };
  await cleanup();
  let t = process.hrtime.bigint();
  await seed(uploads);
  report.seedMs = Math.round(ms(t));

  // Write barrier overhead on a permanent channel: the same 300 inserts in one
  // transaction with the trigger enabled, then disabled (both rolled back).
  const barrierRun = async (disable: boolean): Promise<number[]> => {
    const client = await pool.connect();
    const out: number[] = [];
    try {
      await client.query('BEGIN');
      if (disable) await client.query('ALTER TABLE messages DISABLE TRIGGER channel_write_barrier');
      for (let i = 0; i < 300; i++) {
        const s = process.hrtime.bigint();
        await client.query(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")
                            VALUES ($1,$2,$3,$4,'u','U','x',1)`, [`${P}-wb-${disable}-${i}`, `${P}-live`, `${P}-s`, `${P}-u`]);
        out.push(ms(s));
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    return out;
  };
  await barrierRun(false);   // warm-up
  const withBarrier = await barrierRun(false);
  const withoutBarrier = await barrierRun(true);
  report.writeBarrierInsertMs = { on: stats(withBarrier), off: stats(withoutBarrier) };

  await pool.query('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [Date.now() - 1000, `${P}-eph`]);
  const expiredAt = Date.now();

  // Claim: one O(1) transaction regardless of channel size.
  const claims: number[] = [];
  for (let i = 0; i < 50; i++) {
    t = process.hrtime.bigint();
    const c = await claimExpiredChannel(pool as unknown as ExpiryPool);
    claims.push(ms(t));
    if (c.state === 'none') break;
  }
  report.claimMs = stats(claims);
  report.timeToTombstoneMs = Date.now() - expiredAt;

  // Bounded passes while a sibling channel keeps writing.
  const passes: number[] = [];
  let siblingDone = false;
  const sibling = (async () => {
    const out: number[] = [];
    for (let i = 0; !siblingDone && i < 5000; i++) out.push(...await insertLatency(`${P}-live`, 1, `during-${i}`));
    return out;
  })();
  t = process.hrtime.bigint();
  for (let i = 0; i < 100_000; i++) {
    const s = process.hrtime.bigint();
    const pass = await cleanupNextTombstone(pool as unknown as ExpiryPool, BATCH);
    passes.push(ms(s));
    if (pass.state === 'none') break;
  }
  report.drainMs = Math.round(ms(t));
  siblingDone = true;
  report.cleanupPassMs = stats(passes);
  report.siblingInsertDuringDrainMs = stats(await sibling);

  const queued = Number((await pool.query(
    'SELECT COUNT(*)::int AS n FROM channel_object_release_outbox WHERE "channelId"=$1', [`${P}-eph`])).rows[0].n);
  const releaser = createChannelObjectReleaser(pool);
  t = process.hrtime.bigint();
  let released = 0;
  for (let i = 0; i < 10_000; i++) {
    const r = await releaseChannelObjects(pool as unknown as ExpiryPool, releaser, 200);
    released += r.released + r.retained + r.failed;
    if (!r.released && !r.retained && !r.retried && !r.failed) break;
  }
  const releaseMs = ms(t);
  report.objects = { queued, finished: released, totalMs: Math.round(releaseMs),
    perObjectMs: queued ? Number((releaseMs / queued).toFixed(2)) : 0 };
  report.timeToConvergeMs = Date.now() - expiredAt;

  await cleanup();
  fs.rmSync(uploads, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => undefined);
  await pool.end();
  process.exit(1);
});
