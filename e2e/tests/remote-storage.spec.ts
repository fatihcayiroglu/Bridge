// Real S3-compatible object-store E2E; do not mock the S3 client or skip.
import { test, expect } from '../helpers/apiTest';
import { request as pwRequest } from '@playwright/test';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getTokens } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('MinIO protected upload: real bucket, exact bytes, Bridge authorization', async ({ request }) => {
  for (const name of ['MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_BUCKET', 'PRIVATE_MINIO_BUCKET']) {
    expect(process.env[name], 'Missing CI fixture: ' + name).toBeTruthy();
  }
  expect(process.env.CDN_PROVIDER).toBe('minio');
  expect(process.env.PRIVATE_STORAGE_PROVIDER).toBe('minio');
  const bucket = process.env.PRIVATE_MINIO_BUCKET!;
  const publicBucket = process.env.MINIO_BUCKET!;
  expect(bucket).not.toBe(publicBucket);
  const endpoint = process.env.MINIO_ENDPOINT!;
  const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY!, secretAccessKey: process.env.MINIO_SECRET_KEY!,
  } });
  try {
    // Positive control: a service which denies everything must not count as a privacy pass.
    const publicKey = 'positive-control-' + Date.now() + '.txt';
    const publicBytes = Buffer.from('Bridge public-object policy');
    await s3.send(new PutObjectCommand({ Bucket: publicBucket, Key: publicKey, Body: publicBytes }));
    const anon = await pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const res = await anon.get(endpoint + '/' + publicBucket + '/' + publicKey);
      expect(res.status()).toBe(200);
      expect(await res.body()).toEqual(publicBytes);
    } finally {
      await anon.dispose();
      await s3.send(new DeleteObjectCommand({ Bucket: publicBucket, Key: publicKey }));
    }
    const before = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    const prior = new Set((before.Contents ?? []).map(x => x.Key).filter(Boolean));
    const upload = await request.post(BASE + '/api/upload', {
      headers: { Authorization: 'Bearer ' + getTokens().alice },
      multipart: { file: { name: 'remote.png', mimeType: 'image/png', buffer: PNG } },
    });
    expect(upload.status(), await upload.text()).toBe(200);
    const body = await upload.json() as { url?: string; fileUrl?: string; key?: string };
    const url = body.url ?? body.fileUrl ?? '';
    expect(url).toMatch(/^\/uploads\/[A-Za-z0-9._-]+$/);
    expect(body.key).toBeUndefined();

    const after = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    const newKeys = (after.Contents ?? []).map(x => x.Key).filter((x): x is string => !!x && !prior.has(x));
    expect(newKeys).toHaveLength(1);
    const key = newKeys[0];
    if (!key) throw new Error('No object in remote private bucket');
    const stored = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!stored.Body) throw new Error('S3 object body missing');
    expect(Buffer.from(await stored.Body.transformToByteArray())).toEqual(PNG);

    const anonymous = await pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const viaBridge = await anonymous.get(BASE + url);
      expect([401, 403]).toContain(viaBridge.status());
      const direct = await anonymous.get(endpoint + '/' + bucket + '/' + key.split('/').map(encodeURIComponent).join('/'));
      expect([401, 403]).toContain(direct.status());
    } finally { await anonymous.dispose(); }
    const owner = await request.get(BASE + url, { headers: { Authorization: 'Bearer ' + getTokens().alice } });
    expect(owner.status()).toBe(200);
    expect(await owner.body()).toEqual(PNG);
  } finally { s3.destroy(); }
});
