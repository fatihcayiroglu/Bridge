// server/tests/sprint10.test.ts — Sprint 10 Güvenlik Unit Testleri
//
// Kapsar:
//   1. SVG sanitizer — tehlikeli içerik stripping
//   2. SVG sanitizer — temiz SVG'yi değiştirmez
//   3. SVG sanitizer — dosya yazma (sanitizeSvgFile)
//   4. Token family — makeRefreshToken family atar
//   5. Token family — rotateRefreshToken family miras alır
//   6. Token family — reuse tespitinde family bazlı revoke
//
// Sprint 30: better-sqlite3 / DATA_DIR_OVERRIDE kaldırıldı.
//            Token testleri in-memory mockDb kullanıyor.
//            SVG dosya testleri için geçici klasör hâlâ kullanılıyor.

process.env.JWT_SECRET     = 'sprint10-test-jwt-secret-32charlong!!';
process.env.REFRESH_SECRET = 'sprint10-refresh-secret-32charlong!!';
process.env.NODE_ENV       = 'test';

const os   = require('os');
import path from 'path';
const fs   = require('fs');
const crypto = require('crypto');

function refreshHashForTest(rawToken: string) {
  return crypto.createHmac('sha256', process.env.REFRESH_SECRET).update(rawToken).digest('hex');
}

// SVG dosya testleri için geçici klasör (SQLite için değil)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sprint10-'));

import { createMockDb, requireDoc } from './helpers/mockDb';
const _db = createMockDb();

// ── SVG Sanitizer Testleri ─────────────────────────────────────────────────

describe('SVG Sanitizer — sanitizeSvgString', () => {
  const { sanitizeSvgString, isSvgSafe } = require('../lib/svgSanitizer');

  it('<script> tagını strip etmeli', () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert('XSS')</script>
      <rect width="100" height="100"/>
    </svg>`;
    const { clean, stripped } = sanitizeSvgString(input);
    expect(clean).not.toMatch(/<script/i);
    expect(stripped.some((s: string) => s.includes('script'))).toBe(true);
  });

  it('onerror attribute strip etmeli', () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg">
      <image href="x.png" onerror="alert(1)" width="100" height="100"/>
    </svg>`;
    const { clean, stripped } = sanitizeSvgString(input);
    expect(clean).not.toMatch(/onerror/i);
    expect(stripped.some((s: string) => s.includes('onerror'))).toBe(true);
  });

  it('javascript: href strip etmeli', () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg">
      <a href="javascript:alert(1)"><text>click</text></a>
    </svg>`;
    const { clean, stripped } = sanitizeSvgString(input);
    expect(clean).not.toMatch(/javascript:/i);
    expect(stripped.length).toBeGreaterThan(0);
  });

  it('<foreignObject> strip etmeli', () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg">
      <foreignObject><div onclick="alert()">hi</div></foreignObject>
    </svg>`;
    const { clean, stripped } = sanitizeSvgString(input);
    expect(clean).not.toMatch(/<foreignObject/i);
    expect(stripped.some((s: string) => s.includes('foreignObject'))).toBe(true);
  });

  it('onclick attribute strip etmeli', () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" onclick="evil()" fill="blue"/>
    </svg>`;
    const { clean, stripped } = sanitizeSvgString(input);
    expect(clean).not.toMatch(/onclick/i);
    expect(stripped.some((s: string) => s.includes('onclick'))).toBe(true);
  });

  it('CDATA bölümünü strip etmeli', () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg">
      <![CDATA[<script>alert(1)</script>]]>
    </svg>`;
    const { clean, stripped } = sanitizeSvgString(input);
    expect(clean).not.toMatch(/<!\[CDATA\[/);
    expect(stripped.some((s: string) => s.includes('CDATA'))).toBe(true);
  });

  it('temiz SVG değiştirilmemeli', () => {
    const clean = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="#2d9cdb"/>
  <text x="50" y="55" text-anchor="middle" fill="white">B</text>
</svg>`;
    const { stripped } = sanitizeSvgString(clean);
    expect(stripped.length).toBe(0);
  });

  it('onload event handler strip etmeli', () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <rect width="100" height="100"/>
    </svg>`;
    const { clean, stripped } = sanitizeSvgString(input);
    expect(clean).not.toMatch(/onload/i);
    expect(stripped.length).toBeGreaterThan(0);
  });

  it('xlink:href strip etmeli', () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <use xlink:href="http://evil.com/evil.svg#xss"/>
    </svg>`;
    const { clean, stripped } = sanitizeSvgString(input);
    expect(clean).not.toMatch(/xlink:href/i);
    expect(stripped.length).toBeGreaterThan(0);
  });

  it('isSvgSafe — tehlikeli SVG için false döner', () => {
    const dangerous = `<svg><script>alert(1)</script></svg>`;
    expect(isSvgSafe(dangerous)).toBe(false);
  });

  it('isSvgSafe — temiz SVG için true döner', () => {
    const safe = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>`;
    expect(isSvgSafe(safe)).toBe(true);
  });
});

// ── sanitizeSvgFile — Dosya Testleri ──────────────────────────────────────

describe('SVG Sanitizer — sanitizeSvgFile', () => {
  const { sanitizeSvgFile } = require('../lib/svgSanitizer');

  it('tehlikeli SVG dosyasını temizlemeli (rewritten: true)', async () => {
    const svgPath = path.join(tmpDir, `test-dangerous-${Date.now()}.svg`);
    fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert(1)</script>
      <circle cx="50" cy="50" r="40" fill="blue"/>
    </svg>`);

    const result = await sanitizeSvgFile(svgPath);
    // Temizlendi veya reddedildi — safe false ise dosya zararlı içeriyordu
    expect(typeof result.safe).toBe('boolean');
    if (result.safe) {
      expect(result.rewritten).toBe(true);
      // Dosyada script olmamalı
      const content = fs.readFileSync(svgPath, 'utf8');
      expect(content).not.toMatch(/<script/i);
    }
    // safe: false ise tamamen reddedildi — bu da kabul edilebilir
  });

  it('temiz SVG dosyasını değiştirmemeli (rewritten: false)', async () => {
    const cleanContent = `<svg xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="#2d9cdb"/>
</svg>`;
    const svgPath = path.join(tmpDir, `test-clean-${Date.now()}.svg`);
    fs.writeFileSync(svgPath, cleanContent);

    const result = await sanitizeSvgFile(svgPath);
    expect(result.safe).toBe(true);
    expect(result.rewritten).toBe(false);
    expect(result.stripped.length).toBe(0);
    // Dosya değişmemiş olmalı
    expect(fs.readFileSync(svgPath, 'utf8')).toBe(cleanContent);
  });

  it('non-SVG dosyasını pas geçmeli', async () => {
    const pngPath = path.join(tmpDir, `test.png`);
    fs.writeFileSync(pngPath, 'fake png content');

    const result = await sanitizeSvgFile(pngPath);
    expect(result.safe).toBe(true);
    expect(result.rewritten).toBe(false);
  });
});

// ── Token Family Testleri ──────────────────────────────────────────────────
// Sprint 30: better-sqlite3 kaldırıldı → in-memory mockDb kullanılıyor.

jest.mock('../db/loader', () => _db);
jest.mock('../db/index',  () => _db);

beforeEach(() => { _db._reset?.(); });

jest.mock('../lib/captcha', () => ({
  botFilterMiddleware:             () => (_req: unknown, _res: unknown, next: () => void) => next(),
  loginLockMiddleware:             (_req: unknown, _res: unknown, next: () => void) => next(),
  progressiveCaptchaMiddleware:    (_req: unknown, _res: unknown, next: () => void) => next(),
  captchaMiddleware:               (_req: unknown, _res: unknown, next: () => void) => next(),
  registrationThrottleMiddleware:  (_req: unknown, _res: unknown, next: () => void) => next(),
  recordFailedLogin:    jest.fn().mockResolvedValue(undefined),
  recordSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
  checkSuspiciousLogin: jest.fn().mockResolvedValue(undefined),
  recordRegistration:   jest.fn().mockResolvedValue(undefined),
  claimRegistrationSlot:          jest.fn().mockResolvedValue(true),
  _getIp:               () => '127.0.0.1',
  GENERIC_LOGIN_ERROR:  'Invalid username or password',
}));

jest.mock('../middleware/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

describe('Token Family — makeRefreshToken', () => {
  const { makeRefreshToken } = require('../middleware/auth');
  const db = require('../db/index');

  it('yeni token oluşturulunca family atanmalı', async () => {
    const fakeUser = { _id: 'user-family-test-1', username: 'familytest1', tokenVersion: 0 };
    const token = await makeRefreshToken(fakeUser);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(32);

    // DB'de family alanı dolu olmalı
    const row = await db.refreshTokens.findOne({ token: refreshHashForTest(token) });
    expect(row).toBeTruthy();
    expect(row.family).toBeTruthy();
    expect(typeof row.family).toBe('string');
    expect(row.family.length).toBeGreaterThan(0);
  });

  it('her yeni token farklı family almalı', async () => {
    const fakeUser1 = { _id: 'user-family-test-2', username: 'familytest2', tokenVersion: 0 };
    const fakeUser2 = { _id: 'user-family-test-3', username: 'familytest3', tokenVersion: 0 };

    const t1 = await makeRefreshToken(fakeUser1);
    const t2 = await makeRefreshToken(fakeUser2);

    const row1 = await db.refreshTokens.findOne({ token: refreshHashForTest(t1) });
    const row2 = await db.refreshTokens.findOne({ token: refreshHashForTest(t2) });

    expect(row1.family).not.toBe(row2.family);
  });
});

describe('Token Family — rotateRefreshToken', () => {
  const { makeRefreshToken, rotateRefreshToken } = require('../middleware/auth');
  const db = require('../db/index');
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');

  async function createTestUser(suffix: string) {
    const user = {
      _id:          uuidv4(),
      username:     `rotate_user_${suffix}`,
      password:     await bcrypt.hash('testpass', 8),
      displayName:  `RotateUser_${suffix}`,
      tokenVersion: 0,
      createdAt:    Date.now(),
    };
    await db.users.insert(user);
    return user;
  }

  it('rotate sonrası yeni token aynı family almalı', async () => {
    const user = await createTestUser('family_inherit');
    const oldToken = await makeRefreshToken(user);
    const oldRow   = await db.refreshTokens.findOne({ token: refreshHashForTest(oldToken) });
    const oldFamily = oldRow.family;

    const result = await rotateRefreshToken(oldToken);
    expect(result).toBeTruthy();
    expect(result.newToken).toBeTruthy();

    const newRow = await db.refreshTokens.findOne({ token: refreshHashForTest(result.newToken) });
    expect(newRow.family).toBe(oldFamily); // aile korunur
  });

  it('[CONCURRENCY] aynı refresh token için iki eşzamanlı rotate yalnız bir kazanan üretir ve replay aileyi iptal eder', async () => {
    const user = await createTestUser('parallel_rotate');
    const oldToken = await makeRefreshToken(user);

    const [a, b] = await Promise.all([
      rotateRefreshToken(oldToken),
      rotateRefreshToken(oldToken),
    ]);

    const results = [a, b];
    expect(results.filter(r => r && !('error' in r))).toHaveLength(1);
    expect(results.filter(r => r && 'error' in r && r.error === 'reuse')).toHaveLength(1);

    const winner = results.find(r => r && !('error' in r));
    expect(winner).toBeTruthy();
    const winnerRow = await db.refreshTokens.findOne({ token: refreshHashForTest(winner.newToken) });
    // The second concurrent use is a replay signal, so the whole family —
    // including the just-issued winner token — must be revoked.
    expect(winnerRow).toBeNull();
  });

  it('[SECURITY] tokenVersion artınca eski refresh token yeni access token basamaz', async () => {
    const user = await createTestUser('version_bound');
    const token = await makeRefreshToken(user);
    await db.users.update({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    const result = await rotateRefreshToken(token);
    expect(result).toEqual({ error: 'revoked' });
    expect(await db.refreshTokens.findOne({ token: refreshHashForTest(token) })).toBeNull();
  });

  it.each([
    ['non-canonical issuance tokenVersion', { tokenVersion: '01' }, 'revoked'],
    ['missing issuance tokenVersion', { tokenVersion: null }, 'revoked'],
    ['non-canonical persisted expiry', { expiresAt: '0x7fffffffffff' }, 'expired'],
  ])('[SECURITY] %s Number coercion ile oturumu diriltemez', async (_label, patch, expectedError) => {
    const user = await createTestUser(`persisted_state_${expectedError}_${Date.now()}`);
    const token = await makeRefreshToken(user);
    const tokenHash = refreshHashForTest(token);
    await db.refreshTokens.update({ token: tokenHash }, { $set: patch });

    await expect(rotateRefreshToken(token)).resolves.toEqual({ error: expectedError });
    expect(await db.refreshTokens.findOne({ token: tokenHash })).toBeNull();
  });

  it('token reuse — family bazlı tüm token silinmeli', async () => {
    const user  = await createTestUser('family_revoke');
    const token1 = await makeRefreshToken(user);

    // İlk rotate — başarılı
    const rot1 = await rotateRefreshToken(token1);
    expect(rot1).toBeTruthy();

    // Aynı eski token tekrar kullanmaya çalış — reuse!
    const rot2 = await rotateRefreshToken(token1);
    expect(rot2).toEqual({ error: 'reuse' }); // reddedildi

    // rot1.newToken da geçersiz olmalı (family silindiğinden)
    const newRow = await db.refreshTokens.findOne({ token: refreshHashForTest(rot1.newToken) });
    // Satır silinmiş olmalı
    expect(newRow).toBeNull();
  });
});

describe('AuthRepository — revokeByFamily', () => {
  const Auth = require('../db/repositories/AuthRepository');
  const db   = require('../db/index');
  const { v4: uuidv4 } = require('uuid');

  it('revokeByFamily aynı family token\'larını silmeli', async () => {
    const family = `test-family-${uuidv4()}`;
    const userId = `user-revoke-${uuidv4()}`;

    // Aynı aileye 3 token ekle
    for (let i = 0; i < 3; i++) {
      await db.refreshTokens.insert({
        _id: uuidv4(), token: `tok-${i}-${Date.now()}`, userId,
        expiresAt: Date.now() + 3600000, createdAt: Date.now(),
        used: 0, family, tokenVersion: 0,
      });
    }

    // Farklı aile — silinmemeli
    await db.refreshTokens.insert({
      _id: uuidv4(), token: `tok-other-${Date.now()}`, userId,
      expiresAt: Date.now() + 3600000, createdAt: Date.now(),
      used: 0, family: 'other-family',
    });

    await Auth.revokeByFamily(family);

    // Hedef family silinmiş olmalı
    const remaining = await Auth.findByFamily(family);
    expect(remaining.length).toBe(0);

    // Diğer family korunmuş olmalı
    const otherFamily = await Auth.findByFamily('other-family');
    expect(otherFamily.length).toBe(1);
  });

  it('findByFamily — belirli aileyi döndürmeli', async () => {
    const family  = `find-family-${uuidv4()}`;
    const userId  = `user-find-${uuidv4()}`;

    await db.refreshTokens.insert({
      _id: uuidv4(), token: `findtok-${Date.now()}`, userId,
      expiresAt: Date.now() + 3600000, createdAt: Date.now(),
      used: 0, family,
    });

    const found = await Auth.findByFamily(family);
    expect(Array.isArray(found)).toBe(true);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].family).toBe(family);
  });
});
