process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';

const mockInputs: Array<Record<string, unknown>> = [];

jest.mock('../lib/_optional-require', () => {
  class FakeS3Client {
    async send(): Promise<Record<string, unknown>> {
      return { Contents: [], IsTruncated: false };
    }
  }
  class FakeCommand {
    constructor(input: Record<string, unknown>) { mockInputs.push(input); }
  }
  return {
    tryRequire: () => ({
      S3Client: FakeS3Client,
      ListObjectsV2Command: FakeCommand,
      PutObjectCommand: FakeCommand,
      DeleteObjectCommand: FakeCommand,
      GetObjectCommand: FakeCommand,
    }),
  };
});

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

import {
  _resetAdapterForTest,
  getPrivateStorageAdapter,
  getPrivateStorageProvider,
  localAdapter,
} from '../lib/storageAdapter';

const ENV_KEYS = [
  'CDN_PROVIDER', 'PRIVATE_STORAGE_PROVIDER',
  'S3_BUCKET', 'PRIVATE_S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  'R2_BUCKET', 'PRIVATE_R2_BUCKET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'MINIO_BUCKET', 'PRIVATE_MINIO_BUCKET', 'MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY',
  'B2_BUCKET_NAME', 'PRIVATE_B2_BUCKET_NAME', 'B2_KEY_ID', 'B2_APP_KEY',
];

beforeEach(() => {
  _resetAdapterForTest();
  mockInputs.length = 0;
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  _resetAdapterForTest();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('protected attachment storage boundary', () => {
  it('does not inherit a remote public CDN implicitly', () => {
    process.env.CDN_PROVIDER = 'r2';
    expect(getPrivateStorageProvider()).toBe('local');
    expect(getPrivateStorageAdapter()).toBe(localAdapter);
  });

  it('fails closed when public and private S3 buckets are identical', () => {
    process.env.CDN_PROVIDER = 's3';
    process.env.PRIVATE_STORAGE_PROVIDER = 's3';
    process.env.S3_BUCKET = 'bridge-public';
    process.env.PRIVATE_S3_BUCKET = 'bridge-public';
    process.env.S3_ACCESS_KEY_ID = 'key';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';

    expect(() => getPrivateStorageAdapter()).toThrow(/aynı olamaz|ayrı|separate/i);
  });

  it('docker compose forwards the private storage contract into the Bridge container', () => {
    const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
    for (const key of [
      'PRIVATE_STORAGE_PROVIDER', 'PRIVATE_S3_BUCKET', 'PRIVATE_R2_BUCKET',
      'PRIVATE_MINIO_BUCKET', 'PRIVATE_B2_BUCKET_NAME',
    ]) {
      expect(compose).toContain(`${key}:`);
    }
    // S3 is a supported public CDN provider too; Compose must not advertise it
    // while silently omitting the credentials/bucket the server actually reads.
    for (const key of ['S3_REGION', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_PUBLIC_URL']) {
      expect(compose).toContain(`${key}:`);
    }
  });

  it('remote private storage has no public URL surface and addresses only its private bucket', async () => {
    process.env.CDN_PROVIDER = 's3';
    process.env.PRIVATE_STORAGE_PROVIDER = 's3';
    process.env.S3_BUCKET = 'bridge-public';
    process.env.PRIVATE_S3_BUCKET = 'bridge-private';
    process.env.S3_ACCESS_KEY_ID = 'key';
    process.env.S3_SECRET_ACCESS_KEY = 'secret';

    const adapter = getPrivateStorageAdapter();
    expect(() => adapter.publicUrlForKey('uploads/secret.png')).toThrow(/private storage|public URL/i);
    await adapter.listFiles();
    await adapter.uploadFile(__filename, 'uploads/secret.bin', {
      deleteLocal: false,
      contentType: 'application/octet-stream',
    });
    expect(mockInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ Bucket: 'bridge-private', Prefix: 'uploads/' }),
      expect.objectContaining({
        Bucket: 'bridge-private',
        Key: 'uploads/secret.bin',
        CacheControl: 'private, no-store',
      }),
    ]));
    expect(mockInputs.some((input) => input.Bucket === 'bridge-public')).toBe(false);
  });
});
