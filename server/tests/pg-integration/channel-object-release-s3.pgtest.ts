/**
 * P7 D2: expired-channel object release against a real S3-compatible private
 * bucket (CI: the MinIO-compatible service of the quality gate). The storage
 * module reads its provider when loaded, so the environment is set before any
 * Bridge module is required. Runs only with PG_TEST_URL and MINIO_TEST_ENDPOINT.
 */
const ENDPOINT = process.env.MINIO_TEST_ENDPOINT;
const PRIVATE_BUCKET = process.env.MINIO_TEST_PRIVATE_BUCKET || 'bridge-private';
const ACCESS_KEY = process.env.MINIO_TEST_ACCESS_KEY || 'bridgereview';
const SECRET_KEY = process.env.MINIO_TEST_SECRET_KEY || 'bridgereview123';
if (ENDPOINT) {
  Object.assign(process.env, {
    CDN_PROVIDER: 'minio',
    PRIVATE_STORAGE_PROVIDER: 'minio',
    MINIO_ENDPOINT: ENDPOINT,
    MINIO_BUCKET: process.env.MINIO_TEST_PUBLIC_BUCKET || 'bridge-public',
    PRIVATE_MINIO_BUCKET: PRIVATE_BUCKET,
    MINIO_ACCESS_KEY: ACCESS_KEY,
    MINIO_SECRET_KEY: SECRET_KEY,
    MINIO_PUBLIC_URL: `${ENDPOINT}/${process.env.MINIO_TEST_PUBLIC_BUCKET || 'bridge-public'}`,
  });
}

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const crypto = require('crypto') as typeof import('crypto');
const { S3Client, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3') as typeof import('@aws-sdk/client-s3');
const db = require('../../db/loader').default;
const { getPrivateStorageAdapter } = require('../../lib/storageAdapter') as typeof import('../../lib/storageAdapter');
const { runChannelExpiryTick } = require('../../lib/channelExpiryWorker') as typeof import('../../lib/channelExpiryWorker');
const { createChannelObjectReleaser } = require('../../lib/channelObjectRelease') as typeof import('../../lib/channelObjectRelease');
/* eslint-enable @typescript-eslint/no-require-imports */

const RUN = process.env.PG_TEST_URL && ENDPOINT ? describe : describe.skip;
const P = 'pgt-d2-objs3-' + process.pid + '-' + Date.now();
const USER = P + '-user';
const SERVER = P + '-srv';
const KEEP = P + '-keep';
const EPH = P + '-eph';
const uniq = crypto.randomUUID().slice(0, 8);
const KEY_GONE = `uploads/d2gone-${uniq}.png`;
const KEY_SHARED = `uploads/d2shared-${uniq}.png`;

RUN('P7 D2 expired-channel object release — real S3-compatible private bucket', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows as Array<Record<string, unknown>>;
  const s3 = new S3Client({
    endpoint: ENDPOINT, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  const present = async (key: string) => {
    try { await s3.send(new HeadObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key })); return true; } catch { return false; }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-d2-s3-'));

  async function cleanup() {
    await q('DELETE FROM channel_object_release_outbox WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM messages WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM channels WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM servers WHERE _id=$1', [SERVER]);
    await q('DELETE FROM users WHERE _id=$1', [USER]);
  }
  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$2,$3,1)', [USER, 'U', 'x']);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [SERVER, USER]);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,1)', [KEEP, SERVER, 'keep']);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$3,1,$4,1)',
      [EPH, SERVER, 'eph', Date.now() + 600_000]);
    for (const key of [KEY_GONE, KEY_SHARED]) {
      const local = path.join(tmp, path.basename(key));
      fs.writeFileSync(local, 'attachment bytes');
      await getPrivateStorageAdapter().uploadFile(local, key, { contentType: 'image/png', deleteLocal: false });
    }
  });
  afterAll(async () => {
    for (const key of [KEY_GONE, KEY_SHARED]) {
      await s3.send(new DeleteObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key })).catch(() => undefined);
    }
    await cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('deletes the expired channel\'s private object and keeps one still referenced elsewhere', async () => {
    const insert = (cid: string, key: string) => q(
      `INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,type,"fileUrl","createdAt")
       VALUES ($1,$2,$3,$4,'u','U','','file',$5,1)`, [`${P}-m-${crypto.randomUUID()}`, cid, SERVER, USER, `/${key}`]);
    await insert(EPH, KEY_GONE);
    await insert(EPH, KEY_SHARED);
    await insert(KEEP, KEY_SHARED);
    expect(await present(KEY_GONE)).toBe(true);
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [Date.now() - 1000, EPH]);

    const releaser = createChannelObjectReleaser(db._pool);
    for (let i = 0; i < 300; i++) {
      const r = await runChannelExpiryTick(db._pool, {}, releaser);
      const moved = r.claimed.length + r.converged.length + r.deleted +
        (r.objects ? r.objects.released + r.objects.retained + r.objects.retried + r.objects.failed : 0);
      if (!moved) break;
    }
    const states = await q('SELECT url, state, "lastError" FROM channel_object_release_outbox WHERE "channelId"=$1 ORDER BY url', [EPH]);
    expect(states).toEqual([
      { url: `/${KEY_GONE}`, state: 'released', lastError: null },
      { url: `/${KEY_SHARED}`, state: 'retained', lastError: 'still_referenced' },
    ]);
    expect(await present(KEY_GONE)).toBe(false);
    expect(await present(KEY_SHARED)).toBe(true);
  });
});
