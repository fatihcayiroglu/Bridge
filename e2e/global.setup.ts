// e2e/global.setup.ts — Sprint 14: TypeScript dönüşümü
// e2e/global.setup.js — Test kullanıcılarını oluştur ve auth state'i kaydet
// Bu dosya tüm testlerden ÖNCE bir kez çalışır.

import { chromium, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Test kullanıcıları — sabit credentials (her run'da aynı)
const TEST_USERS = {
  alice: {
    username: 'e2e_alice',
    email: 'alice@bridge-e2e.test',
    password: 'E2eTestPass123!',
    displayName: 'Alice E2E',
  },
  bob: {
    username: 'e2e_bob',
    email: 'bob@bridge-e2e.test',
    password: 'E2eTestPass456!',
    displayName: 'Bob E2E',
  },
};

async function apiRegisterOrLogin(fetch, user) {
  // Önce kayıt dene, zaten varsa login yap
  const regRes = await fetch(`${BASE_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: user.username,
      email:    user.email,
      password: user.password,
      displayName: user.displayName,
    }),
  });

  if (regRes.ok) {
    const data = await regRes.json();
    // Sprint 9: refreshToken artık httpOnly cookie — sadece access token al
    return data.token || data.accessToken;
  }

  // Kayıt başarısız (zaten var), login dene
  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });

  if (!loginRes.ok) {
    // username yerine email ile dene (eski kayıt)
    const loginRes2 = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    if (!loginRes2.ok) {
      throw new Error(`Login failed for ${user.username}: ${loginRes.status}`);
    }
    const data2 = await loginRes2.json();
    return data2.token || data2.accessToken;
  }

  const data = await loginRes.json();
  // Sprint 9: refreshToken cookie'de, body'de yok
  return data.token || data.accessToken;
}

async function setup() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  console.log('\n🔧 E2E Setup: Test kullanıcıları hazırlanıyor...');

  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Node fetch (Node 18+)
  const nodeFetch = globalThis.fetch;

  // Alice token al
  const aliceToken = await apiRegisterOrLogin(nodeFetch, TEST_USERS.alice);
  console.log('✅ Alice hazır');

  // Bob token al
  const bobToken = await apiRegisterOrLogin(nodeFetch, TEST_USERS.bob);
  console.log('✅ Bob hazır');

  // Auth state'i localStorage'a kaydet (Playwright'ın storageState formatı)
  // Alice'in auth state'ini kaydet (ana test kullanıcısı)
  const authStatePath = path.join(FIXTURES_DIR, 'auth-state.json');
  await context.addCookies([]);

  // Token'ları fixture dosyasına da kaydet (API testleri için)
  const tokensPath = path.join(FIXTURES_DIR, 'tokens.json');
  fs.writeFileSync(
    tokensPath,
    JSON.stringify({ alice: aliceToken, bob: bobToken, users: TEST_USERS }, null, 2)
  );

  // Alice ile giriş yapıp storageState kaydet
  const page = await context.newPage();
  await page.goto(BASE_URL);

  // Token'ı localStorage'a inject et
  await page.evaluate((token) => {
    localStorage.setItem('token', token);
    localStorage.setItem('bridge_token', token);
  }, aliceToken);

  // Sayfayı yenile ve giriş teyit et
  await page.reload();
  await page.waitForTimeout(1000);

  // storageState kaydet
  await context.storageState({ path: authStatePath });
  console.log('✅ Auth state kaydedildi:', authStatePath);

  await browser.close();

  // ── Sprint 41: Fixture doğrulama ────────────────────────────────────────────
  // testChannelId veya testServerId eksikse testler sessizce skip olur.
  // Seed başarısızsa burada açıkça hata fırlat — CI'da gizli skip yerine
  // görünür kırmızı build tercih edilir.
  const written = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
  if (!written.alice) {
    throw new Error("E2E Setup HATA: alice token'u kaydedilemedi. Login/register başarısız olmuş olabilir.");
  }
  if (!written.bob) {
    throw new Error("E2E Setup HATA: bob token'u kaydedilemedi. Login/register başarısız olmuş olabilir.");
  }
  if (!fs.existsSync(authStatePath)) {
    throw new Error('E2E Setup HATA: auth-state.json oluşturulamadı.');
  }

  console.log('🎉 E2E Setup tamamlandı\n');
}

export default setup;
