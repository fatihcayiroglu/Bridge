/** Actual voice HTTP/JWT, PG, Redis, S3 and multipart HTTP transcription.
 * The test changes only the provider destination, preserving provider selection.
 * Socket test principals enter the real membership/permission join handler;
 * this is not a claim of full socket authentication or speech recognition.
 */
import '../helpers/realRedisFixture';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Server as SocketServer } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import type { HandlerSocket } from '../../socket/handler-contracts';
import { S3Client, DeleteObjectCommand, HeadObjectCommand, NotFound } from '@aws-sdk/client-s3';

const endpoint = process.env.MINIO_TEST_ENDPOINT;
if (!process.env.PG_TEST_URL || !endpoint) throw new Error('Voice transcription expiry requires real PG, Redis and S3 fixtures');
const bucket = process.env.MINIO_TEST_PRIVATE_BUCKET || 'bridge-private';
const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-transcription-expiry-'));
Object.assign(process.env, {
  PRIVATE_STORAGE_PROVIDER: 'minio', CDN_PROVIDER: 'minio', MINIO_ENDPOINT: endpoint,
  MINIO_BUCKET: process.env.MINIO_TEST_PUBLIC_BUCKET || 'bridge-public', PRIVATE_MINIO_BUCKET: bucket,
  MINIO_ACCESS_KEY: process.env.MINIO_TEST_ACCESS_KEY || 'bridgereview',
  MINIO_SECRET_KEY: process.env.MINIO_TEST_SECRET_KEY || 'bridgereview123',
  MINIO_PUBLIC_URL: `${endpoint}/${process.env.MINIO_TEST_PUBLIC_BUCKET || 'bridge-public'}`,
  BRIDGE_UPLOAD_ROOT: uploads, AI_PROVIDER: 'groq', GROQ_API_KEY: 'isolated-transcription-provider-fixture',
});

const db = require('../../db/loader').default as typeof import('../../db/postgres').default;
const ai = require('../../lib/aiProvider') as typeof import('../../lib/aiProvider');
const policy = require('../../lib/aiServerPolicy') as typeof import('../../lib/aiServerPolicy');
const { Messages } = require('../../db/repositories') as typeof import('../../db/repositories');
const { makeToken } = require('../../middleware/auth') as typeof import('../../middleware/auth');
const { setupMemberships } = require('../../socket/handlers/members') as typeof import('../../socket/handlers/members');
const router = require('../../routes/voicemsg').default;
const q = (sql: string, values: unknown[] = []) => db._pool.query(sql, values);
const transcript = 'isolated voice transcript fixture';
const audio = Buffer.from('isolated audio payload fixture');

interface Gate { promise: Promise<void>; release(): void }
const gates = new Set<Gate>();
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  const result = { promise, release };
  gates.add(result);
  return result;
}

const providerCalls: Array<{ audioPresent: boolean; multipart: boolean }> = [];
let providerArrival: Gate | undefined;
let providerResponse: Gate | undefined;
const provider = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/transcribe') { res.writeHead(404); res.end(); return; }
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    providerCalls.push({ audioPresent: Buffer.concat(chunks).includes(audio),
      multipart: Boolean(req.headers['content-type']?.startsWith('multipart/form-data;')) });
    providerArrival?.release();
    const pending = providerResponse;
    void (pending?.promise ?? Promise.resolve()).then(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(transcript);
    });
  });
});

const app = express();
const http = createServer(app);
const io = new SocketServer(http);
const publications: Array<{ room: string; payload: unknown }> = [];
app.set('io', { to: (room: string) => ({ emit: (event: string, payload: unknown) => {
  if (event === 'message:transcript') publications.push({ room, payload });
  io.to(room).emit(event, payload);
} }) });
app.use('/api/voice-messages', router);
const clients: Array<{ client: ClientSocket; transcripts: unknown[] }> = [];
const serverSockets = new Map<string, import('socket.io').Socket>();
let socketUrl = '';
let providerUrl = '';

interface Fixture { owner: string; outsider: string; server: string; other: string; channel: string; keep: string }
const fixtures: Fixture[] = [];
const uploaded = new Set<string>();
const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY!, secretAccessKey: process.env.MINIO_SECRET_KEY! } });

async function seed(): Promise<Fixture> {
  const f: Fixture = { owner: randomUUID(), outsider: randomUUID(), server: randomUUID(),
    other: randomUUID(), channel: randomUUID(), keep: randomUUID() };
  fixtures.push(f);
  for (const user of [f.owner, f.outsider])
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$2,$3,1)', [user, 'Stored voice author', 'not-a-login-fixture']);
  await q('INSERT INTO servers (_id,name,"ownerId","createdAt","aiEnabled") VALUES ($1,$1,$2,1,TRUE),($3,$3,$4,1,TRUE)',
    [f.server, f.owner, f.other, f.outsider]);
  await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$5::jsonb,1),($3,$4,$5::jsonb,1)',
    [f.owner, f.server, f.outsider, f.other, '[]']);
  await q('INSERT INTO channels (_id,"serverId",name,type,"createdAt") VALUES ($1,$3,$1,\'text\',1),($2,$3,$2,\'text\',1)',
    [f.channel, f.keep, f.server]);
  return f;
}
const expire = (f: Fixture) => q(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
  "expiryVersion"="expiryVersion"+1 WHERE _id=$1`, [f.channel]);
const token = (user: string) => makeToken({ _id: user, username: user, tokenVersion: 0 });
async function send(f: Fixture, actor = f.owner, bearer = token(actor)) {
  const response = await request(app).post('/api/voice-messages').set('Authorization', `Bearer ${bearer}`)
    .field('serverId', f.server).field('channelId', f.channel).field('duration', '1')
    .attach('audio', audio, { filename: 'fixture.webm', contentType: 'audio/webm' });
  if (response.status === 200) {
    const name = String(response.body.msg.fileName);
    if (!/^vm_\d+_[a-f0-9]{8}\.webm$/.test(name)) throw new Error('Unexpected fixture object name');
    uploaded.add(name);
  }
  return response;
}
async function present(name: string) {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `uploads/${name}` })); return true; }
  catch (error) { if (error instanceof NotFound && error.$metadata.httpStatusCode === 404) return false; throw error; }
}
async function backgroundComplete(name: string) {
  const deadline = Date.now() + 5000;
  while (fs.existsSync(path.join(uploads, name))) {
    if (Date.now() > deadline) throw new Error('Background transcription did not release its local copy');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Same-connection ordering proves earlier publications were delivered before
  // the observation; a zero count is not a fixed sleep or a missed packet.
  for (const { client } of clients) {
    const drained = new Promise<void>(resolve => client.once('test:drained', resolve));
    io.to(String(client.id)).emit('test:drained');
    await drained;
  }
}
async function subscribe(f: Fixture, user = f.owner) {
  const client = connectClient(socketUrl, { transports: ['websocket'], autoConnect: false, auth: { userId: user } });
  const transcripts: unknown[] = [];
  clients.push({ client, transcripts });
  client.on('message:transcript', payload => transcripts.push(payload));
  const ready = new Promise<void>((resolve, reject) => {
    client.once('test:ready', resolve); client.once('connect_error', reject);
  });
  client.connect(); await ready;
  const done = new Promise<void>(resolve => client.once('test:joined', resolve));
  client.emit('channel:join', f.channel); await done;
  const joined = serverSockets.get(String(client.id))?.rooms.has(`channel:${f.channel}`) ?? false;
  return { client, transcripts, joined };
}

beforeAll(async () => {
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/transcribe`;
  io.on('connection', socket => {
    serverSockets.set(socket.id, socket);
    const observed: HandlerSocket = {
      id: socket.id, rooms: socket.rooms,
      on<A extends unknown[]>(event: string, listener: (...args: A) => unknown) {
        return socket.on(event, (...args: unknown[]) => {
          void Promise.resolve(listener(...args as A)).then(() => socket.emit('test:joined'));
        });
      },
      emit: (event, ...args) => socket.emit(event, ...args),
      join: room => socket.join(room), leave: room => socket.leave(room), to: room => socket.to(room),
    };
    void setupMemberships(observed, { _id: String(socket.handshake.auth.userId) }).then(() => socket.emit('test:ready'));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  socketUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
beforeEach(() => {
  providerCalls.length = 0; publications.length = 0;
  const original = ai.transcriptionTarget;
  jest.spyOn(ai, 'transcriptionTarget').mockImplementation(env => {
    const target = original(env);
    return target ? { ...target, url: providerUrl } : null;
  });
});
afterEach(async () => {
  for (const pending of gates) pending.release();
  for (const name of uploaded) await backgroundComplete(name);
  for (const { client } of clients.splice(0)) client.disconnect();
  providerArrival = undefined; providerResponse = undefined; gates.clear();
  jest.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await q('DELETE FROM messages WHERE "serverId"=$1', [f.server]);
    await q('DELETE FROM voice_messages WHERE "serverId"=$1', [f.server]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "serverId"=$1', [f.server]);
    await q('DELETE FROM channels WHERE "serverId"=$1', [f.server]);
    await q('DELETE FROM members WHERE "serverId" IN ($1,$2)', [f.server, f.other]);
    await q('DELETE FROM servers WHERE _id IN ($1,$2)', [f.server, f.other]);
    await q('DELETE FROM users WHERE _id IN ($1,$2)', [f.owner, f.outsider]);
  }
  for (const name of uploaded) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `uploads/${name}` }));
    await q('DELETE FROM upload_release_keys WHERE key=$1', [`uploads/${name}`]);
  }
  uploaded.clear();
});
afterAll(async () => {
  await new Promise<void>(resolve => io.close(() => resolve()));
  await new Promise<void>(resolve => provider.close(() => resolve()));
  s3.destroy(); await db._pool.end(); fs.rmSync(uploads, { recursive: true, force: true });
});

it.each(['permanent', 'active'])('delivers a real transcript to its authorized %s channel room', async state => {
  const f = await seed();
  if (state === 'active') await q('UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+120000,"expiryVersion"=1 WHERE _id=$1', [f.channel]);
  const owner = await subscribe(f);
  const outsider = await subscribe(f, f.outsider);
  expect(owner.joined).toBe(true); expect(outsider.joined).toBe(false);
  const response = await send(f); expect(response.status).toBe(200);
  expect(response.body.msg).toMatchObject({ username: f.owner, displayName: 'Stored voice author' });
  await backgroundComplete(response.body.msg.fileName);
  expect(providerCalls).toEqual([{ audioPresent: true, multipart: true }]);
  expect(publications).toEqual([{ room: `channel:${f.channel}`, payload: { messageId: response.body.msg._id, transcript } }]);
  expect(owner.transcripts).toEqual([{ messageId: response.body.msg._id, transcript }]);
  expect(outsider.transcripts).toEqual([]);
  expect(await present(response.body.msg.fileName)).toBe(true);
});

it.each(['expired', 'tombstoned'])('does not hand audio to the provider after becoming %s during the policy read', async state => {
  const f = await seed(); const waiting = gate(); const release = gate();
  const original = policy.serverAllowsAi;
  jest.spyOn(policy, 'serverAllowsAi').mockImplementationOnce(async id => {
    const allowed = await original(id); expect(allowed).toBe(true);
    waiting.release(); await release.promise; return allowed;
  });
  const response = await send(f); expect(response.status).toBe(200);
  await waiting.promise;
  expect(fs.existsSync(path.join(uploads, response.body.msg.fileName))).toBe(true);
  if (state === 'expired') await expire(f);
  else await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,1,1,2)', [f.channel, f.server]);
  release.release(); await backgroundComplete(response.body.msg.fileName);
  expect(providerCalls).toEqual([]); expect(publications).toEqual([]);
  expect((await q('SELECT transcript FROM voice_messages WHERE _id=$1', [response.body.vmId])).rows).toEqual([{ transcript: null }]);
});

it('rejects a late provider result after database-clock expiry without deleting the committed voice message', async () => {
  const f = await seed(); providerArrival = gate(); providerResponse = gate();
  const response = await send(f); expect(response.status).toBe(200);
  await providerArrival.promise; expect(providerCalls).toHaveLength(1);
  await expire(f); providerResponse.release();
  await backgroundComplete(response.body.msg.fileName);
  expect((await q('SELECT transcript FROM voice_messages WHERE _id=$1', [response.body.vmId])).rows).toEqual([{ transcript: null }]);
  expect((await q('SELECT transcript FROM messages WHERE _id=$1', [response.body.msg._id])).rows).toEqual([{ transcript: null }]);
  expect(publications).toEqual([]);
  const hidden = await request(app).get(`/api/voice-messages/${response.body.vmId}/transcript`).set('Authorization', `Bearer ${token(f.owner)}`);
  expect(hidden.status).toBe(404);
});

it('retains the transcript committed while live but does not publish after the final update crosses expiry', async () => {
  const f = await seed(); await subscribe(f);
  const original = Messages.update.bind(Messages);
  jest.spyOn(Messages, 'update').mockImplementationOnce(async (...args) => {
    const saved = await original(...args); await expire(f); return saved;
  });
  const response = await send(f); expect(response.status).toBe(200);
  await backgroundComplete(response.body.msg.fileName);
  expect(providerCalls).toHaveLength(1);
  expect((await q('SELECT transcript FROM messages WHERE _id=$1', [response.body.msg._id])).rows).toEqual([{ transcript }]);
  expect(publications).toEqual([]);
});

it('an actual JWT from another tenant cannot upload or trigger provider work', async () => {
  const f = await seed();
  const response = await send(f, f.outsider);
  expect(response.status).toBe(403); expect(uploaded.size).toBe(0);
  expect((await q('SELECT _id FROM voice_messages WHERE "serverId"=$1', [f.server])).rows).toHaveLength(0);
  expect(providerCalls).toEqual([]); expect(publications).toEqual([]);
});

it('server AI opt-out preserves the voice upload without sending its bytes', async () => {
  const f = await seed(); await q('UPDATE servers SET "aiEnabled"=FALSE WHERE _id=$1', [f.server]);
  const response = await send(f); expect(response.status).toBe(200);
  await backgroundComplete(response.body.msg.fileName);
  expect(providerCalls).toEqual([]); expect(publications).toEqual([]);
  expect(await present(response.body.msg.fileName)).toBe(true);
});


it('a valid id-only token gets the stored author snapshot rather than a null display name', async () => {
  const f = await seed();
  const bearer = jwt.sign({ id: f.owner, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1m' });
  const response = await send(f, f.owner, bearer);
  expect(response.status).toBe(200);
  await backgroundComplete(response.body.msg.fileName);
  expect(response.body.msg).toMatchObject({ username: f.owner, displayName: 'Stored voice author' });
  expect((await q('SELECT "displayName" FROM voice_messages WHERE _id=$1', [response.body.vmId])).rows).toEqual([{ displayName: 'Stored voice author' }]);
  expect(providerCalls).toEqual([{ audioPresent: true, multipart: true }]);
});
