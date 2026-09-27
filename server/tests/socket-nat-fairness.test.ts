// server/tests/socket-nat-fairness.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AYNI NAT ARKASINDAKİ KİŞİLER BİRBİRİNİ BANLATMAMALI — SOKET BAĞLANTISI
// ════════════════════════════════════════════════════════════════════════════
// Final21 Faz 11'de HTTP tarafında kapatılan F21-11-04'ün SOKET kardeşi (Faz 16'ya
// devredilmiş, Faz 19'da kapatıldı). `scripts/e2e-server.js` bunu yazıyordu:
//
//   "TEK bir NAT/kurumsal IP arkasındaki 20+ kullanıcı aynı dakika içinde Bridge'i
//    açarsa, o ofisin TAMAMI 15 dakika banlanır."
//
// Soket bağlantı sınırı kimlik doğrulamasından ÖNCE, yalnızca IP ile çalışıyordu
// (20 bağlantı/dk; aşımlar ihlal sayılır, 5 ihlal = 15 dk IP banı). Okul, ofis, yurt ve
// operatör CGNAT'ı tek IP paylaşır.
//
// Düzeltme F21-11-04 ile AYNI model: imzası DOĞRULANMIŞ erişim jetonu taşıyan bağlantı
// kişinin kendi kotasından düşer; IP için ayrı ve geniş bir acil tavan (max × 20) kalır.
// Anonim / sahte jetonlu bağlantı için davranış DEĞİŞMEZ (IP başına 20/dk, aşım = ihlal,
// eşik = ban).

process.env.NODE_ENV = 'test';
process.env.RL_SOCKET_CONNECT_MAX = '3';
process.env.RL_AUTO_BAN_THRESHOLD = '2';
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
delete process.env.REDIS_URL;

const getBan = jest.fn(async () => null);
const banIp = jest.fn(async () => undefined);
jest.mock('../lib/redisAdapter', () => ({
  cache: { slidingWindowCount: jest.fn(), increment: jest.fn(), del: jest.fn() },
  isRedisAvailable: () => false,
}));
jest.mock('../middleware/ipBan', () => ({
  getBan: () => getBan(),
  banIp: (...args: unknown[]) => (banIp as jest.Mock)(...args),
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ipRateCheckFor, IP_SOCKET_RL } from '../socket/ipRateLimit';

afterAll(() => {
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
});

let n = 0;
const freshIp = () => `198.51.100.${++n}`;

beforeEach(() => { banIp.mockClear(); getBan.mockClear(); });

describe('socket connect limit — shared IP fairness', () => {
  it('many signed-in people behind ONE IP can all connect in the same minute', async () => {
    const ip = freshIp();
    const results: boolean[] = [];
    for (let user = 0; user < 10; user++) results.push(await ipRateCheckFor(ip, 'connect', `user-${user}`));
    // max=3 per minute. Before the fix the 4th person was refused and, after the ban
    // threshold, the whole office was banned.
    expect(results.every(Boolean)).toBe(true);
    expect(banIp).not.toHaveBeenCalled();
  });

  it('one person reconnecting too often is refused WITHOUT banning their colleagues', async () => {
    const ip = freshIp();
    const own: boolean[] = [];
    for (let i = 0; i < 6; i++) own.push(await ipRateCheckFor(ip, 'connect', 'noisy-user'));
    expect(own).toEqual([true, true, true, false, false, false]);
    // No IP ban: the quota that ran out is this account's own.
    expect(banIp).not.toHaveBeenCalled();
    await expect(ipRateCheckFor(ip, 'connect', 'quiet-colleague')).resolves.toBe(true);
  });

  it('CONTROL: anonymous connections keep the strict per-IP limit and still lead to a ban', async () => {
    const ip = freshIp();
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push(await ipRateCheckFor(ip, 'connect', null));
    expect(results.slice(0, 3)).toEqual([true, true, true]);
    expect(results.slice(3).some(Boolean)).toBe(false);
    expect(banIp).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: signed-in traffic still has an IP emergency ceiling (max × 20)', async () => {
    const ip = freshIp();
    const ceiling = IP_SOCKET_RL.connect.max * 20;
    let allowed = 0;
    for (let i = 0; i < ceiling + 5; i++) if (await ipRateCheckFor(ip, 'connect', `u-${i}`)) allowed++;
    expect(allowed).toBe(ceiling);
  });
});
