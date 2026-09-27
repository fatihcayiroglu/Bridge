// server/tests/storage-adapter-provider-config.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/storageAdapter.ts — SAĞLAYICI SEÇİMİ VE KORUNAN DEPOLAMA SINIRI
// ════════════════════════════════════════════════════════════════════════════
// Bu modül iki AYRI depolama sahipliğini yönetir:
//
//   • PUBLIC CDN  — avatar/emoji/GIF gibi zaten herkese açık baytlar.
//   • PRIVATE     — mesaj eki ve sesli mesaj baytları. Bunlar YETKİLENDİRME
//     KORUMALI veridir ve public bucket ile AYNI yere yazılamaz: aynı bucket
//     kullanılırsa bir public bucket policy'si ya da CDN origin'i Bridge'in
//     yetki katmanını tamamen atlar.
//
// Ölçülen sözleşmeler:
//   1. Her sağlayıcı için yapılandırma GERÇEK env değerlerinden kurulur
//      (bölge, endpoint, kimlik bilgileri, public URL türetmesi).
//   2. Eksik/boş zorunlu env FAIL-CLOSED'dır: adapter kurulmaz, hata atılır.
//   3. Private bucket public bucket ile aynı olamaz.
//   4. Üretimde varsayılan MinIO kimlik bilgileri REDDEDİLİR.
process.env.NODE_ENV = 'test';

import {
  _resetAdapterForTest,
  getPrivateStorageAdapter,
  getPrivateStorageProvider,
  getProvider,
  getStorageAdapter,
} from '../lib/storageAdapter';

const STORAGE_KEYS = [
  'CDN_PROVIDER', 'PRIVATE_STORAGE_PROVIDER',
  'S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_URL',
  'R2_BUCKET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_URL',
  'MINIO_ENDPOINT', 'MINIO_BUCKET', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_PUBLIC_URL',
  'B2_BUCKET_NAME', 'B2_REGION', 'B2_KEY_ID', 'B2_APP_KEY', 'B2_PUBLIC_URL',
  'PRIVATE_S3_BUCKET', 'PRIVATE_R2_BUCKET', 'PRIVATE_MINIO_BUCKET', 'PRIVATE_B2_BUCKET_NAME',
];

const saved: Record<string, string | undefined> = {};

beforeAll(() => { for (const key of STORAGE_KEYS) saved[key] = process.env[key]; });
afterAll(() => {
  for (const key of STORAGE_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  process.env.NODE_ENV = 'test';
  _resetAdapterForTest();
});

beforeEach(() => {
  for (const key of STORAGE_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
  _resetAdapterForTest();
});

describe('public CDN provider selection', () => {
  it('defaults to local disk and caches the singleton', () => {
    expect(getProvider()).toBe('local');
    const adapter = getStorageAdapter();
    expect(getStorageAdapter()).toBe(adapter);
  });

  it('rejects an unknown provider fail-closed rather than silently using local disk', () => {
    process.env.CDN_PROVIDER = 'dropbox';
    expect(() => getStorageAdapter()).toThrow(/Bilinmeyen CDN_PROVIDER/);
  });

  it.each([
    ['s3', { S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }],
    ['r2', { R2_BUCKET: 'b', R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_PUBLIC_URL: 'https://cdn.test' }],
    ['minio', { MINIO_ENDPOINT: 'http://minio:9000', MINIO_BUCKET: 'b', MINIO_ACCESS_KEY: 'k', MINIO_SECRET_KEY: 's' }],
    ['b2', { B2_BUCKET_NAME: 'b', B2_KEY_ID: 'k', B2_APP_KEY: 's' }],
  ])('builds the %s adapter from configured credentials', (provider, env) => {
    process.env.CDN_PROVIDER = provider;
    Object.assign(process.env, env);
    const adapter = getStorageAdapter();
    expect(typeof adapter.uploadFile).toBe('function');
    expect(typeof adapter.deleteFile).toBe('function');
    expect(typeof adapter.publicUrlForKey).toBe('function');
  });

  it.each([
    ['s3', { S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }, /S3_BUCKET/],
    ['r2', { R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }, /R2_ACCOUNT_ID/],
    ['minio', { MINIO_BUCKET: 'b', MINIO_ACCESS_KEY: 'k', MINIO_SECRET_KEY: 's' }, /MINIO_ENDPOINT/],
    ['b2', { B2_BUCKET_NAME: 'b', B2_KEY_ID: 'k' }, /B2_APP_KEY/],
  ])('refuses to start %s with a missing required variable', (provider, env, pattern) => {
    process.env.CDN_PROVIDER = provider;
    Object.assign(process.env, env);
    expect(() => getStorageAdapter()).toThrow(pattern as RegExp);
  });

  it('treats a whitespace-only credential as missing', () => {
    process.env.CDN_PROVIDER = 's3';
    process.env.S3_BUCKET = '  ';
    process.env.S3_ACCESS_KEY_ID = 'k';
    process.env.S3_SECRET_ACCESS_KEY = 's';
    expect(() => getStorageAdapter()).toThrow(/S3_BUCKET/);
  });
});

describe('MinIO default credential guard', () => {
  const minioEnv = { MINIO_ENDPOINT: 'http://minio:9000', MINIO_BUCKET: 'b' };

  it('warns but allows the shipped defaults outside production', () => {
    process.env.CDN_PROVIDER = 'minio';
    Object.assign(process.env, minioEnv, { MINIO_ACCESS_KEY: 'minioadmin', MINIO_SECRET_KEY: 'minioadmin' });
    expect(() => getStorageAdapter()).not.toThrow();
  });

  it('refuses to start production on the shipped default credentials', () => {
    process.env.NODE_ENV = 'PRODUCTION';
    process.env.CDN_PROVIDER = 'minio';
    Object.assign(process.env, minioEnv, { MINIO_ACCESS_KEY: 'minioadmin', MINIO_SECRET_KEY: 'minioadmin' });
    expect(() => getStorageAdapter()).toThrow(/minioadmin/);
  });

  it('accepts production once both shipped defaults are replaced', () => {
    process.env.NODE_ENV = 'production';
    process.env.CDN_PROVIDER = 'minio';
    Object.assign(process.env, minioEnv, { MINIO_ACCESS_KEY: 'real-key', MINIO_SECRET_KEY: 'real-secret' });
    expect(() => getStorageAdapter()).not.toThrow();
  });
});

describe('protected attachment storage', () => {
  it('defaults to local disk even when the public CDN is remote', () => {
    process.env.CDN_PROVIDER = 's3';
    Object.assign(process.env, { S3_BUCKET: 'public', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' });
    expect(getPrivateStorageProvider()).toBe('local');
    const adapter = getPrivateStorageAdapter();
    expect(getPrivateStorageAdapter()).toBe(adapter);
  });

  it.each([
    ['s3', { PRIVATE_S3_BUCKET: 'private', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }],
    ['r2', { PRIVATE_R2_BUCKET: 'private', R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }],
    ['minio', { PRIVATE_MINIO_BUCKET: 'private', MINIO_ENDPOINT: 'http://minio:9000', MINIO_ACCESS_KEY: 'k', MINIO_SECRET_KEY: 's' }],
    ['b2', { PRIVATE_B2_BUCKET_NAME: 'private', B2_KEY_ID: 'k', B2_APP_KEY: 's' }],
  ])('builds a private %s adapter with its own bucket', (provider, env) => {
    process.env.PRIVATE_STORAGE_PROVIDER = provider;
    Object.assign(process.env, env);
    expect(getPrivateStorageProvider()).toBe(provider);
    expect(typeof getPrivateStorageAdapter().uploadFile).toBe('function');
  });

  it.each([
    ['s3', { S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }, /PRIVATE_S3_BUCKET/],
    ['r2', { PRIVATE_R2_BUCKET: 'p', R2_ACCESS_KEY_ID: 'k' }, /R2_ACCOUNT_ID/],
    ['minio', { PRIVATE_MINIO_BUCKET: 'p', MINIO_ACCESS_KEY: 'k' }, /MINIO_ENDPOINT/],
    ['b2', { PRIVATE_B2_BUCKET_NAME: 'p', B2_KEY_ID: 'k' }, /B2_APP_KEY/],
  ])('refuses a private %s configuration that is incomplete', (provider, env, pattern) => {
    process.env.PRIVATE_STORAGE_PROVIDER = provider;
    Object.assign(process.env, env);
    expect(() => getPrivateStorageAdapter()).toThrow(pattern as RegExp);
  });

  it('refuses to share one bucket between the public CDN and protected attachments', () => {
    process.env.CDN_PROVIDER = 's3';
    process.env.PRIVATE_STORAGE_PROVIDER = 's3';
    Object.assign(process.env, {
      S3_BUCKET: 'shared', PRIVATE_S3_BUCKET: ' shared ',
      S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
    });
    expect(() => getPrivateStorageAdapter()).toThrow(/aynı olamaz/);
  });

  it('allows the same provider when the private bucket is genuinely distinct', () => {
    process.env.CDN_PROVIDER = 's3';
    process.env.PRIVATE_STORAGE_PROVIDER = 's3';
    Object.assign(process.env, {
      S3_BUCKET: 'public-bucket', PRIVATE_S3_BUCKET: 'private-bucket',
      S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
    });
    expect(typeof getPrivateStorageAdapter().uploadFile).toBe('function');
  });

  it('applies the public-bucket collision check only within the same provider', () => {
    process.env.CDN_PROVIDER = 'minio';
    process.env.PRIVATE_STORAGE_PROVIDER = 's3';
    Object.assign(process.env, {
      MINIO_ENDPOINT: 'http://minio:9000', MINIO_BUCKET: 'shared',
      MINIO_ACCESS_KEY: 'k', MINIO_SECRET_KEY: 's',
      PRIVATE_S3_BUCKET: 'shared', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
    });
    expect(typeof getPrivateStorageAdapter().uploadFile).toBe('function');
  });

  it('rejects an unsupported private provider name', () => {
    process.env.PRIVATE_STORAGE_PROVIDER = 'dropbox';
    expect(() => getPrivateStorageAdapter()).toThrow();
  });

  it('rejects production private MinIO on the shipped default credentials', () => {
    process.env.NODE_ENV = 'production';
    process.env.PRIVATE_STORAGE_PROVIDER = 'minio';
    Object.assign(process.env, {
      PRIVATE_MINIO_BUCKET: 'private', MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_ACCESS_KEY: 'minioadmin', MINIO_SECRET_KEY: 'minioadmin',
    });
    expect(() => getPrivateStorageAdapter()).toThrow(/minioadmin/);
  });
});
