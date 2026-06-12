// server/tests/federation-rsa.test.ts
// ADR-0006 Faz 1+2 — federation RSA key + imza doğrulama

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.FEDERATION_SECRET = 'test-federation-secret';
process.env.INSTANCE_URL = 'http://localhost:3001';
process.env.AP_ENCRYPTION_KEY = 'a'.repeat(64);

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/loader', () => mockDb);

import crypto from 'crypto';
import request from 'supertest';
import express from 'express';
import {
  getOrCreateFederationKeys,
  getFederationPublicKeyDoc,
  signFederationPayload,
  formatBridgeSignatureHeader,
  _resetFederationKeyCache,
} from '../lib/federationKeys';
import { signFederationRequest, verifyFederationRequest, _resetSignatureReplayCache } from '../lib/httpSignature';
import peersRouter from '../routes/federation/peers';

const app = express();
app.use(express.json());
app.use('/api/federation', peersRouter);

beforeEach(() => {
  _resetFederationKeyCache();
  _resetSignatureReplayCache();
  mockDb._reset();
});

describe('GET /api/federation/info — publicKey (ADR-0006 Faz 1)', () => {
  it('publicKey alanını PEM ile döndürür', async () => {
    const res = await request(app).get('/api/federation/info');
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBeDefined();
    expect(res.body.publicKey.publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
    expect(res.body.publicKey.id).toContain('/api/federation/key');
    expect(res.body.publicKey.owner).toBe('http://localhost:3001');
  });
});

describe('GET /api/federation/key', () => {
  it('public key dokümanını döndürür', async () => {
    const res = await request(app).get('/api/federation/key');
    expect(res.status).toBe(200);
    expect(res.body.publicKey.publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
  });
});

describe('Bridge-to-Bridge RSA imza (ADR-0006 Faz 2)', () => {
  it('signFederationRequest RSA + HMAC header üretir', async () => {
    const body = { url: 'http://localhost:3001' };
    const signed = await signFederationRequest(body);

    expect(signed.ts).toBeDefined();
    expect(signed.hmacSig.length).toBeGreaterThan(10);
    expect(signed.rsaSignature.length).toBeGreaterThan(10);
    expect(signed.keyId).toContain('/api/federation/key');
  });

  it('verifyFederationRequest RSA imzasını doğrular', async () => {
    const keys = await getOrCreateFederationKeys();
    const body = { url: process.env.INSTANCE_URL };
    const ts = String(Date.now());
    const signature = signFederationPayload(keys.privateKeyPem, ts, body);
    const keyId = getFederationPublicKeyDoc(keys)!.id;

    const req = {
      method: 'POST',
      url: '/api/federation/ping',
      headers: {
        'x-bridge-ts': ts,
        'X-Bridge-Signature': formatBridgeSignatureHeader(keyId, signature),
      },
      body,
    };

    await expect(verifyFederationRequest(req)).resolves.toBe(true);
  });

  it('geçersiz RSA imzası reddedilir', async () => {
    const keys = await getOrCreateFederationKeys();
    const body = { url: process.env.INSTANCE_URL };
    const ts = String(Date.now());
    const keyId = getFederationPublicKeyDoc(keys)!.id;

    const req = {
      method: 'POST',
      url: '/api/federation/ping',
      headers: {
        'x-bridge-ts': ts,
        'X-Bridge-Signature': formatBridgeSignatureHeader(keyId, Buffer.from('invalid').toString('base64')),
      },
      body,
    };

    await expect(verifyFederationRequest(req)).resolves.toBe(false);
  });

  it('HMAC fallback çalışır (geriye dönük uyumluluk)', async () => {
    const body = { url: 'http://localhost:3001' };
    const ts = String(Date.now());
    const payload = ts + JSON.stringify(body);
    const hmacSig = crypto.createHmac('sha256', process.env.FEDERATION_SECRET!)
      .update(payload).digest('hex');

    const req = {
      method: 'POST',
      url: '/api/federation/ping',
      headers: { 'x-bridge-ts': ts, 'x-bridge-sig': hmacSig },
      body,
    };

    await expect(verifyFederationRequest(req)).resolves.toBe(true);
  });

  it('RSA imza replay reddedilir', async () => {
    const body = { url: process.env.INSTANCE_URL, _nonce: `replay-${Date.now()}` };
    const signed = await signFederationRequest(body);
    const req = {
      method: 'POST',
      url: '/api/federation/ping',
      headers: {
        'x-bridge-ts': signed.ts,
        'X-Bridge-Signature': formatBridgeSignatureHeader(signed.keyId, signed.rsaSignature),
      },
      body,
    };

    await expect(verifyFederationRequest(req)).resolves.toBe(true);
    await expect(verifyFederationRequest(req)).resolves.toBe(false);
  });

  it('FEDERATION_SECRET yokken HMAC reddedilir (production simülasyonu)', async () => {
    const prev = process.env.FEDERATION_SECRET;
    const prevNode = process.env.NODE_ENV;
    delete process.env.FEDERATION_SECRET;
    process.env.NODE_ENV = 'production';

    const body = { url: 'http://localhost:3001' };
    const ts = String(Date.now());
    const req = {
      method: 'POST',
      url: '/api/federation/ping',
      headers: { 'x-bridge-ts': ts, 'x-bridge-sig': 'deadbeef'.repeat(8) },
      body,
    };

    await expect(verifyFederationRequest(req)).resolves.toBe(false);

    process.env.FEDERATION_SECRET = prev;
    process.env.NODE_ENV = prevNode;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// federationAuth middleware (Sprint 108 — httpSignatureV2)
// ─────────────────────────────────────────────────────────────────────────────

import { federationAuth, federationAuthRsaRequired } from '../middleware/federationAuth';
import type { Request, Response, NextFunction } from 'express';
import { buildFederationHeaders } from '../lib/httpSignatureV2';

function makeRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res as Response;
}

function makeNext(): NextFunction {
  return jest.fn();
}

describe('federationAuth middleware (Sprint 108 — V2)', () => {
  beforeEach(() => {
    _resetFederationKeyCache();
    mockDb._reset();
  });

  it('x-bridge-instance-url eksikse 400 döner', async () => {
    const req = { headers: {}, body: {} } as Request;
    const res = makeRes();
    const next = makeNext();

    await federationAuth(req, res, next);

    expect((res.status as jest.Mock).mock.calls[0]?.[0]).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('bilinmeyen peer → 401 (Unknown peer)', async () => {
    const req = {
      headers: { 'x-bridge-instance-url': 'https://unknown.peer.example.com', 'x-bridge-ts': String(Date.now()) },
      body: { url: 'https://unknown.peer.example.com' },
    } as unknown as Request;
    const res = makeRes();
    const next = makeNext();

    await federationAuth(req, res, next);

    expect((res.status as jest.Mock).mock.calls[0]?.[0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('geçerli HMAC imzası → next() çağrılır, req.federationMethod ayarlanır', async () => {
    const peerUrl = 'https://peer.bridge.example.com';
    await mockDb.federationPeers.insert({
      _id: 'mw-peer-1', url: peerUrl, name: 'MW Peer',
      verified: true, lastSeen: Date.now(),
    });

    const body    = { url: peerUrl };
    const payload = JSON.stringify(body);
    const ts      = String(Date.now());
    const hmacSig = require('crypto')
      .createHmac('sha256', process.env.FEDERATION_SECRET!)
      .update(ts + payload)
      .digest('hex');

    const req = {
      headers: {
        'x-bridge-instance-url': peerUrl,
        'x-bridge-ts':  ts,
        'x-bridge-sig': hmacSig,
      },
      body,
    } as unknown as Request;
    const res  = makeRes();
    const next = makeNext();

    await federationAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.federationMethod).toBe('hmac');
    expect(req.federationPeerUrl).toBe(peerUrl);
  });

  it('geçersiz imza → 401 döner', async () => {
    const peerUrl = 'https://peer2.bridge.example.com';
    await mockDb.federationPeers.insert({
      _id: 'mw-peer-2', url: peerUrl, name: 'MW Peer 2',
      verified: true, lastSeen: Date.now(),
    });

    const req = {
      headers: {
        'x-bridge-instance-url': peerUrl,
        'x-bridge-ts':  String(Date.now()),
        'x-bridge-sig': 'invalidsignature',
      },
      body: { url: peerUrl },
    } as unknown as Request;
    const res  = makeRes();
    const next = makeNext();

    await federationAuth(req, res, next);

    expect((res.status as jest.Mock).mock.calls[0]?.[0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('federationAuthRsaRequired — HMAC ile 401 döner', async () => {
    const peerUrl = 'https://peer3.bridge.example.com';
    await mockDb.federationPeers.insert({
      _id: 'mw-peer-3', url: peerUrl, name: 'MW Peer 3',
      verified: true, lastSeen: Date.now(),
    });

    const payload = JSON.stringify({ url: peerUrl });
    const ts      = String(Date.now());
    const hmacSig = require('crypto')
      .createHmac('sha256', process.env.FEDERATION_SECRET!)
      .update(ts + payload)
      .digest('hex');

    const req = {
      headers: {
        'x-bridge-instance-url': peerUrl,
        'x-bridge-ts':  ts,
        'x-bridge-sig': hmacSig,
      },
      body: { url: peerUrl },
    } as unknown as Request;
    const res  = makeRes();
    const next = makeNext();

    await federationAuthRsaRequired(req, res, next);

    expect((res.status as jest.Mock).mock.calls[0]?.[0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
