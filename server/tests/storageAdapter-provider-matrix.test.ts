process.env.NODE_ENV = 'test';

import fs from 'fs';

const clientConfigs: Array<Record<string, unknown>> = [];
const commandInputs: Array<{ name: string; input: Record<string, unknown> }> = [];
const send = jest.fn(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
  if (cmd.constructor.name === 'ListObjectsV2Command') return { Contents: [], IsTruncated: false };
  if (cmd.constructor.name === 'GetObjectCommand') return { Body: { pipe: jest.fn(), on: jest.fn() } };
  return {};
});

jest.mock('../lib/_optional-require', () => {
  function command(name: string) {
    const Ctor = class {
      input: Record<string, unknown>;
      constructor(input: Record<string, unknown>) {
        this.input = input;
        commandInputs.push({ name, input });
      }
    };
    Object.defineProperty(Ctor, 'name', { value: name });
    return Ctor;
  }
  class FakeS3Client {
    constructor(config: Record<string, unknown>) { clientConfigs.push(config); }
    send = send;
  }
  return {
    tryRequire: () => ({
      S3Client: FakeS3Client,
      ListObjectsV2Command: command('ListObjectsV2Command'),
      PutObjectCommand: command('PutObjectCommand'),
      DeleteObjectCommand: command('DeleteObjectCommand'),
      GetObjectCommand: command('GetObjectCommand'),
    }),
  };
});

jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    createReadStream: jest.fn(() => ({ pipe: jest.fn(), on: jest.fn() })),
    unlink: jest.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
  };
});

import logger from '../lib/logger';
import {
  _resetAdapterForTest,
  getPrivateStorageAdapter,
  getPrivateStorageProvider,
  getProvider,
  getStorageAdapter,
  localAdapter,
} from '../lib/storageAdapter';

const ENV_KEYS = [
  'CDN_PROVIDER','S3_BUCKET','S3_REGION','S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','S3_PUBLIC_URL',
  'R2_BUCKET','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_PUBLIC_URL',
  'MINIO_ENDPOINT','MINIO_BUCKET','MINIO_ACCESS_KEY','MINIO_SECRET_KEY','MINIO_PUBLIC_URL',
  'B2_BUCKET_NAME','B2_REGION','B2_KEY_ID','B2_APP_KEY','B2_PUBLIC_URL',
  'PRIVATE_STORAGE_PROVIDER','PRIVATE_S3_BUCKET','PRIVATE_R2_BUCKET','PRIVATE_MINIO_BUCKET','PRIVATE_B2_BUCKET_NAME',
];

function clearEnv() { for (const key of ENV_KEYS) delete process.env[key]; }

beforeEach(() => {
  clearEnv();
  _resetAdapterForTest();
  clientConfigs.length = 0;
  commandInputs.length = 0;
  send.mockClear();
  jest.clearAllMocks();
});

afterAll(clearEnv);

type ProviderCase = {
  provider: 's3'|'r2'|'minio'|'b2';
  env: Record<string,string>;
  privateBucketKey: string;
  publicBucketKey: string;
  expected: Partial<Record<string, unknown>>;
  publicUrl: string;
};

const CASES: ProviderCase[] = [
  {
    provider: 's3',
    env: { S3_BUCKET:'public-s3', S3_REGION:'eu-west-1', S3_ENDPOINT:'https://s3.internal', S3_ACCESS_KEY_ID:'ak', S3_SECRET_ACCESS_KEY:'sk', S3_PUBLIC_URL:'https://cdn.example/s3/' },
    privateBucketKey: 'PRIVATE_S3_BUCKET', publicBucketKey: 'S3_BUCKET',
    expected: { region:'eu-west-1', endpoint:'https://s3.internal', forcePathStyle:false }, publicUrl:'https://cdn.example/s3',
  },
  {
    provider: 'r2',
    env: { R2_BUCKET:'public-r2', R2_ACCOUNT_ID:'acct', R2_ACCESS_KEY_ID:'rak', R2_SECRET_ACCESS_KEY:'rsk', R2_PUBLIC_URL:'https://pub.r2.dev/' },
    privateBucketKey: 'PRIVATE_R2_BUCKET', publicBucketKey: 'R2_BUCKET',
    expected: { region:'auto', endpoint:'https://acct.r2.cloudflarestorage.com', forcePathStyle:false }, publicUrl:'https://pub.r2.dev',
  },
  {
    provider: 'minio',
    env: { MINIO_ENDPOINT:'http://minio:9000/', MINIO_BUCKET:'public-minio', MINIO_ACCESS_KEY:'mak', MINIO_SECRET_KEY:'msk', MINIO_PUBLIC_URL:'https://minio.example/public/' },
    privateBucketKey: 'PRIVATE_MINIO_BUCKET', publicBucketKey: 'MINIO_BUCKET',
    expected: { region:'us-east-1', endpoint:'http://minio:9000', forcePathStyle:true }, publicUrl:'https://minio.example/public',
  },
  {
    provider: 'b2',
    env: { B2_BUCKET_NAME:'public-b2', B2_REGION:'us-west-002', B2_KEY_ID:'bak', B2_APP_KEY:'bsk', B2_PUBLIC_URL:'https://b2.example/files/' },
    privateBucketKey: 'PRIVATE_B2_BUCKET_NAME', publicBucketKey: 'B2_BUCKET_NAME',
    expected: { region:'us-west-002', endpoint:'https://s3.us-west-002.backblazeb2.com', forcePathStyle:false }, publicUrl:'https://b2.example/files',
  },
];

describe('remote provider factory matrix', () => {
  it.each(CASES)('$provider builds the expected public adapter and singleton', async ({ provider, env, expected, publicUrl }) => {
    process.env.CDN_PROVIDER = provider;
    Object.assign(process.env, env);
    const adapter = getStorageAdapter();
    expect(getProvider()).toBe(provider);
    expect(getStorageAdapter()).toBe(adapter);
    expect(clientConfigs[0]).toEqual(expect.objectContaining(expected));
    expect(adapter.publicUrlForKey('uploads/a.bin')).toBe(`${publicUrl}/uploads/a.bin`);
    await adapter.listFiles();
    expect(commandInputs.some(c => c.name === 'ListObjectsV2Command' && c.input.Prefix === 'uploads/' && c.input.Delimiter === '/')).toBe(true);
  });

  it('S3 default public URL and region are deterministic', () => {
    process.env.CDN_PROVIDER='s3'; process.env.S3_BUCKET='bucket'; process.env.S3_ACCESS_KEY_ID='k'; process.env.S3_SECRET_ACCESS_KEY='s';
    const a = getStorageAdapter();
    expect(a.publicUrlForKey('uploads/a.txt')).toBe('https://s3.us-east-1.amazonaws.com/bucket/uploads/a.txt');
    expect(clientConfigs[0]).toEqual(expect.objectContaining({ region:'us-east-1' }));
  });

  it('B2 default public URL and region are deterministic', () => {
    process.env.CDN_PROVIDER='b2'; process.env.B2_BUCKET_NAME='bucket'; process.env.B2_KEY_ID='k'; process.env.B2_APP_KEY='s';
    const a = getStorageAdapter();
    expect(a.publicUrlForKey('uploads/a.txt')).toBe('https://f000.backblazeb2.com/file/bucket/uploads/a.txt');
    expect(clientConfigs[0]).toEqual(expect.objectContaining({ region:'us-west-004' }));
  });

  it('MinIO default credentials produce a security warning when explicitly configured', () => {
    process.env.CDN_PROVIDER='minio'; process.env.MINIO_ENDPOINT='http://minio:9000'; process.env.MINIO_BUCKET='bucket'; process.env.MINIO_ACCESS_KEY='minioadmin'; process.env.MINIO_SECRET_KEY='minioadmin';
    getStorageAdapter();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event:'storage.minio.default_credentials' }), expect.any(String));
  });

  it('production rejects MinIO default credentials instead of merely warning', () => {
    const oldNodeEnv=process.env.NODE_ENV;
    process.env.NODE_ENV='production';
    process.env.CDN_PROVIDER='minio'; process.env.MINIO_ENDPOINT='http://minio:9000'; process.env.MINIO_BUCKET='bucket'; process.env.MINIO_ACCESS_KEY='minioadmin'; process.env.MINIO_SECRET_KEY='minioadmin';
    try { expect(() => getStorageAdapter()).toThrow(/minioadmin|varsayılan/i); }
    finally { process.env.NODE_ENV=oldNodeEnv; }
  });

  it('unknown public storage provider fails closed instead of silently writing to local disk', () => {
    process.env.CDN_PROVIDER='dropbox';
    expect(() => getStorageAdapter()).toThrow(/Bilinmeyen CDN_PROVIDER=dropbox|fail-closed/);
  });

  it.each([
    ['r2', {R2_BUCKET:'b',R2_ACCOUNT_ID:'a',R2_ACCESS_KEY_ID:'k',R2_SECRET_ACCESS_KEY:'s'}],
    ['minio', {MINIO_BUCKET:'b',MINIO_ACCESS_KEY:'k',MINIO_SECRET_KEY:'s'}],
    ['b2', {B2_BUCKET_NAME:'b',B2_KEY_ID:'k'}],
  ] as Array<[string, Record<string,string>]>)('%s fails fast when a required credential is absent', (provider, env) => {
    process.env.CDN_PROVIDER=provider; Object.assign(process.env,env);
    expect(() => getStorageAdapter()).toThrow(/zorunlu env|eksik|boş/i);
  });
});

describe('private provider matrix', () => {
  it('provider name is case-insensitive and local remains the safe default', () => {
    expect(getPrivateStorageProvider()).toBe('local');
    process.env.PRIVATE_STORAGE_PROVIDER='LOCAL';
    expect(getPrivateStorageProvider()).toBe('local');
    expect(getPrivateStorageAdapter()).toBe(localAdapter);
  });

  it.each(CASES)('$provider private adapter uses distinct bucket and private/no-store cache', async ({ provider, env, privateBucketKey, publicBucketKey }) => {
    process.env.CDN_PROVIDER=provider;
    process.env.PRIVATE_STORAGE_PROVIDER=provider;
    Object.assign(process.env,env);
    process.env[privateBucketKey]=`private-${provider}`;
    // Make the public bucket deliberately different even if the case env key changes.
    process.env[publicBucketKey]=`public-${provider}`;
    const adapter=getPrivateStorageAdapter();
    expect(getPrivateStorageAdapter()).toBe(adapter);
    expect(() => adapter.publicUrlForKey('uploads/secret.bin')).toThrow(/private storage|public URL/i);
    await adapter.uploadFile(__filename,'uploads/secret.bin',{deleteLocal:false});
    expect(commandInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name:'PutObjectCommand', input:expect.objectContaining({ Bucket:`private-${provider}`, Key:'uploads/secret.bin', CacheControl:'private, no-store' }) }),
    ]));
  });

  it.each(CASES)('$provider rejects a private bucket equal to the public bucket', ({ provider, env, privateBucketKey, publicBucketKey }) => {
    process.env.CDN_PROVIDER=provider;
    process.env.PRIVATE_STORAGE_PROVIDER=provider;
    Object.assign(process.env,env);
    process.env[privateBucketKey]='same-bucket';
    process.env[publicBucketKey]='same-bucket';
    expect(() => getPrivateStorageAdapter()).toThrow(/aynı olamaz|ayrı|separate/i);
  });

  it.each(CASES)('$provider private config fails closed when private bucket is absent', ({ provider, env, privateBucketKey }) => {
    process.env.CDN_PROVIDER='local';
    process.env.PRIVATE_STORAGE_PROVIDER=provider;
    Object.assign(process.env,env);
    delete process.env[privateBucketKey];
    expect(() => getPrivateStorageAdapter()).toThrow(new RegExp(privateBucketKey));
  });

  it('remote public + local private warns about multi-node durability but stays local', () => {
    process.env.CDN_PROVIDER='s3';
    process.env.S3_BUCKET='public'; process.env.S3_ACCESS_KEY_ID='k'; process.env.S3_SECRET_ACCESS_KEY='s';
    expect(getPrivateStorageAdapter()).toBe(localAdapter);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event:'storage.private_local_with_remote_public' }), expect.any(String));
  });
});

describe('local defensive branches', () => {
  it('delete traversal is rejected and logged rather than reported as a successful delete', async () => {
    await expect(localAdapter.deleteFile('../escape.bin')).rejects.toMatchObject({ code:'EINVAL' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event:'storage.delete_traversal_blocked' }), expect.any(String));
  });

  it('keyFromUrl falls back to basename for a non-URL value without uploads marker', () => {
    expect(localAdapter.keyFromUrl('plain.bin')).toBe('plain.bin');
  });

  it('remote upload local-delete callback logs but does not fail upload', async () => {
    process.env.CDN_PROVIDER='s3'; process.env.S3_BUCKET='bucket'; process.env.S3_ACCESS_KEY_ID='k'; process.env.S3_SECRET_ACCESS_KEY='s';
    (fs.unlink as unknown as jest.Mock).mockImplementationOnce((_p: string, cb: (err: Error|null)=>void) => cb(new Error('busy')));
    const out=await getStorageAdapter().uploadFile(__filename,'uploads/a.bin');
    expect(out.provider).toBe('s3');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event:'storage.local_delete_failed' }), expect.any(String));
  });
});
