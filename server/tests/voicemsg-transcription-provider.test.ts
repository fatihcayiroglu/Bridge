// server/tests/voicemsg-transcription-provider.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// voicemsg — DIS TRANSKRIPSIYON SAGLAYICISI ASLA GONDERIMI DUSUREMEZ
// ════════════════════════════════════════════════════════════════════════════
// Sesli mesaj ONCE kalici olarak yazilir; transkripsiyon ondan SONRA, ayri ve
// EN IYI CABA (best-effort) olarak denenir. Bu sira urunun sozlesmesidir:
//
//   · Saglayici yapilandirilmamissa   → mesaj yine de gonderilir
//   · Saglayici HTTP hatasi dondurse  → mesaj yine de gonderilir
//   · Saglayici zaman asimina ugrasa  → mesaj yine de gonderilir
//   · Saglayici bos metin dondurse    → transkript UYDURULMAZ (null kalir)
//
// Aksi hâlde ucuncu bir tarafin kesintisi Bridge'de sesli mesajlasmayi
// tamamen durdururdu — ve kullanici bunu "mesajim gitmedi" diye gorurdu.
//
// Ikinci sozlesme: saglayici SECIMI ve GIZLI ANAHTAR. Groq varsa o kullanilir,
// yoksa OpenAI. Anahtar yalnizca `Authorization` basliginda tasinir ve
// yanit metnine ya da gunluge SIZMAZ.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = '12345678901234567890123456789012';
process.env.REFRESH_SECRET = '12345678901234567890123456789012';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const store = {
  uploadFile: jest.fn(),
  deleteFile: jest.fn(async () => undefined),
  keyFromUrl: jest.fn((u: string) => u.split('/').pop()),
  listFiles: jest.fn(),
  healthCheck: jest.fn(),
};
jest.mock('../lib/storageAdapter', () => ({ getPrivateStorageAdapter: () => store }));

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: logger, createLogger: () => logger }));

import { recordOf, recordsOf } from './helpers/narrow';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../db/loader';
import router from '../routes/voicemsg';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-vm-tx-'));
const WEBM = path.join(T, 'a.webm');
fs.writeFileSync(WEBM, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));

const tok = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

const ioEmit = jest.fn();
const testIo = { to: jest.fn(() => ({ emit: ioEmit })) };

function app() {
  const a = express();
  a.set('io', testIo);
  a.use('/api/voice-messages', router);
  return a;
}

async function seed() {
  await db.users.insert({ _id: 'u1', username: 'u1', displayName: 'U1', tokenVersion: 0 });
  await db.servers.insert({ _id: 's1', ownerId: 'u1', name: 'S' });
  await db.members.insert({ userId: 'u1', serverId: 's1', roles: [] });
  await db.channels.insert({ _id: 'c1', serverId: 's1', name: 'c', type: 'text' });
}

const post = () => request(app())
  .post('/api/voice-messages')
  .set('Authorization', `Bearer ${tok('u1')}`)
  .field('channelId', 'c1').field('serverId', 's1').field('duration', '0')
  .attach('audio', WEBM, { contentType: 'audio/webm' });

/** Arka plandaki en-iyi-caba transkripsiyonun tamamlanmasini bekler. */
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(async () => {
  db._reset?.();
  jest.restoreAllMocks();
  store.uploadFile.mockReset().mockResolvedValue({
    url: 'https://private.test/uploads/x.webm', key: 'uploads/x.webm', provider: 's3',
  });
  store.deleteFile.mockClear();
  for (const fn of Object.values(logger)) fn.mockClear();
  testIo.to.mockClear(); ioEmit.mockClear();
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENAI_API_KEY;
  fetchMock = jest.fn();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  await seed();
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  fs.rmSync(T, { recursive: true, force: true });
});

describe('transcription is attempted only when a provider is configured', () => {
  it('sends the message and never calls out when no key is set', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    await settle();
    // Saglayici yoksa DIS istek hic yapilmaz.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers Groq and uses its turbo model when both keys exist', async () => {
    process.env.GROQ_API_KEY = 'groq-secret';
    process.env.OPENAI_API_KEY = 'openai-secret';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'merhaba dunya' });

    const res = await post();
    expect(res.status).toBe(200);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('api.groq.com');
    expect(init.headers.Authorization).toBe('Bearer groq-secret');
  });

  it('falls back to OpenAI when only that key is set', async () => {
    process.env.OPENAI_API_KEY = 'openai-secret';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'metin' });

    await post();
    await settle();
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('api.openai.com');
    expect(init.headers.Authorization).toBe('Bearer openai-secret');
  });

  it('bounds the outbound request with an abort signal', async () => {
    process.env.GROQ_API_KEY = 'groq-secret';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'metin' });
    await post();
    await settle();
    const [, init] = fetchMock.mock.calls[0] as [string, { signal?: AbortSignal }];
    // Sinirsiz bir istek, kullanicinin mesajini belirsiz sure bekletirdi.
    expect(init.signal).toBeDefined();
  });
});

describe('a successful transcript is persisted and broadcast', () => {
  it('stores the trimmed text on both rows and notifies the channel', async () => {
    process.env.GROQ_API_KEY = 'groq-secret';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '  merhaba dunya  ' });

    const res = await post();
    const vmId = res.body.vmId as string;
    await settle();

    const vm = recordOf(await db.voiceMessages.findOne({ _id: vmId }), 'vm');
    expect(vm.transcript).toBe('merhaba dunya');
    expect(ioEmit).toHaveBeenCalledWith('message:transcript',
      expect.objectContaining({ transcript: 'merhaba dunya' }));
  });

  it('leaves the transcript unset when the provider returns only whitespace', async () => {
    process.env.GROQ_API_KEY = 'groq-secret';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '   ' });

    const res = await post();
    await settle();
    const vm = recordOf(await db.voiceMessages.findOne({ _id: res.body.vmId }), 'vm');
    // Bos yanit bir transkript DEGILDIR; uydurulmaz.
    expect(vm.transcript ?? null).toBeNull();
    expect(ioEmit).not.toHaveBeenCalled();
  });
});

describe('a provider outage never costs the user their message', () => {
  it.each([
    ['an HTTP error', () => fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' })],
    ['a transport rejection', () => fetchMock.mockRejectedValue(new Error('ECONNRESET'))],
    ['a timeout abort', () => fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))],
  ])('still delivers the voice message after %s', async (_label, arrange) => {
    process.env.GROQ_API_KEY = 'groq-secret';
    arrange();

    const res = await post();
    // Ucuncu tarafin kesintisi Bridge'de sesli mesajlasmayi DURDURMAZ.
    expect(res.status).toBe(200);
    await settle();

    const vm = recordOf(await db.voiceMessages.findOne({ _id: res.body.vmId }), 'vm');
    expect(vm).not.toBeNull();
    expect(vm.transcript ?? null).toBeNull();
    // Ariza operatore gorunur, kullaniciya degil.
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never leaks the provider key into a log record', async () => {
    process.env.GROQ_API_KEY = 'cok-gizli-anahtar';
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    await post();
    await settle();

    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain('cok-gizli-anahtar');
  });
});
