// server/tests/interactions.test.js
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

const { createMockDb, makeUser, makeMessage } = require('./helpers/mockDb');
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = require('../routes/interactions');

function token(userId) {
  return jwt.sign({ id: userId, username: 'user', displayName: 'User', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp({ io = null } = {}) {
  const app = express();
  app.set('io', io); // replaces global.bridgeIO — route reads req.app.get('io')
  app.use(express.json());
  app.use('/api/interactions', router);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

let app, user, botMsg, normalMsg;
const CHAN_ID   = 'ch_int_1';
const SERVER_ID = 'srv_int_1';

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  user = makeUser({ username: 'interactor' });
  await db.users.insert(user);

  // Message from a bot (has botId)
  botMsg = await db.messages.insert(makeMessage(CHAN_ID, SERVER_ID, user._id, {
    _id: 'msg_bot_1',
    botId: 'bot_xyz',
    content: 'Click a button!',
    type: 'normal',
  }));

  // Normal message (no botId)
  normalMsg = await db.messages.insert(makeMessage(CHAN_ID, SERVER_ID, user._id, {
    _id: 'msg_normal_1',
    content: 'Hello',
    type: 'normal',
  }));

  app = buildApp(); // io defaults to null — no socket emissions in most tests
});

// ═══════════════════════════════════════════════════════
// POST /api/interactions
// ═══════════════════════════════════════════════════════
describe('POST /api/interactions', () => {
  it('bot mesajına interaction gönderir', async () => {
    const res = await request(app)
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({
        type:      'button',
        messageId: 'msg_bot_1',
        customId:  'confirm_action',
        channelId: CHAN_ID,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('normal (non-bot) mesaja interaction gönderir', async () => {
    const res = await request(app)
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({
        type:      'select',
        messageId: 'msg_normal_1',
        customId:  'menu_select',
        value:     'option_a',
        channelId: CHAN_ID,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('messageId eksikse 400 döner', async () => {
    const res = await request(app)
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', customId: 'confirm', channelId: CHAN_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/messageId/i);
  });

  it('customId eksikse 400 döner', async () => {
    const res = await request(app)
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'msg_bot_1', channelId: CHAN_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customId/i);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'nonexistent', customId: 'click', channelId: CHAN_ID });
    expect(res.status).toBe(404);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .post('/api/interactions')
      .send({ type: 'button', messageId: 'msg_bot_1', customId: 'click', channelId: CHAN_ID });
    expect(res.status).toBe(401);
  });

  it('socket varsa emit edilir', async () => {
    const emitted = [];
    const mockIo = { emit: (ev, data) => emitted.push({ ev, data }) };
    const appWithIo = buildApp({ io: mockIo }); // io injected via app.set, not global

    await request(appWithIo)
      .post('/api/interactions')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ type: 'button', messageId: 'msg_bot_1', customId: 'my_btn', channelId: CHAN_ID });

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0].ev).toBe('interaction');
    expect(emitted[0].data.customId).toBe('my_btn');
    expect(emitted[0].data.botId).toBe('bot_xyz');
  });
});
