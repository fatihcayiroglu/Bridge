// server/tests/federation-peer-announce.test.ts
//
// P5 FED-03: a rotated instance key is announced to every registered peer.
// The receiving endpoint (POST /api/federation/key-update) existed, but no code
// called it — after a rotation every peer kept refusing this installation.
//
// The announcement is signed with the PREVIOUS key. This suite verifies what is
// sent with the receiver's real verifier (only key/replay/peer stores are doubles).
process.env.NODE_ENV = 'test';

import crypto from 'crypto';

function pair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const mockPeers: Array<Record<string, unknown>> = [];
const mockReceiverPeers = new Map<string, Record<string, unknown>>();
const mockFetchT = jest.fn();

jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => mockFetchT(...args) }));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../lib/federationKeys', () => ({
  getOrCreateFederationKeys: jest.fn(async () => { throw new Error('announcement must use the key it is given'); }),
  getFederationKeyId: () => 'https://a.bridge.test/api/federation/key',
  getInstanceUrl: () => 'https://a.bridge.test',
}));
jest.mock('../lib/httpSignature', () => ({ claimSignatureReplay: jest.fn(async () => true) }));
jest.mock('../db/loader', () => ({
  __esModule: true,
  default: { federationPeers: { findOne: jest.fn(async ({ url }: { url: string }) => mockReceiverPeers.get(url) ?? null) } },
}));
jest.mock('../db/repositories', () => ({
  Federation: { findPeers: jest.fn(async () => mockPeers), getPeerByUrl: jest.fn(async () => null) },
}));

import { announceKeyRotation } from '../lib/federationPeerAnnounce';
import { verifyFederationRequestV3 } from '../lib/httpSignatureV3';

const oldKey = pair();
const newKey = pair();

beforeEach(() => {
  mockPeers.length = 0;
  mockReceiverPeers.clear();
  mockFetchT.mockReset();
  // Peer B has A registered with A's OLD key.
  mockReceiverPeers.set('https://a.bridge.test', { _id: 'a-at-b', url: 'https://a.bridge.test', publicKey: oldKey.publicKey });
});

function sentAt(i: number) {
  const [url, init] = mockFetchT.mock.calls[i] as [string, { headers: Record<string, string>; body: string; method: string }];
  return { url, ...init };
}

it('every peer receives the new key, signed so it verifies under the OLD one', async () => {
  mockPeers.push({ _id: 'b', url: 'https://b.bridge.test' }, { _id: 'c', url: 'https://c.bridge.test/' });
  mockFetchT.mockResolvedValue({ ok: true, status: 200 });

  const results = await announceKeyRotation(oldKey.privateKey, { id: 'k', owner: 'https://a.bridge.test', publicKeyPem: newKey.publicKey });

  expect(results).toEqual([
    { peerId: 'b', url: 'https://b.bridge.test', ok: true, status: 200 },
    { peerId: 'c', url: 'https://c.bridge.test/', ok: true, status: 200 },
  ]);
  const toB = sentAt(0);
  expect(toB.url).toBe('https://b.bridge.test/api/federation/key-update');
  expect(toB.method).toBe('POST');
  expect(JSON.parse(toB.body)).toEqual({ url: 'https://a.bridge.test', publicKey: { id: 'k', owner: 'https://a.bridge.test', publicKeyPem: newKey.publicKey } });

  const ctx = { method: 'POST', path: '/api/federation/key-update', target: 'https://b.bridge.test' };
  const verdict = await verifyFederationRequestV3(toB.headers['x-bridge-instance-url'], toB.body, toB.headers, ctx);
  expect(verdict).toMatchObject({ ok: true, peerId: 'a-at-b' });
});

it('negative control: signed with the NEW key it would not verify at a peer that still holds the old one', async () => {
  mockPeers.push({ _id: 'b', url: 'https://b.bridge.test' });
  mockFetchT.mockResolvedValue({ ok: true, status: 200 });

  await announceKeyRotation(newKey.privateKey, { publicKeyPem: newKey.publicKey });
  const toB = sentAt(0);
  const ctx = { method: 'POST', path: '/api/federation/key-update', target: 'https://b.bridge.test' };
  await expect(verifyFederationRequestV3(toB.headers['x-bridge-instance-url'], toB.body, toB.headers, ctx))
    .resolves.toMatchObject({ ok: false, reason: 'RSA signature invalid' });
});

it('one unreachable or refusing peer does not stop the others, and is reported', async () => {
  mockPeers.push({ _id: 'b', url: 'https://b.bridge.test' }, { _id: 'c', url: 'https://c.bridge.test' }, { _id: 'd', url: 'https://d.bridge.test' });
  mockFetchT
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    .mockResolvedValueOnce({ ok: false, status: 401 })
    .mockResolvedValueOnce({ ok: true, status: 200 });

  const results = await announceKeyRotation(oldKey.privateKey, { publicKeyPem: newKey.publicKey });

  expect(results).toEqual([
    { peerId: 'b', url: 'https://b.bridge.test', ok: false, error: 'ECONNREFUSED' },
    { peerId: 'c', url: 'https://c.bridge.test', ok: false, status: 401 },
    { peerId: 'd', url: 'https://d.bridge.test', ok: true, status: 200 },
  ]);
  const logger = jest.requireMock('../lib/logger').default;
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.key_rotation.announce_failed' }), expect.any(String));
});

it('no peers: nothing is sent', async () => {
  await expect(announceKeyRotation(oldKey.privateKey, { publicKeyPem: newKey.publicKey })).resolves.toEqual([]);
  expect(mockFetchT).not.toHaveBeenCalled();
});
