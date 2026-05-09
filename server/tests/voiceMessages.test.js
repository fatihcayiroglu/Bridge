// server/tests/voiceMessages.test.js
// Tests for POST /api/voice-messages (upload, validation, membership check)

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

// Point multer uploads to a temp dir so no real files linger
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-vm-test-'));

// Override multer upload dir before requiring route
jest.mock('multer', () => {
  const multer = jest.requireActual('multer');
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename:    (_req, _file, cb) => cb(null, `vm_test_${Date.now()}.webm`),
  });
  const m = (opts) => multer({ ...opts, storage });
  m.diskStorage = multer.diskStorage;
  return m;
});

const { createMockDb } = require('./helpers/mockDb');
const mockDb = createMockDb();
jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try {
      const decoded = jwt.verify(h.slice(7), 'test-jwt-secret');
      req.user = { id: decoded.id, username: decoded.username, displayName: decoded.displayName, avatarColor: decoded.avatarColor };
      next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = require('../routes/voicemsg');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(h.slice(7), 'test-jwt-secret');
      req.user = { id: decoded.id, username: decoded.username, displayName: decoded.displayName, avatarColor: decoded.avatarColor, v: 0 };
    } catch {}
  }
  next();
});
app.use('/api/voice-messages', router);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

function token(id, extra = {}) {
  return jwt.sign({ id, username: 'speaker', displayName: 'Speaker', avatarColor: '#abc', v: 0, ...extra }, 'test-jwt-secret', { expiresIn: '1h' });
}

const USER_ID   = 'vmu1';
const SERVER_ID = 'vsrv1';
const CHAN_ID   = 'vch1';

// Create a tiny valid webm-like file (not a real webm, but passes multer's size check)
const FAKE_AUDIO = path.join(UPLOAD_DIR, 'fake.webm');

beforeAll(async () => {
  fs.writeFileSync(FAKE_AUDIO, Buffer.alloc(512, 0));
  await mockDb.members.insert({ userId: USER_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  await mockDb.channels.insert({ _id: CHAN_ID, serverId: SERVER_ID, name: 'general', type: 'text', createdAt: Date.now() });
});

afterAll(() => {
  // Clean up temp uploads
  try { fs.rmSync(UPLOAD_DIR, { recursive: true }); } catch {}
});

describe('POST /api/voice-messages', () => {
  it('uploads a voice message and creates a chat message', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID)
      .field('duration', '5');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.msg).toBeDefined();
    expect(res.body.msg.type).toBe('voice_message');
    expect(res.body.msg.fileUrl).toMatch(/\/uploads\//);
    expect(res.body.vmId).toBeDefined();
  });

  it('stores the voice message in db.voiceMessages', async () => {
    const vms = await mockDb.voiceMessages.find({ channelId: CHAN_ID });
    expect(vms.length).toBeGreaterThanOrEqual(1);
    expect(vms[0].userId).toBe(USER_ID);
  });

  it('stores a corresponding message in db.messages', async () => {
    const msgs = await mockDb.messages.find({ channelId: CHAN_ID, type: 'voice_message' });
    expect(msgs.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects upload without audio file', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no audio/i);
  });

  it('rejects missing channelId', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('serverId', SERVER_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channelId/i);
  });

  it('rejects missing serverId', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID);
    expect(res.status).toBe(400);
  });

  it('rejects non-members', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token('outsider')}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member/i);
  });

  it('accepts duration=0 (default)', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID);
    expect(res.status).toBe(200);
    const vms = await mockDb.voiceMessages.find({ channelId: CHAN_ID, userId: USER_ID });
    const latest = vms[vms.length - 1];
    expect(latest.duration).toBe(0);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID);
    // No auth header → authMiddleware returns 401
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════
// GET /api/voice-messages/:vmId/transcript
// ══════════════════════════════════════════════════════════════
describe('GET /api/voice-messages/:vmId/transcript', () => {
  let vmId;

  beforeAll(async () => {
    // Insert a voice message directly to test transcript endpoint
    const vm = await mockDb.voiceMessages.insert({
      _id: 'vm-test-1',
      channelId: CHAN_ID,
      serverId: SERVER_ID,
      userId: USER_ID,
      fileUrl: '/uploads/vm_test.webm',
      duration: 10,
      createdAt: Date.now(),
    });
    vmId = vm._id;
  });

  it('transcript yokken pending döner', async () => {
    const res = await request(app)
      .get(`/api/voice-messages/${vmId}/transcript`)
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.transcript).toBeNull();
    expect(res.body.status).toBe('pending');
  });

  it('transcript varken done döner', async () => {
    await mockDb.voiceMessages.update({ _id: vmId }, { $set: { transcript: 'Merhaba dünya' } });
    const res = await request(app)
      .get(`/api/voice-messages/${vmId}/transcript`)
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.transcript).toBe('Merhaba dünya');
    expect(res.body.status).toBe('done');
  });

  it('mevcut olmayan vmId 404 döner', async () => {
    const res = await request(app)
      .get('/api/voice-messages/nonexistent/transcript')
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(404);
  });

  it('üye olmayan kullanıcı 403 alır', async () => {
    const res = await request(app)
      .get(`/api/voice-messages/${vmId}/transcript`)
      .set('Authorization', `Bearer ${token('outsider-user')}`);
    expect(res.status).toBe(403);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .get(`/api/voice-messages/${vmId}/transcript`);
    expect(res.status).toBe(401);
  });
});
