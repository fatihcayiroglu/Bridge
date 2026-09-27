'use strict';
process.env.NODE_ENV = 'test';

import { at } from './helpers/narrow';
import express from 'express';
import request from 'supertest';

const users = {
  // Urun `updateWhere(query, update)` cagirir; parametresiz imza cagri
  // kaydini BOS TUPLE yapiyordu.
  updateWhere: jest.fn<Promise<unknown>, [query: Record<string, unknown>, update: Record<string, unknown>]>(async () => undefined),
  findById: jest.fn(),
  findByIds: jest.fn(),
  consumeX3dhPreKeyBundle: jest.fn(),
};
// RET yanitlari `reason` tasir; cikarilan tip onu icermiyordu ve
// 'DM engelli' dali KURULAMIYORDU.
interface DmAccessDecision { allowed: boolean; existingConversation?: boolean; reason?: string }
const evaluateDmAccess = jest.fn<Promise<DmAccessDecision>, unknown[]>(
  async () => ({ allowed: true, existingConversation: false }));

jest.mock('../db/repositories', () => ({ Users: users }));
jest.mock('../lib/dmAccessPolicy', () => ({ evaluateDmAccess: (...args: unknown[]) => evaluateDmAccess(...args) }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: () => void) => { req.user = { id: 'me' }; next(); },
}));

import { router } from '../lib/e2e';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/e2e', router);
  return a;
}

describe('E2EE key/prekey route contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    users.findById.mockResolvedValue(null);
    users.findByIds.mockResolvedValue([]);
    users.consumeX3dhPreKeyBundle.mockResolvedValue(null);
    users.updateWhere.mockResolvedValue(undefined);
    evaluateDmAccess.mockResolvedValue({ allowed: true, existingConversation: false });
    delete process.env.BRIDGE_E2EE_ENABLED;
  });

  it.each([
    [{}, 'publicKey required'],
    [{ publicKey: 42 }, 'Invalid publicKey format'],
    [{ publicKey: 'x'.repeat(201) }, 'Invalid publicKey format'],
  ])('rejects malformed public key registration %#', async (body, error) => {
    const res = await request(app()).post('/api/e2e/keys').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(users.updateWhere).not.toHaveBeenCalled();
  });

  it('stores a public key with default protocol metadata', async () => {
    const before = Date.now();
    const res = await request(app()).post('/api/e2e/keys').send({ publicKey: 'pk' });
    expect(res.status).toBe(200);
    expect(users.updateWhere).toHaveBeenCalledWith({ _id: 'me' }, { $set: expect.objectContaining({
      e2ePublicKey: 'pk', e2eKeyVersion: 1, e2eAlgorithm: 'X25519', e2eKeyUpdatedAt: expect.any(Number),
    }) });
    expect(at(users.updateWhere.mock.calls[0][1], '$set.e2eKeyUpdatedAt', 'guncelleme')).toBeGreaterThanOrEqual(before);
  });

  it('stores explicit key version and algorithm metadata', async () => {
    await request(app()).post('/api/e2e/keys').send({ publicKey: 'pk', keyVersion: 2, algorithm: 'P-256' });
    expect(users.updateWhere).toHaveBeenCalledWith({ _id: 'me' }, { $set: expect.objectContaining({ e2eKeyVersion: 2, e2eAlgorithm: 'P-256' }) });
  });

  it.each([
    [{ publicKey: 'pk', keyVersion: 0 }, 'Invalid keyVersion'],
    [{ publicKey: 'pk', keyVersion: '2' }, 'Invalid keyVersion'],
    [{ publicKey: 'pk', algorithm: 'RSA' }, 'Invalid algorithm'],
  ])('rejects invalid public-key protocol metadata %#', async (body, error) => {
    const res = await request(app()).post('/api/e2e/keys').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(users.updateWhere).not.toHaveBeenCalled();
  });

  it('returns 404, no-key, default-key metadata, and explicit-key metadata', async () => {
    let res = await request(app()).get('/api/e2e/keys/u1');
    expect(res.status).toBe(404);

    users.findById.mockResolvedValueOnce({ _id: 'u1' });
    res = await request(app()).get('/api/e2e/keys/u1');
    expect(res.body).toEqual(expect.objectContaining({ hasKey: false }));

    users.findById.mockResolvedValueOnce({ _id: 'u1', e2ePublicKey: 'pk', e2eKeyUpdatedAt: 5 });
    res = await request(app()).get('/api/e2e/keys/u1');
    expect(res.body).toEqual(expect.objectContaining({ hasKey: true, keyVersion: 1, algorithm: 'X25519', updatedAt: 5 }));

    users.findById.mockResolvedValueOnce({ _id: 'u1', e2ePublicKey: 'pk', e2eKeyVersion: 4, e2eAlgorithm: 'P-256' });
    res = await request(app()).get('/api/e2e/keys/u1');
    expect(res.body).toEqual(expect.objectContaining({ keyVersion: 4, algorithm: 'P-256' }));
  });

  it.each([null, 'bad', {}, Array.from({ length: 51 }, (_, i) => `u${i}`)])('rejects invalid batch key lookup input %#', async (userIds) => {
    const res = await request(app()).post('/api/e2e/keys/batch').send({ userIds });
    expect(res.status).toBe(400);
  });

  it('returns keyed batch results with safe defaults and missing-key markers', async () => {
    users.findByIds.mockResolvedValueOnce([
      { _id: 'a', e2ePublicKey: 'a-pk' },
      { _id: 'b', e2ePublicKey: 'b-pk', e2eKeyVersion: 3, e2eAlgorithm: 'P-256' },
      { _id: 'c' },
    ]);
    const res = await request(app()).post('/api/e2e/keys/batch').send({ userIds: ['a','b','c'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      a: { hasKey: true, publicKey: 'a-pk', keyVersion: 1, algorithm: 'X25519' },
      b: { hasKey: true, publicKey: 'b-pk', keyVersion: 3, algorithm: 'P-256' },
      c: { hasKey: false },
    });
  });

  it('deletes only the authenticated user public-key material', async () => {
    const res = await request(app()).delete('/api/e2e/keys');
    expect(res.status).toBe(200);
    expect(users.updateWhere).toHaveBeenCalledWith({ _id: 'me' }, { $set: { e2ePublicKey: null, e2eKeyUpdatedAt: expect.any(Number) } });
  });

  it.each([[undefined,false], ['false',false], ['TRUE',false], ['true',true]])('feature flag %p -> %p', async (value, expected) => {
    if (value === undefined) delete process.env.BRIDGE_E2EE_ENABLED; else process.env.BRIDGE_E2EE_ENABLED = value;
    const res = await request(app()).get('/api/e2e/feature-status');
    expect(res.body).toEqual({ enabled: expected });
  });

  it('returns disabled/null status for missing user and populated status for configured user', async () => {
    let res = await request(app()).get('/api/e2e/status');
    expect(res.body).toEqual(expect.objectContaining({ enabled: false, keyVersion: null, algorithm: null, updatedAt: null }));

    users.findById.mockResolvedValueOnce({ e2ePublicKey: 'pk', e2eKeyVersion: 2, e2eAlgorithm: 'X25519', e2eKeyUpdatedAt: 7 });
    res = await request(app()).get('/api/e2e/status');
    expect(res.body).toEqual(expect.objectContaining({ enabled: true, keyVersion: 2, algorithm: 'X25519', updatedAt: 7 }));
  });

  it.each([
    [{}, 'identityKey, signedPreKey (publicKey+signature) gerekli'],
    [{ identityKey: 'id', signedPreKey: { publicKey: 'spk' } }, 'identityKey, signedPreKey (publicKey+signature) gerekli'],
    [{ identityKey: 42, signedPreKey: { keyId: 1, publicKey: 'spk', signature: 'sig' } }, 'Geçersiz identityKey'],
    [{ identityKey: 'x'.repeat(257), signedPreKey: { keyId: 1, publicKey: 'spk', signature: 'sig' } }, 'Geçersiz identityKey'],
    [{ identityKey: 'id', signedPreKey: { keyId: '1', publicKey: 'spk', signature: 'sig' } }, 'Geçersiz signedPreKey'],
    [{ identityKey: 'id', signedPreKey: { keyId: 1, publicKey: 'x'.repeat(257), signature: 'sig' } }, 'Geçersiz signedPreKey'],
  ])('rejects malformed X3DH prekey bundle %#', async (body, error) => {
    const res = await request(app()).post('/api/e2e/prekeys').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });

  it('rejects malformed, oversized, and duplicate OTPK collections', async () => {
    const base = { identityKey: 'id', signedPreKey: { keyId: 1, publicKey: 'spk', signature: 'sig' } };
    let res = await request(app()).post('/api/e2e/prekeys').send({ ...base, oneTimePreKeys: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('oneTimePreKeys array olmalı');

    res = await request(app()).post('/api/e2e/prekeys').send({ ...base, oneTimePreKeys: [{ keyId: -1, publicKey: 'bad' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Geçersiz oneTimePreKey');

    const keys = Array.from({ length: 105 }, (_, i) => ({ keyId: i, publicKey: `pk-${i}` }));
    res = await request(app()).post('/api/e2e/prekeys').send({ ...base, oneTimePreKeys: keys });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);

    res = await request(app()).post('/api/e2e/prekeys').send({
      ...base,
      oneTimePreKeys: [{ keyId: 1, publicKey: 'same' }, { keyId: 1, publicKey: 'other' }],
    });
    expect(res.status).toBe(400);
    res = await request(app()).post('/api/e2e/prekeys').send({
      ...base,
      oneTimePreKeys: [{ keyId: 1, publicKey: 'same' }, { keyId: 2, publicKey: 'same' }],
    });
    expect(res.status).toBe(400);
    expect(users.updateWhere).not.toHaveBeenCalled();
  });

  it('returns 404/no-bundle for missing X3DH state', async () => {
    let res = await request(app()).get('/api/e2e/prekeys/u1');
    expect(res.status).toBe(404);
    users.findById.mockResolvedValueOnce({ _id: 'u1', dmPrivacy: 'everyone' });
    users.consumeX3dhPreKeyBundle.mockResolvedValueOnce({ _id: 'u1', identityKey: null, signedPreKey: null, oneTimePreKey: null, remainingOneTimeKeys: 0 });
    res = await request(app()).get('/api/e2e/prekeys/u1');
    expect(res.body).toEqual(expect.objectContaining({ hasBundle: false }));
  });

  it('returns the repository-atomic bundle when no one-time key exists', async () => {
    users.findById.mockResolvedValueOnce({ _id: 'u1', dmPrivacy: 'everyone' });
    users.consumeX3dhPreKeyBundle.mockResolvedValueOnce({ _id: 'u1', identityKey: 'id', signedPreKey: { keyId: 7, publicKey: 'spk', signature: 'sig' }, oneTimePreKey: null, remainingOneTimeKeys: 0 });
    const res = await request(app()).get('/api/e2e/prekeys/u1');
    expect(res.body).toEqual(expect.objectContaining({ hasBundle: true, oneTimePreKey: null, remainingOneTimeKeys: 0 }));
    expect(users.consumeX3dhPreKeyBundle).toHaveBeenCalledWith('u1');
  });

  it('returns the exactly-once one-time prekey selected by the repository', async () => {
    users.findById.mockResolvedValueOnce({ _id: 'u1', dmPrivacy: 'everyone' });
    const otpk = { keyId: 1, publicKey: 'one' };
    users.consumeX3dhPreKeyBundle.mockResolvedValueOnce({ _id: 'u1', identityKey: 'id', signedPreKey: { keyId: 9, publicKey: 'spk', signature: 'sig' }, oneTimePreKey: otpk, remainingOneTimeKeys: 1 });
    const res = await request(app()).get('/api/e2e/prekeys/u1');
    expect(res.body).toEqual(expect.objectContaining({ oneTimePreKey: otpk, remainingOneTimeKeys: 1 }));
  });

  it('count endpoint is self-only and signals replenish below ten keys', async () => {
    let res = await request(app()).get('/api/e2e/prekeys/other/count');
    expect(res.status).toBe(403);

    users.findById.mockResolvedValueOnce(null);
    res = await request(app()).get('/api/e2e/prekeys/me/count');
    expect(res.body).toEqual({ count: 0, needsReplenish: true });

    users.findById.mockResolvedValueOnce({ x3dhOneTimePreKeys: Array.from({ length: 10 }, (_, keyId) => ({ keyId, publicKey: `key-${keyId}` })) });
    res = await request(app()).get('/api/e2e/prekeys/me/count');
    expect(res.body).toEqual({ count: 10, needsReplenish: false });
  });

  it('does not consume a target OTPK when DM access is blocked', async () => {
    users.findById.mockResolvedValueOnce({ _id: 'u1', dmPrivacy: 'everyone' });
    evaluateDmAccess.mockResolvedValueOnce({ allowed: false, reason: 'blocked' });
    const res = await request(app()).get('/api/e2e/prekeys/u1');
    expect(res.status).toBe(403);
    expect(users.consumeX3dhPreKeyBundle).not.toHaveBeenCalled();
  });
});
