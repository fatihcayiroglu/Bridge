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

import { recordOf } from './helpers/narrow';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import db from '../db/loader';
import router from '../routes/voicemsg';
import * as aiPolicy from '../lib/aiServerPolicy';
import { Channels, Messages, VoiceMessages } from '../db/repositories';

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

let actor = '';
async function seed() {
  actor = randomUUID();
  await db.users.insert({ _id: actor, username: actor, displayName: 'U1', tokenVersion: 0 });
  await db.servers.insert({ _id: 's1', ownerId: actor, name: 'S' });
  await db.members.insert({ userId: actor, serverId: 's1', roles: [] });
  await db.channels.insert({ _id: 'c1', serverId: 's1', name: 'c', type: 'text' });
}

const post = () => request(app())
  .post('/api/voice-messages')
  .set('Authorization', `Bearer ${tok(actor)}`)
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
    expect(vm.displayName).toBe('U1');
    expect(res.body.msg).toMatchObject({ username: actor, displayName: 'U1' });
    expect(testIo.to).toHaveBeenCalledWith('channel:c1');
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

// ════════════════════════════════════════════════════════════════════════════
// P6 AI-09 — transcription obeys the installation's AI_PROVIDER
// ════════════════════════════════════════════════════════════════════════════
// Transcription sends a member's audio to a third party. It used to read
// GROQ_API_KEY / OPENAI_API_KEY itself, so AI_PROVIDER=none ("AI is off even if
// keys are set", docs/AI.md) did not stop it, and an operator who picked one
// provider still had audio sent to another.
describe('P6 AI-09: AI_PROVIDER governs transcription', () => {
  afterEach(() => { delete process.env.AI_PROVIDER; });

  it.each(['none', 'off', 'rules'])('AI_PROVIDER=%s: no audio leaves the server even with both keys set', async (sel) => {
    process.env.AI_PROVIDER = sel;
    process.env.GROQ_API_KEY = 'groq-secret';
    process.env.OPENAI_API_KEY = 'openai-secret';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'metin' });

    const res = await post();
    expect(res.status).toBe(200);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AI_PROVIDER names another provider: audio is not sent to Groq or OpenAI', async () => {
    process.env.AI_PROVIDER = 'gemini';
    process.env.GROQ_API_KEY = 'groq-secret';
    process.env.OPENAI_API_KEY = 'openai-secret';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'metin' });

    await post();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AI_PROVIDER=groq: Groq is used, OpenAI never', async () => {
    process.env.AI_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'groq-secret';
    process.env.OPENAI_API_KEY = 'openai-secret';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'metin' });

    await post();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('api.groq.com');
  });

  it('AI_PROVIDER=groq without a Groq key: no fallback to OpenAI', async () => {
    process.env.AI_PROVIDER = 'groq';
    process.env.OPENAI_API_KEY = 'openai-secret';
    await post();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// P6 — per-server AI opt-out: a server whose owner turned AI off never has its
// members' audio sent out, even with a provider configured.
describe('P6: the server AI setting governs transcription', () => {
  it('aiEnabled=false: the voice message is sent, no audio leaves the server', async () => {
    process.env.GROQ_API_KEY = 'groq-secret';
    await db.servers.update({ _id: 's1' }, { $set: { aiEnabled: false } });
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'metin' });
    const res = await post();
    expect(res.status).toBe(200);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('control: aiEnabled=true transcribes', async () => {
    process.env.GROQ_API_KEY = 'groq-secret';
    await db.servers.update({ _id: 's1' }, { $set: { aiEnabled: true } });
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'metin' });
    await post();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe('background transcription rechecks channel authority', () => {
  const expireParent = () => db.channels.update({ _id: 'c1' }, { $set: { expiresAt: Date.now() - 1000, expiryVersion: 1 } });
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    process.env.GROQ_API_KEY = 'isolated-transcription-fixture';
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'fixture transcript' });
  });

  it('does not send audio when expiry occurs while server AI policy is being read', async () => {
    const original = aiPolicy.serverAllowsAi;
    jest.spyOn(aiPolicy, 'serverAllowsAi').mockImplementationOnce(async serverId => {
      const allowed = await original(serverId);
      expect(allowed).toBe(true);
      await expireParent();
      return allowed;
    });
    const response = await post();
    expect(response.status).toBe(200); // The original voice write committed while live.
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ioEmit).not.toHaveBeenCalled();
    expect(recordOf(await db.voiceMessages.findOne({ _id: response.body.vmId }), 'vm').transcript ?? null).toBeNull();
  });

  it('does not send audio when current parent authority cannot be read', async () => {
    const original = aiPolicy.serverAllowsAi;
    jest.spyOn(aiPolicy, 'serverAllowsAi').mockImplementationOnce(async serverId => {
      const allowed = await original(serverId);
      jest.spyOn(Channels, 'findById').mockRejectedValue(new Error('isolated lifecycle read failure'));
      return allowed;
    });
    expect((await post()).status).toBe(200);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ioEmit).not.toHaveBeenCalled();
  });

  it('does not persist or broadcast a provider result that arrives after expiry', async () => {
    fetchMock.mockImplementationOnce(async () => {
      await expireParent();
      return { ok: true, status: 200, text: async () => 'late transcript fixture' };
    });
    const response = await post();
    expect(response.status).toBe(200);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordOf(await db.voiceMessages.findOne({ _id: response.body.vmId }), 'vm').transcript ?? null).toBeNull();
    expect(recordOf(await db.messages.findOne({ _id: response.body.msg._id }), 'message').transcript ?? null).toBeNull();
    expect(ioEmit).not.toHaveBeenCalled();
  });

  it('preserves a committed transcript but refuses publication after expiry during the final update', async () => {
    const original = Messages.update.bind(Messages);
    jest.spyOn(Messages, 'update').mockImplementationOnce(async (...args) => {
      const saved = await original(...args);
      await expireParent();
      return saved;
    });
    const response = await post();
    expect(response.status).toBe(200);
    await settle();
    expect(recordOf(await db.voiceMessages.findOne({ _id: response.body.vmId }), 'vm').transcript).toBe('fixture transcript');
    expect(recordOf(await db.messages.findOne({ _id: response.body.msg._id }), 'message').transcript).toBe('fixture transcript');
    expect(ioEmit).not.toHaveBeenCalled();
  });
});


describe('committed voice-message response is not a storage rollback', () => {
  // Exercise the final production handler directly so response serialization
  // can fail synchronously without a synthetic HTTP retry or process-level hang.
  const uploadHandler = () => {
    type Handler = (req: unknown, res: unknown) => Promise<unknown>;
    const layers = (router as unknown as { stack: Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
    }> }).stack;
    const route = layers.find(layer => layer.route?.path === '/' && layer.route.methods.post)?.route;
    const handler = route?.stack.at(-1)?.handle;
    if (!handler) throw new Error('POST voice-message persistence handler unavailable');
    return handler;
  };
  const injectedRequest = () => ({
    user: { id: actor },
    body: { channelId: 'c1', serverId: 's1', duration: '0' },
    file: { mimetype: 'audio/webm', buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]) },
  });

  it('retains both database rows and remote bytes if the response throws after commit', async () => {
    const response = { json: jest.fn(() => { throw new Error('simulated reply serialization fault'); }) };
    await expect(uploadHandler()(injectedRequest(), response)).rejects.toThrow('simulated reply serialization fault');
    expect(response.json).toHaveBeenCalledTimes(1);

    const messages = await db.messages.find({ channelId: 'c1', type: 'voice_message' });
    const voices = await db.voiceMessages.find({ channelId: 'c1' });
    expect(messages).toHaveLength(1);
    expect(voices).toHaveLength(1);
    expect(recordOf(messages[0], 'committed chat message').fileUrl)
      .toBe(recordOf(voices[0], 'committed voice row').url);
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'voicemsg.response_after_commit_failed' }),
      expect.any(String),
    );
    const writtenPath = store.uploadFile.mock.calls[0]?.[0] as string | undefined;
    expect(writtenPath).toBeTruthy();
    expect(fs.existsSync(writtenPath as string)).toBe(false); // Remote-only local copy.
  });

  it('preserves live bytes when chat insert commits but its acknowledgement is lost', async () => {
    const original = Messages.create.bind(Messages);
    jest.spyOn(Messages, 'create').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('simulated lost chat insert acknowledgement');
    });
    const response = { json: jest.fn() };
    await expect(uploadHandler()(injectedRequest(), response))
      .rejects.toThrow('simulated lost chat insert acknowledgement');
    expect(await db.voiceMessages.find({ channelId: 'c1' })).toHaveLength(1);
    expect(await db.messages.find({ channelId: 'c1', type: 'voice_message' })).toHaveLength(1);
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'voicemsg.chat_commit_confirmed_after_error' }), expect.any(String));
  });

  it('preserves bytes when the chat commit cannot be verified after a write error', async () => {
    jest.spyOn(Messages, 'create').mockRejectedValueOnce(new Error('simulated ambiguous chat write'));
    jest.spyOn(Messages, 'findById').mockRejectedValueOnce(new Error('read database unavailable'));
    const response = { json: jest.fn() };
    await expect(uploadHandler()(injectedRequest(), response))
      .rejects.toThrow('simulated ambiguous chat write');
    expect(await db.voiceMessages.find({ channelId: 'c1' })).toHaveLength(1);
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'voicemsg.chat_commit_unverifiable' }), expect.any(String));
  });

  it('preserves a late chat commit after an absent-row probe and transport failure', async () => {
    const original = Messages.create.bind(Messages);
    let releaseCommit!: () => void;
    const gate = new Promise<void>(resolve => { releaseCommit = resolve; });
    let backendCommit!: Promise<unknown>;
    jest.spyOn(Messages, 'create').mockImplementationOnce((...args) => {
      backendCommit = gate.then(() => original(...args));
      return Promise.reject(Object.assign(new Error('connection lost before reply'), { code: '08006' }));
    });
    const response = { json: jest.fn() };
    await expect(uploadHandler()(injectedRequest(), response))
      .rejects.toThrow('connection lost before reply');
    expect(await db.messages.find({ channelId: 'c1', type: 'voice_message' })).toHaveLength(0);
    expect(await db.voiceMessages.find({ channelId: 'c1' })).toHaveLength(1);
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'voicemsg.write_completion_indeterminate' }), expect.any(String));
    // The original backend finishes after a different connection saw no row.
    releaseCommit();
    await backendCommit;
    expect(await db.messages.find({ channelId: 'c1', type: 'voice_message' })).toHaveLength(1);
    expect(store.deleteFile).not.toHaveBeenCalled();
  });

  it('preserves remote bytes if the voice insert can finish after its failed reply', async () => {
    const original = VoiceMessages.insert.bind(VoiceMessages);
    let releaseCommit!: () => void;
    const gate = new Promise<void>(resolve => { releaseCommit = resolve; });
    let backendCommit!: Promise<unknown>;
    jest.spyOn(VoiceMessages, 'insert').mockImplementationOnce((...args) => {
      backendCommit = gate.then(() => original(...args));
      return Promise.reject(Object.assign(new Error('voice connection interrupted'), { code: '08006' }));
    });
    const response = { json: jest.fn() };
    await expect(uploadHandler()(injectedRequest(), response))
      .rejects.toThrow('voice connection interrupted');
    expect(await db.voiceMessages.find({ channelId: 'c1' })).toHaveLength(0);
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    releaseCommit();
    await backendCommit;
    expect(await db.voiceMessages.find({ channelId: 'c1' })).toHaveLength(1);
    expect(store.deleteFile).not.toHaveBeenCalled();
  });

  it('fails closed on an unclassified thrown chat write with no row', async () => {
    jest.spyOn(Messages, 'create').mockRejectedValueOnce(new Error('unknown write status'));
    const response = { json: jest.fn() };
    await expect(uploadHandler()(injectedRequest(), response)).rejects.toThrow('unknown write status');
    expect(await db.voiceMessages.find({ channelId: 'c1' })).toHaveLength(1);
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('rolls back a confirmed voice row when voice insert commits before a lost acknowledgement', async () => {
    const original = VoiceMessages.insert.bind(VoiceMessages);
    jest.spyOn(VoiceMessages, 'insert').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('simulated lost voice insert acknowledgement');
    });
    const response = { json: jest.fn() };
    await expect(uploadHandler()(injectedRequest(), response))
      .rejects.toThrow('simulated lost voice insert acknowledgement');
    expect(await db.voiceMessages.find({ channelId: 'c1' })).toHaveLength(0);
    expect(await db.messages.find({ channelId: 'c1', type: 'voice_message' })).toHaveLength(0);
    expect(store.deleteFile).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveBeenCalled();
  });

  it('retains bytes if the voice row cannot be read after an ambiguous insert failure', async () => {
    jest.spyOn(VoiceMessages, 'insert').mockRejectedValueOnce(new Error('simulated ambiguous voice write'));
    jest.spyOn(VoiceMessages, 'findOne').mockRejectedValueOnce(new Error('read database unavailable'));
    const response = { json: jest.fn() };
    await expect(uploadHandler()(injectedRequest(), response))
      .rejects.toThrow('simulated ambiguous voice write');
    expect(store.deleteFile).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'voicemsg.voice_commit_unverifiable' }), expect.any(String));
  });

  it('cleans up remote bytes after a definitive PostgreSQL voice constraint rejection', async () => {
    jest.spyOn(VoiceMessages, 'insert').mockRejectedValueOnce(
      Object.assign(new Error('simulated voice constraint rejection'), { code: '23514' }));
    const response = { json: jest.fn() };
    await expect(uploadHandler()(injectedRequest(), response))
      .rejects.toThrow('simulated voice constraint rejection');
    expect(await db.voiceMessages.find({ channelId: 'c1' })).toHaveLength(0);
    expect(store.deleteFile).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveBeenCalled();
  });

  it('still rolls back uncommitted voice bytes if the chat-message insert fails', async () => {
    jest.spyOn(Messages, 'create').mockRejectedValueOnce(
      Object.assign(new Error('simulated message insert rejection'), { code: '23514' }));
    const response = { json: jest.fn() };
    await expect(uploadHandler()(injectedRequest(), response)).rejects.toThrow('simulated message insert rejection');

    expect(await db.voiceMessages.find({ channelId: 'c1' })).toHaveLength(0);
    expect(await db.messages.find({ channelId: 'c1', type: 'voice_message' })).toHaveLength(0);
    expect(store.deleteFile).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveBeenCalled();
  });
});
