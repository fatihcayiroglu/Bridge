#!/usr/bin/env node
// CI-only real S3 fixture: anonymous public reads are deliberately enabled.
import { S3Client, CreateBucketCommand, PutBucketPolicyCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
const endpoint = process.env.MINIO_ENDPOINT;
const publicBucket = process.env.MINIO_BUCKET;
const privateBucket = process.env.PRIVATE_MINIO_BUCKET;
const credentials = { accessKeyId: process.env.MINIO_ACCESS_KEY || '', secretAccessKey: process.env.MINIO_SECRET_KEY || '' };
if (!endpoint || !publicBucket || !privateBucket || !credentials.accessKeyId || !credentials.secretAccessKey) {
  throw new Error('S3 CI fixture not configured');
}
if (publicBucket === privateBucket) throw new Error('Public and private buckets must differ');
const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials });
try {
  for (const Bucket of [publicBucket, privateBucket]) {
    await s3.send(new CreateBucketCommand({ Bucket }));
    await s3.send(new HeadBucketCommand({ Bucket }));
  }
  await s3.send(new PutBucketPolicyCommand({ Bucket: publicBucket, Policy: JSON.stringify({
    Version: '2012-10-17', Statement: [{ Sid: 'BridgeCiPublicRead', Effect: 'Allow',
      Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::' + publicBucket + '/*'] }],
  }) }));
  console.log('Real MinIO buckets ready: public anonymous read, private protected');
} finally { s3.destroy(); }
