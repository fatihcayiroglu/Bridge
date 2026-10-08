// e2e/tests/account-deletion-journey.spec.ts
//
// ════════════════════════════════════════════════════════════════════════════
// HESABI ÜRÜNDEN SİLMEK — GERÇEK TARAYICI, GERÇEK SUNUCU (Final21 Faz 19)
// ════════════════════════════════════════════════════════════════════════════
// Sunucuda silme ucu ve ön denetimi vardı ama istemcide hiçbir giriş noktası yoktu; kişi
// hesabını üründen silemiyordu. Bu yolculuk kullanıcının yaptığını yapar:
//   1. Başka üyesi olan bir sunucunun sahibiyken silme SUNULMAZ; engel adıyla listelenir.
//   2. Sunucuyu siler, tekrar dener: parola + onay formu gelir.
//   3. Yanlış parola: hata görünür, oturum AÇIK kalır (eskiden 401 → istemci çıkış yapardı).
//   4. Doğru parola: giriş ekranına döner, başarı mesajı görünür.
//   5. Aynı kimlik bilgileriyle giriş artık reddedilir, eski jeton ölüdür.
// Paylaşılan mesajların anonimleştirilmesi: server/tests/pg-integration/account-erasure.pgtest.ts
// ve tools/p19-account-delete-privacy-probe.mjs (canlı sunucu).

import { test, expect } from '@playwright/test';
import { getTokens, createTestServer, createInvite, joinServerViaInvite, loginViaUI } from '../helpers/bridge';
import { getCsrf } from '../helpers/csrf';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

test.use({ storageState: { cookies: [], origins: [] } });

test('kişi hesabını Ayarlar → Gizlilik üzerinden siler; sahiplik engeli ve yanlış parola güvenli', async ({ page, request }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const username = `del_ui_${stamp}`.slice(0, 30);
  const password = 'E2eDeletePass123!';
  const reg = await request.post(`${BASE}/api/register`, {
    headers: JSON_HEADERS,
    data: { username, email: `${username}@bridge-e2e.test`, password, displayName: `Leaving ${stamp}` },
  });
  expect(reg.ok(), 'kayıt').toBe(true);
  const registered = await reg.json() as { token: string; stepUp?: { grants?: Record<string, string> } };
  const token = registered.token;
  // P7 B2: registration is a fresh sign-in — like the product client, the API
  // calls below present the grant it returned for irreversible actions.
  const destructiveGrant = registered.stepUp?.grants?.['destructive-admin'] ?? '';

  // Başka üyesi olan bir sunucu: alice katılır.
  const aliceToken = getTokens().alice;
  const server = await createTestServer(request, token, `Owned ${stamp}`);
  const serverId = String(server._id ?? server.id);
  const code = await createInvite(request, token, serverId);
  expect(code, 'davet').toBeTruthy();
  expect((await joinServerViaInvite(request, aliceToken, String(code))).ok()).toBe(true);

  await loginViaUI(page, username, password);
  await page.locator('[data-bridge-action="openSettingsModal"]').first().click();
  await page.locator('#tab-privacy').click();
  const card = page.getByTestId('delete-account');
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 1. Engel: silme sunulmaz, sunucu adıyla listelenir.
  await page.getByTestId('delete-account-start').click();
  await expect(page.getByTestId('delete-account-blockers')).toContainText(`Owned ${stamp}`, { timeout: 15_000 });
  await expect(page.getByTestId('delete-account-password')).toHaveCount(0);

  // 2. Sahip sunucuyu siler (kendi yolu), tekrar dener.
  const del = await request.delete(`${BASE}/api/servers/${serverId}`, {
    headers: {
      ...JSON_HEADERS, Authorization: `Bearer ${token}`, 'X-CSRF-Token': await getCsrf(request, token),
      'X-Bridge-Step-Up': destructiveGrant,
    },
  });
  expect(del.ok(), 'sunucu silme').toBe(true);
  await page.getByTestId('delete-account-cancel').click();
  await page.getByTestId('delete-account-start').click();
  const confirm = page.getByTestId('delete-account-confirm');
  await expect(confirm).toBeDisabled({ timeout: 15_000 });

  // 3. Yanlış parola: hata, oturum açık.
  await page.getByTestId('delete-account-password').fill('bu-yanlis-parola');
  await page.getByTestId('delete-account-ack').check();
  await confirm.click();
  await expect(card.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#login-form')).toBeHidden();
  expect((await request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);

  // 4. Doğru parola: giriş ekranı + başarı mesajı.
  await page.getByTestId('delete-account-password').fill(password);
  await confirm.click();
  await expect(page.locator('#login-form')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#auth-msg.auth-success')).toBeVisible();

  // 5. Aynı kimlik bilgileri artık geçersiz; eski jeton ölü.
  const relog = await request.post(`${BASE}/api/login`, { headers: JSON_HEADERS, data: { username, password } });
  expect(relog.status()).toBe(401);
  expect((await request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
});
