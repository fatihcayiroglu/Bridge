// e2e/tests/webauthn-virtual.spec.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PASSKEY — GERCEK TARAYICI YASAM DONGUSU (SANAL DOGRULAYICI)
// ════════════════════════════════════════════════════════════════════════════
// Birim testleri `navigator.credentials`i sahteler; bu dosya sahtelemez.
// Chromium'un CDP `WebAuthn` alani ile GERCEK bir sanal dogrulayici takilir ve
// tarayicinin GERCEK WebAuthn uygulamasi calisir:
//
//   navigator.credentials.create()  -> gercek attestation
//   navigator.credentials.get()     -> gercek assertion + imza
//
// Sunucu tarafinda da gercek dogrulama kosar (imza, challenge, origin, RP).
// Yani bu, uctan uca MAKINE kanitidir.
//
// ── NE KANITLANMAZ ──────────────────────────────────────────────────────────
// Fiziksel bir guvenlik anahtari, parmak izi veya yuz tanima DONANIMI
// KANITLANMAZ. Sanal dogrulayici protokolu uygular, donanimi degil.
// Donanim dogrulamasi REAL_DEVICE_DEFERRED olarak kalir.
//
// ── NEDEN localhost, 127.0.0.1 DEGIL ────────────────────────────────────────
// Sunucunun RP_ID varsayilani `localhost`. WebAuthn, rpId'nin sayfa
// origin'inin kayitli alan adi soneki olmasini SART kosar. Sayfa
// `http://127.0.0.1:3000` uzerinden acilirsa tarayici rpId `localhost` icin
// SecurityError verir — urun kusuru degil, spesifikasyon geregi. Bu yuzden
// burada acikca `http://localhost:3000` kullanilir.

import { test, expect } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { getTokens } from '../helpers/bridge';
import { requestFromOwnAddress } from '../helpers/clientAddress';

const PORT = process.env.E2E_PORT || '3000';
// E2E_HOST belongs to the server BIND address (normally 127.0.0.1). It must
// not choose the WebAuthn page identity: rpId=localhost requires localhost.
const ORIGIN = process.env.E2E_WEBAUTHN_ORIGIN || `http://localhost:${PORT}`;

/** Chromium'a sanal bir platform dogrulayicisi takar. */
async function sanalDogrulayiciTak(page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, id: authenticatorId };
}

test.describe('passkey — sanal dogrulayici ile gercek yasam dongusu', () => {
  test.skip(({ browserName }) => browserName !== 'chromium',
    'Sanal dogrulayici yalnizca Chromium/CDP ile kullanilabilir.');

  test('kayit + giris: gercek WebAuthn ile uctan uca', async ({ page, browser }) => {
    test.setTimeout(120_000);

    // ── Oturumlu sayfa: kayit icin kimlik gerekir ──────────────────────────
    await page.goto(`${ORIGIN}/`);
    const { cdp } = await sanalDogrulayiciTak(page);

    // Kanonik sahip yuklendi mi? (Bu dosyanin var olma sebebi: dugmeler
    // eskiden `BridgeWebAuthn is not defined` firlatiyordu.)
    const sahipVar = await page.evaluate(
      () => typeof (window as unknown as { BridgeWebAuthn?: unknown }).BridgeWebAuthn === 'object');
    expect(sahipVar, 'BridgeWebAuthn kanonik sahibi yuklenmeli').toBe(true);

    const destekli = await page.evaluate(
      () => (window as unknown as { BridgeWebAuthn: { isSupported(): boolean } }).BridgeWebAuthn.isSupported());
    expect(destekli, 'sanal dogrulayici takiliyken WebAuthn destekli olmali').toBe(true);

    // ── P7 B2: ESKI (GERI YUKLENMIS) OTURUM BIR KEZ KANIT ISTER ────────────
    // Bu sayfa oturumu depodan geri yukler; bellekte giris izni (grant) yoktur.
    // Passkey eklemek hesaba kalici bir giris yolu ekler, bu yuzden urun ONCE
    // aciklanabilir tek bir kanit ister. Iptal guvenlidir: hicbir sey saklanmaz.
    // (Kanitin kendisi — parola/TOTP — istemci birim testleri ve iki dugumlu
    // step-up laboratuvarinda gercek sunucuya karsi kanitlanir; burada
    // gonderilmez, cunku IP basina paylasilan 2FA butcesini 2fa.spec bilerek
    // tuketir ve sonuc kosum sirasina bagli olurdu.)
    const kayitliAdet = async (p: Page) => p.evaluate(async () => {
      const jeton = localStorage.getItem('token') || localStorage.getItem('bridge_token');
      const r = await fetch('/api/webauthn/credentials', {
        credentials: 'include',
        headers: jeton ? { Authorization: 'Bearer ' + jeton } : {},
      });
      if (!r.ok) return { durum: r.status, adet: -1, jetonVar: Boolean(jeton) };
      const b = await r.json();
      const list = Array.isArray(b) ? b : (b.credentials ?? []);
      return { durum: r.status, adet: Array.isArray(list) ? list.length : -1, jetonVar: Boolean(jeton) };
    });
    const once = await kayitliAdet(page);
    const iptalBekleyen = page.evaluate(async () => {
      const w = window as unknown as { BridgeWebAuthn: { registerPasskey(n?: string): Promise<boolean> } };
      try { return { ok: await w.BridgeWebAuthn.registerPasskey('E2E Iptal') }; }
      catch (e) { return { ok: false, err: String(e) }; }
    });
    const kanitAlani = page.locator('.bridge-product-dialog-input');
    await expect(kanitAlani, 'a restored session is asked for one proof').toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.bridge-product-dialog-label')).toBeVisible();
    await expect(kanitAlani).toHaveAttribute('type', 'password');
    await page.keyboard.press('Escape');
    await expect(kanitAlani).toBeHidden();
    expect((await iptalBekleyen).ok, 'cancelled proof must not register a passkey').toBe(false);
    expect((await kayitliAdet(page)).adet, 'nothing is stored without a proof').toBe(once.adet);
    await cdp.send('WebAuthn.disable').catch(() => { /* temizlik */ });

    // ── TAZE GIRIS: SURTUNME YOK ─────────────────────────────────────────
    // Ayni kisi urunun giris formundan yeni oturum acar; giris yaniti her kapsam
    // icin bir izin dondurur (yalnizca bellekte). Passkey kaydi SORMADAN gecer.
    const tazeBaglam = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const taze = await tazeBaglam.newPage();
    await taze.goto(`${ORIGIN}/`);
    const { cdp: tazeCdp } = await sanalDogrulayiciTak(taze);
    const alice = getTokens().users.alice;
    await taze.locator('#l-username').fill(alice.username);
    await taze.locator('#l-password').fill(alice.password);
    await taze.locator('#login-form [data-auth-action="login"]').click();
    await expect(taze.locator('#login-form')).toBeHidden({ timeout: 15_000 });

    const kayitSonuc = await taze.evaluate(async () => {
      const w = window as unknown as { BridgeWebAuthn: { registerPasskey(n?: string): Promise<boolean> } };
      try { return { ok: await w.BridgeWebAuthn.registerPasskey('E2E Sanal Anahtar') }; }
      catch (e) { return { ok: false, err: String(e) }; }
    });
    await expect(taze.locator('.bridge-product-dialog-input'), 'a fresh sign-in is not asked again').toHaveCount(0);

    // Sunucu gercekten sakladi mi?
    // NOT: Bridge kimligi BEARER JETONU ile tasir (cerez degil). Ilk yazimda
    // duz `fetch(..., {credentials:'include'})` kullandim ve 401 aldim; test
    // de bunu "oturum yok" sanip kendini ATLADI. Yani kanit uretmeden yesil
    // gorunuyordu. Jeton depodan okunup basliga konur.
    const kimlikler = await kayitliAdet(taze);

    // Kayit kimlik dogrulamasi gerektirir; oturum yoksa bu adim atlanir ama
    // SESSIZCE GECMEZ — durum acikca raporlanir.
    expect(kimlikler.jetonVar, 'storageState oturum jetonu tasimali').toBe(true);
    if (kimlikler.durum === 401) {
      test.info().annotations.push({
        type: 'not',
        description: 'Kayit adimi atlandi: sayfa oturumsuz (401). Giris adimi da atlanir.',
      });
      expect(kimlikler.durum, 'WebAuthn testi kimlikli oturum olmadan çalışamaz').not.toBe(401);
    }

    expect(kayitSonuc.ok, `registerPasskey basarisiz: ${kayitSonuc.err ?? ''}`).toBe(true);
    expect(kimlikler.adet, 'sunucu en az bir passkey saklamali').toBeGreaterThan(0);

    // ── GIRIS ──────────────────────────────────────────────────────────────
    // Ayni sanal dogrulayici ile assertion uretilir; sunucu imzayi dogrular.
    const girisSonuc = await taze.evaluate(async () => {
      const r = await fetch('/api/webauthn/login/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (!r.ok) return { asama: 'begin', durum: r.status };
      const opts = await r.json();
      return { asama: 'begin-ok', durum: 200, meydanVar: typeof opts.challenge === 'string' };
    });
    expect(girisSonuc.meydanVar, 'sunucu giris meydan okumasi vermeli').toBe(true);

    const girisOk = await taze.evaluate(async () => {
      const w = window as unknown as { BridgeWebAuthn: { passkeyLogin(u?: string | null): Promise<boolean> } };
      try { return await w.BridgeWebAuthn.passkeyLogin(null); }
      catch { return false; }
    });
    expect(girisOk, 'sanal dogrulayici ile passkey girisi basarili olmali').toBe(true);

    await tazeCdp.send('WebAuthn.disable').catch(() => { /* temizlik */ });
    await tazeBaglam.close();
  });

  // Page routes do not observe fetches owned by an active Service Worker.
  // Isolate this ONE proof test so Playwright can see the real HTTP exchange
  // and forward it from its own loopback IP. All other passkey tests keep the
  // regular production Service Worker enabled.
  test.describe('Browser-visible isolated proof network', () => {
    test.use({ serviceWorkers: 'block' });

    test('geri yüklenmiş oturumda gerçek parola step-up + WebAuthn kaydı (ayrı IP bütçesi)', async ({ page }) => {
      test.setTimeout(120_000);
      // Gerçek tarayıcı doğrulama arayüzü, gerçek sunucu grant'i ve gerçek WebAuthn
      // kaydı. Yalnızca POST /step-up/password isteğini kendi source loopback
      // adresimizden iletiriz; X-Forwarded-For yok, ürün 2FA limiti 5/5dk sabit.
      const { address, request: isolated } = requestFromOwnAddress();
      const statuses: number[] = [];
      await page.route('**/api/step-up/password', async route => {
        const outgoing = route.request();
        const response = await isolated.post(outgoing.url(), {
          headers: outgoing.headers(),
          data: outgoing.postData() ?? '',
        });
        statuses.push(response.status());
        const headers = { ...response.headers() };
        // HTTP hop-by-hop headers belong to the proxy transport, not the page.
        for (const name of ['connection', 'transfer-encoding', 'content-length', 'keep-alive']) {
          delete headers[name];
        }
        await route.fulfill({ status: response.status(), headers, body: await response.text() });
      });

      await page.goto(`${ORIGIN}/`);
      const { cdp } = await sanalDogrulayiciTak(page);
      const count = () => page.evaluate(async () => {
        const token = localStorage.getItem('token') || localStorage.getItem('bridge_token');
        if (!token) throw new Error('WebAuthn fixture has no bearer token');
        const res = await fetch('/api/webauthn/credentials', {
          headers: { Authorization: 'Bearer ' + token },
        });
        if (!res.ok) throw new Error('WebAuthn credential list status: ' + res.status);
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.credentials ?? []);
        if (!Array.isArray(list)) throw new Error('WebAuthn credentials response is not an array');
        return list.length;
      });

      try {
        const before = await count();
        const registration = page.evaluate(async () => {
          const w = window as unknown as { BridgeWebAuthn: { registerPasskey(n?: string): Promise<boolean> } };
          return w.BridgeWebAuthn.registerPasskey('E2E Stepup Verified');
        });
        const input = page.locator('.bridge-product-dialog-input');
        await expect(input, 'restored session must require a real credential proof').toBeVisible({ timeout: 15_000 });
        await expect(input).toHaveAttribute('type', 'password');
        await input.fill(getTokens().users.alice.password);
        await page.locator('[data-product-dialog-action="confirm"]').click();

        expect(await registration, 'successful isolated password proof should complete registration').toBe(true);
        expect(statuses, 'exactly one real isolated password proof must return 200').toEqual([200]);
        expect(await count(), 'a WebAuthn credential must be saved only after valid step-up').toBe(before + 1);
        // Log the transport identity only, never account credentials or grants.
        console.log('WEBAUTHN_STEPUP_ISOLATED_LOOPBACK source=' + address + ' status=200');
      } finally {
        await cdp.send('WebAuthn.disable').catch(() => undefined);
        await page.unroute('**/api/step-up/password');
      }
    });

  });

  test('dogrulayici YOKKEN giris temiz basarisiz olur (arayuz asili kalmaz)', async ({ page }) => {
    // Sanal dogrulayici TAKILMAZ: tarayici istegi reddeder. Beklenen davranis
    // cokme veya sonsuz bekleme degil, temiz `false` donusudur.
    await page.goto(`${ORIGIN}/`);

    const sonuc = await page.evaluate(async () => {
      const w = window as unknown as { BridgeWebAuthn?: { passkeyLogin(u?: string | null): Promise<boolean> } };
      if (!w.BridgeWebAuthn) return 'sahip-yok';
      const t0 = Date.now();
      try {
        const ok = await w.BridgeWebAuthn.passkeyLogin('yok-boyle-kullanici');
        return { ok, ms: Date.now() - t0 };
      } catch (e) { return { firlatti: String(e) }; }
    });

    expect(sonuc).not.toBe('sahip-yok');
    // Istisna SIZDIRMAMALI: dugme onclick'i yakalanmamis hata uretmemeli.
    expect(sonuc).not.toHaveProperty('firlatti');
    expect((sonuc as { ok: boolean }).ok).toBe(false);
  });
});
