// server/tests/auth.test.js
// Tests for auth routes: register, login, refresh, change-password, logout-all

process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

// Use an in-memory SQLite for tests by pointing DATA_DIR to a temp path
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
process.env.DATA_DIR_OVERRIDE = tmpDir;

// Monkey-patch db path before requiring app modules
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const Database = require('better-sqlite3');
  const { v4: uuidv4 } = require('uuid');
  const db_path = path.join(tmpDir, 'test.db');
  const sqlite  = new Database(db_path);

  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (_id TEXT PRIMARY KEY, username TEXT UNIQUE, displayName TEXT, password TEXT, avatarColor TEXT DEFAULT '#5865f2', avatarUrl TEXT, status TEXT DEFAULT 'offline', bio TEXT DEFAULT '', tokenVersion INTEGER DEFAULT 0, createdAt INTEGER);
    CREATE TABLE IF NOT EXISTS servers (_id TEXT PRIMARY KEY, name TEXT, icon TEXT DEFAULT '🌐', ownerId TEXT, createdAt INTEGER);
    CREATE TABLE IF NOT EXISTS members (userId TEXT, serverId TEXT, roles TEXT DEFAULT '[]', joinedAt INTEGER, PRIMARY KEY(userId, serverId));
    CREATE TABLE IF NOT EXISTS refresh_tokens (token TEXT PRIMARY KEY, userId TEXT, expiresAt INTEGER, createdAt INTEGER);
  `);

  // Minimal Collection for tests
  class Col {
    constructor(t) { this.t = t; }
    async findOne(q) {
      const keys = Object.keys(q);
      if (!keys.length) return null;
      const [k] = keys;
      const row = sqlite.prepare(`SELECT * FROM "${this.t}" WHERE "${k}" = ? LIMIT 1`).get(q[k]);
      return row ? JSON.parse(JSON.stringify(row)) : null;
    }
    find(q) {
      const rows = sqlite.prepare(`SELECT * FROM "${this.t}"`).all();
      return { then: (r) => Promise.resolve(rows).then(r), sort: () => ({ then: (r) => Promise.resolve(rows).then(r), limit: () => ({ then: (r) => Promise.resolve([]).then(r) }) }) };
    }
    async insert(doc) {
      if (!doc._id) doc._id = uuidv4();
      const keys = Object.keys(doc);
      const vals = keys.map(k => doc[k] === undefined ? null : (typeof doc[k] === 'object' ? JSON.stringify(doc[k]) : doc[k]));
      sqlite.prepare(`INSERT OR REPLACE INTO "${this.t}" (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...vals);
      return doc;
    }
    async update(q, upd) {
      const [k] = Object.keys(q);
      if (upd.$set) {
        const sets = Object.keys(upd.$set).map(c => `"${c}" = ?`).join(', ');
        sqlite.prepare(`UPDATE "${this.t}" SET ${sets} WHERE "${k}" = ?`).run(...Object.values(upd.$set), q[k]);
      }
      if (upd.$inc) {
        for (const [c, v] of Object.entries(upd.$inc)) {
          sqlite.prepare(`UPDATE "${this.t}" SET "${c}" = "${c}" + ? WHERE "${k}" = ?`).run(v, q[k]);
        }
      }
    }
    async remove(q) {
      if (!Object.keys(q).length) return;
      const [k] = Object.keys(q);
      sqlite.prepare(`DELETE FROM "${this.t}" WHERE "${k}" = ?`).run(q[k]);
    }
    async count() { return sqlite.prepare(`SELECT COUNT(*) as n FROM "${this.t}"`).get().n; }
    ensureIndex() {}
  }

  return {
    users:         new Col('users'),
    servers:       new Col('servers'),
    members:       new Col('members'),
    refreshTokens: new Col('refresh_tokens'),
    _sqlite:       sqlite,
  };
});

const request = require('supertest');
const express = require('express');
const { router } = require('../routes/auth');

const app = express();
app.use(express.json());
app.use('/api', router);
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

// ────────────────────────────────────────────────────────────────────────────
describe('POST /api/register', () => {
  it('registers a new user', async () => {
    const res = await request(app).post('/api/register').send({ username: 'testuser', password: 'securepass123' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    
    expect(res.body.user.username).toBe('testuser');
  });

  it('rejects duplicate username', async () => {
    const res = await request(app).post('/api/register').send({ username: 'testuser', password: 'securepass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/taken/i);
  });

  it('rejects short password', async () => {
    const res = await request(app).post('/api/register').send({ username: 'newuser2', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });

  it('rejects invalid username characters', async () => {
    const res = await request(app).post('/api/register').send({ username: 'bad user!', password: 'goodpassword' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/login', () => {
  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'securepass123' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    
  });

  it('rejects wrong password', async () => {
    const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  it('rejects non-existent user', async () => {
    const res = await request(app).post('/api/login').send({ username: 'nobody', password: 'anything' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/refresh', () => {
  let refreshToken;

  beforeAll(async () => {
    const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'securepass123' });
    // refreshToken now set via httpOnly cookie — read from Set-Cookie header
    refreshToken = (res.headers['set-cookie'] || []).find(c => c.includes('bridge_refresh')) || '';
  });

  it('returns new token pair', async () => {
    const res = await request(app).post('/api/refresh').set('Cookie', refreshToken).send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    
  });

  it('rejects already-used refresh token (rotation)', async () => {
    // The same refreshToken was used above, so it should be invalid now
    const res = await request(app).post('/api/refresh').set('Cookie', refreshToken).send({});
    expect(res.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const res = await request(app).post('/api/refresh').set('Cookie', 'bridge_refresh=invalid').send({});
    expect(res.status).toBe(401);
  });

  it('rejects missing refreshToken body', async () => {
    const res = await request(app).post('/api/refresh').send({}); // no cookie
    expect(res.status).toBe(400);
  });
});
