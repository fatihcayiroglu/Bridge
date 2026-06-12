// server/tests/federation-keys-admin.test.ts
// ADR-0006 Faz 2: rotate-key admin + key-update peer endpoint

'use strict';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
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
  federationAuth: jest.fn((req, res, next) => {
    req.federationMethod  = 'hmac';
    req.federationPeerUrl = req.headers['x-bridge-instance-url'] || req.body?.url || req.body?.instanceUrl || '';
    next();
  }),
  federationAuthRsaRequired: jest.fn((req, res, next) => {
    // key-update için RSA zorunlu: gerçek V2 doğrulamasını simüle et
    const ts  = req.headers['x-bridge-ts'] as string;
    const sig = req.headers['x-bridge-rsa-sig'] as string;
    if (!ts || !sig) {
      return res.status(401).json({ error: 'Federation authentication failed', reason: 'RSA signature required' });
    }
    req.federationMethod  = 'rsa';
    req.federationPeerUrl = req.headers['x-bridge-instance-url'] || req.body?.url || req.body?.instanceUrl || '';
    next();
  }),
}));

function adminToken(userId: string) {
  return jwt.sign({ id: userId, username: 'admin', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
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
});
