// server/tests/federation-keys-admin.test.ts
// ADR-0006 Faz 2: rotate-key admin + key-update peer endpoint
import type { Request, Response, NextFunction } from 'express';

'use strict';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.AP_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.INSTANCE_URL = 'http://localhost:3001';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import crypto from 'crypto';
import federationKeysRouter from '../routes/admin/federation-keys';
import peersRouter from '../routes/federation/peers';
import {
  _resetFederationKeyCache,
} from '../lib/federationKeys';
import { _resetSignatureReplayCache } from '../lib/httpSignature';

// Sprint 108: federationAuth middleware (V2) — key-update route artık bu middleware'i kullanıyor
jest.mock('../middleware/federationAuth', () => ({
  federationAuth: jest.fn((req: Request, res: Response, next: NextFunction) => {
    req.federationMethod  = 'rsa';
    req.federationPeerUrl = req.headers['x-bridge-instance-url'] || req.body?.url || req.body?.instanceUrl || '';
    req.federationPeerId  = 'peer-1';
    next();
  }),
  federationAuthRsaRequired: jest.fn((req: Request, res: Response, next: NextFunction) => {
    // key-update için RSA zorunlu: gerçek V2 doğrulamasını simüle et
    const ts  = req.headers['x-bridge-ts'] as string;
    const sig = req.headers['x-bridge-rsa-sig'] as string;
    if (!ts || !sig) {
      return res.status(401).json({ error: 'Federation authentication failed', reason: 'RSA signature required' });
    }
    req.federationMethod  = 'rsa';
    req.federationPeerUrl = req.headers['x-bridge-instance-url'] || req.body?.url || req.body?.instanceUrl || '';
    req.federationPeerId  = 'peer-1';
    next();
  }),
}));

function adminToken(userId: string) {
  return jwt.sign({ id: userId, username: 'admin', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

describe('POST /api/admin/federation/rotate-key', () => {
  let app: express.Application;

  beforeEach(() => {
    mockDb._reset();
    _resetFederationKeyCache();
    app = express();
    app.use(express.json());
    app.use('/api/admin', federationKeysRouter);
  });

  it('admin rotate-key → 200 + keyVersion', async () => {
    const admin = {
      _id: 'admin-1', username: 'admin', displayName: 'Admin',
      password: 'x', avatarColor: '#000', isAdmin: 1, tokenVersion: 0, createdAt: Date.now(),
    };
    await mockDb.users.insert(admin);

    const res = await request(app)
      .post('/api/admin/federation/rotate-key')
      .set('Authorization', `Bearer ${adminToken(admin._id)}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.keyVersion).toBeGreaterThanOrEqual(1);
    expect(res.body.publicKey?.publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
  });

  it('admin olmayan → 403', async () => {
    const user = {
      _id: 'u-1', username: 'user', displayName: 'User',
      password: 'x', avatarColor: '#000', isAdmin: 0, tokenVersion: 0, createdAt: Date.now(),
    };
    await mockDb.users.insert(user);

    const res = await request(app)
      .post('/api/admin/federation/rotate-key')
      .set('Authorization', `Bearer ${adminToken(user._id)}`);

    expect(res.status).toBe(403);
  });
});

describe('POST /api/federation/key-update', () => {
  let app: express.Application;

  beforeEach(() => {
    mockDb._reset();
    _resetFederationKeyCache();
    app = express();
    app.use(express.json());
    app.use('/api/federation', peersRouter);
  });

  it('geçersiz imza → 401', async () => {
    const res = await request(app)
      .post('/api/federation/key-update')
      .send({
        url: 'http://peer.example.com',
        instanceUrl: 'http://peer.example.com',
        publicKey:   { publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----' },
      });
    // middleware mock: x-bridge-ts ve x-bridge-rsa-sig eksik → 401
    expect(res.status).toBe(401);
  });

  it('geçerli RSA imzası → peer publicKey güncellenir', async () => {
    _resetSignatureReplayCache();

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const peerUrl = 'http://peer.example.com';
    await mockDb.federationPeers.insert({
      _id: 'peer-1', url: peerUrl, name: 'Peer', addedAt: Date.now(),
      publicKey, verified: true,
    });

    const { publicKey: newPub } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const body = {
      url: peerUrl,
      instanceUrl: peerUrl,
      publicKey: { publicKeyPem: newPub, id: `${peerUrl}/api/federation/key` },
    };
    const ts  = String(Date.now());
    const sig = crypto.createSign('sha256').update(JSON.stringify(body)).sign(privateKey, 'base64');

    const res = await request(app)
      .post('/api/federation/key-update')
      .set('x-bridge-ts',      ts)
      .set('x-bridge-rsa-sig', sig)
      .set('x-bridge-instance-url', peerUrl)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updated = await mockDb.federationPeers.findOne({ _id: 'peer-1' });
    expect(updated!.publicKey).toBe(newPub);
  });

  it('authenticated peer cannot rotate a different peer key via body target confusion', async () => {
    await mockDb.federationPeers.insert({
      _id: 'peer-1', url: 'http://peer-a.example.com', name: 'Peer A',
      publicKey: 'old-a', verified: true,
    });
    await mockDb.federationPeers.insert({
      _id: 'peer-2', url: 'http://peer-b.example.com', name: 'Peer B',
      publicKey: 'old-b', verified: true,
    });

    const body = {
      url: 'http://peer-b.example.com',
      publicKey: { publicKeyPem: '-----BEGIN PUBLIC KEY-----\nNEW-BY-ATTACKER\n-----END PUBLIC KEY-----' },
    };
    const res = await request(app)
      .post('/api/federation/key-update')
      .set('x-bridge-ts', String(Date.now()))
      .set('x-bridge-rsa-sig', 'authenticated-by-middleware')
      .set('x-bridge-instance-url', 'http://peer-a.example.com')
      .send(body);

    expect(res.status).toBe(403);
    const victim = await mockDb.federationPeers.findOne({ _id: 'peer-2' });
    expect(victim!.publicKey).toBe('old-b');
  });
});

// P5 FED-10 — measured in the two-instance lab: the route also wrote a
// "keyUpdated" column federation_peers does not have. This mock DB accepts any
// column, so the suite above stayed green while every real announcement was 500.
// The written columns are checked against the DDL the server actually runs.
describe('POST /api/federation/key-update — writes only real columns', () => {
  function federationPeerColumns(): Set<string> {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', 'db');
    const schema = fs.readFileSync(path.join(root, 'postgres', 'schema.ts'), 'utf8');
    const table = schema.match(/CREATE TABLE IF NOT EXISTS federation_peers \(([\s\S]*?)\n\);/);
    const cols = new Set<string>((table ? table[1] : '').split('\n')
      .map((l: string) => l.trim().split(/\s+/)[0]?.replace(/"/g, '')).filter(Boolean));
    const migrations = fs.readdirSync(path.join(root, 'migrations_pg')).filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => fs.readFileSync(path.join(root, 'migrations_pg', f), 'utf8')).join('\n')
      + fs.readFileSync(path.join(root, 'postgres', 'migrations.ts'), 'utf8');
    for (const m of migrations.matchAll(/ALTER TABLE federation_peers\s+ADD COLUMN IF NOT EXISTS\s+"?(\w+)"?/gi)) cols.add(m[1]);
    return cols;
  }

  it('every column the route sets exists in federation_peers', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/federation', peersRouter);
    mockDb._reset();
    await mockDb.federationPeers.insert({ _id: 'peer-1', url: 'http://peer.example.com', name: 'Peer', publicKey: 'old', verified: true });
    const update = jest.spyOn(mockDb.federationPeers, 'update');

    const res = await request(app)
      .post('/api/federation/key-update')
      .set('x-bridge-ts', String(Date.now()))
      .set('x-bridge-rsa-sig', 'authenticated-by-middleware')
      .set('x-bridge-instance-url', 'http://peer.example.com')
      .send({ url: 'http://peer.example.com', publicKey: { publicKeyPem: '-----BEGIN PUBLIC KEY-----\nNEW\n-----END PUBLIC KEY-----' } });

    expect(res.status).toBe(200);
    const columns = federationPeerColumns();
    expect(columns).toContain('publicKey'); // the DDL parse itself works
    const written = Object.keys((update.mock.calls.at(-1)![1] as { $set: Record<string, unknown> }).$set);
    expect(written.filter((c) => !columns.has(c))).toEqual([]);
  });
});
