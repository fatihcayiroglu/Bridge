/** Real PostgreSQL and S3 proof of the daily collector's writer coordination. */
const endpoint = process.env.MINIO_TEST_ENDPOINT;
if (!process.env.PG_TEST_URL || !endpoint) {
  throw new Error('Upload cleanup coordination requires PG_TEST_URL and MINIO_TEST_ENDPOINT');
}
const bucket = process.env.MINIO_TEST_PRIVATE_BUCKET || 'bridge-private';
const accessKeyId = process.env.MINIO_TEST_ACCESS_KEY || 'bridgereview';
const secretAccessKey = process.env.MINIO_TEST_SECRET_KEY || 'bridgereview123';
Object.assign(process.env, {
  CDN_PROVIDER: 'minio', PRIVATE_STORAGE_PROVIDER: 'minio', MINIO_ENDPOINT: endpoint,
  MINIO_BUCKET: process.env.MINIO_TEST_PUBLIC_BUCKET || 'bridge-public', PRIVATE_MINIO_BUCKET: bucket,
  MINIO_ACCESS_KEY: accessKeyId, MINIO_SECRET_KEY: secretAccessKey,
  MINIO_PUBLIC_URL: `${endpoint}/${process.env.MINIO_TEST_PUBLIC_BUCKET || 'bridge-public'}`,
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { S3Client, HeadObjectCommand, DeleteObjectCommand, NotFound } from '@aws-sdk/client-s3';

// Load after the private provider configuration, as production does at startup.
const db = require('../../db/loader').default as { _pool: Pool };
const { getPrivateStorageAdapter } = require('../../lib/storageAdapter') as typeof import('../../lib/storageAdapter');
const { runCleanup } = require('../../jobs/cleanupUploads') as typeof import('../../jobs/cleanupUploads');

const prefix = `pgt-collector-${randomUUID()}`;
const user = `${prefix}-u`;
const server = `${prefix}-s`;
const channel = `${prefix}-c`;
const keys = new Set<string>();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-collector-s3-'));
const store = getPrivateStorageAdapter();
const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey } });
const q = (sql: string, values: unknown[] = []) => db._pool.query(sql, values);

async function present(key: string): Promise<boolean> {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch (error) {
    if (error instanceof NotFound && error.$metadata.httpStatusCode === 404) return false;
    throw error;
  }
}

async function object() {
  const key = `uploads/${prefix}-${randomUUID()}.webm`;
  keys.add(key);
  const local = path.join(temporary, path.basename(key));
  fs.writeFileSync(local, 'isolated storage coordination fixture');
  await store.uploadFile(local, key, { contentType: 'audio/webm', deleteLocal: false });
  expect(await present(key)).toBe(true);
  const list = store.listFiles.bind(store);
  jest.spyOn(store, 'listFiles').mockImplementation(async () => {
    // Only this test's actual S3 object is eligible. Age metadata is advanced
    // through the grace window; neither the DB clock nor other objects change.
    const listed = (await list()).filter(item => item.key === key);
    return listed.map(item => ({ ...item, lastModifiedMs: Date.now() - 600_001 }));
  });
  return key;
}

async function writeReference(key: string, query: (sql: string, values: unknown[]) => Promise<unknown> = q) {
  await query(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,type,"fileUrl","createdAt")
    VALUES ($1,$2,$3,$4,'fixture','Fixture','','file',$5,1)`,
  [`${prefix}-m-${randomUUID()}`, channel, server, user, `/${key}`]);
}

beforeAll(async () => {
  expect(Number((await q('SHOW server_version_num')).rows[0].server_version_num)).toBeGreaterThanOrEqual(160000);
  await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$2,1)', [user, 'fixture']);
  await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [server, user]);
  await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$1,1)', [channel, server]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await q('DELETE FROM messages WHERE "serverId"=$1', [server]);
  for (const key of keys) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await q('DELETE FROM upload_release_keys WHERE key=$1', [key]);
  }
  keys.clear();
});

afterAll(async () => {
  await q('DELETE FROM channels WHERE _id=$1', [channel]);
  await q('DELETE FROM servers WHERE _id=$1', [server]);
  await q('DELETE FROM users WHERE _id=$1', [user]);
  fs.rmSync(temporary, { recursive: true, force: true });
  s3.destroy();
  await db._pool.end();
});

test('a late writer is fenced before the actual S3 deletion, rather than committed to missing bytes', async () => {
  const key = await object();
  let committed = false;
  let refusal: unknown;
  const remove = store.deleteFile.bind(store);
  const deleting = jest.spyOn(store, 'deleteFile').mockImplementation(async candidate => {
    expect(candidate).toBe(key);
    try { await writeReference(key); committed = true; }
    catch (error) { refusal = error; }
    await remove(candidate);
  });
  await runCleanup();
  expect(deleting).toHaveBeenCalledTimes(1);
  expect({ committed, present: await present(key) }).toEqual({ committed: false, present: false });
  expect(refusal).toMatchObject({ code: '55000', message: 'upload_release_reserved' });
  expect((await q('SELECT _id FROM messages WHERE "serverId"=$1', [server])).rows).toHaveLength(0);
  expect((await q('SELECT reserved FROM upload_release_keys WHERE key=$1', [key])).rows).toEqual([{ reserved: true }]);
});

test('a committed permanent-channel reference keeps its actual S3 object', async () => {
  const key = await object();
  await writeReference(key);
  const deleting = jest.spyOn(store, 'deleteFile');
  await runCleanup();
  expect(deleting).not.toHaveBeenCalled();
  expect(await present(key)).toBe(true);
  expect((await q('SELECT _id FROM messages WHERE "serverId"=$1', [server])).rows).toHaveLength(1);
});

test('an in-flight writer commits before the reservation scan and keeps its object', async () => {
  const key = await object();
  const writer = await db._pool.connect();
  const deleting = jest.spyOn(store, 'deleteFile');
  let cleanup: Promise<void> | undefined;
  let observedLock = false;
  try {
    await writer.query('BEGIN');
    await writeReference(key, (sql, values) => writer.query(sql, values));
    cleanup = runCleanup();
    for (let i = 0; i < 150; i++) {
      if (deleting.mock.calls.length) break; // The former unsafe path cannot masquerade as a lock wait.
      const waiting = await q(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%INSERT INTO upload_release_keys AS k%') AS waiting`);
      if (waiting.rows[0].waiting) { observedLock = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await writer.query('COMMIT');
    await cleanup;
    expect(observedLock).toBe(true);
    expect(deleting).not.toHaveBeenCalled();
    expect(await present(key)).toBe(true);
    expect((await q('SELECT reserved FROM upload_release_keys WHERE key=$1', [key])).rows).toEqual([{ reserved: false }]);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await cleanup;
  }
});

test('a storage outage preserves the reservation and a subsequent job releases the real object', async () => {
  const key = await object();
  const remove = store.deleteFile.bind(store);
  const deleting = jest.spyOn(store, 'deleteFile').mockImplementation(remove)
    .mockRejectedValueOnce(new Error('isolated storage outage'));
  await runCleanup();
  expect(await present(key)).toBe(true);
  expect((await q('SELECT reserved FROM upload_release_keys WHERE key=$1', [key])).rows).toEqual([{ reserved: true }]);
  await expect(writeReference(key)).rejects.toMatchObject({ code: '55000', message: 'upload_release_reserved' });
  await runCleanup();
  expect(deleting).toHaveBeenCalledTimes(2);
  expect(await present(key)).toBe(false);
  await runCleanup();
  expect(deleting).toHaveBeenCalledTimes(2);
});

test('a lost acknowledgement after physical deletion cannot resurrect a reference on a later run', async () => {
  const key = await object();
  const remove = store.deleteFile.bind(store);
  const deleting = jest.spyOn(store, 'deleteFile').mockImplementation(async candidate => {
    await remove(candidate);
    throw new Error('isolated acknowledgement loss after deletion');
  });
  await runCleanup();
  expect(await present(key)).toBe(false);
  expect((await q('SELECT reserved FROM upload_release_keys WHERE key=$1', [key])).rows).toEqual([{ reserved: true }]);
  await runCleanup();
  expect(deleting).toHaveBeenCalledTimes(1);
  await expect(writeReference(key)).rejects.toMatchObject({ code: '55000', message: 'upload_release_reserved' });
  expect((await q('SELECT _id FROM messages WHERE "serverId"=$1', [server])).rows).toHaveLength(0);
});
