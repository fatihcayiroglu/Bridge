// e2e/global.setup.ts — Sprint 14: TypeScript dönüşümü
// e2e/global.setup.js — Test kullanıcılarını oluştur ve auth state'i kaydet
// Bu dosya tüm testlerden ÖNCE bir kez çalışır.

import { chromium, expect, request as pwRequest } from '@playwright/test';
import { pruneOwnedServers, userIdOf } from './helpers/prune-fixtures';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Test kullanıcıları — RUN BAŞINA BENZERSİZ.
//
// Eskiden sabit ('e2e_alice'/'e2e_bob') idi ve bu, tekrarlanan çalıştırmalarda
// kalıcı durum biriktiriyordu:
//   • kullanıcı başına "en fazla 100 sunucu" ürün sınırına takılma
//     (`Server creation limit reached`) — beforeAll fixture'ları çöküyordu,
//   • başarısız giriş denemelerinin tetiklediği brute-force kilidi (429),
//   • önceki run'lardan kalan sunucu/kanal artıklarının testleri etkilemesi.
// Run başına benzersiz kimlikler her çalıştırmayı yalıtır. Kullanıcı adları
// tokens.json üzerinden okunur; spec'ler sabit isim VARSAYMAMALIDIR.
/**
 * TARAYICI BENZERI BASLIKLAR — bot filtresini ATLAMAK icin degil, DOGRU
 * TEMSIL ETMEK icin.
 *
 * `server/lib/captcha.ts:botFilterMiddleware` istek BASLIKLARINDAN bir bot
 * skoru hesaplar (UA yoksa/kisaysa +40, `accept-language` yoksa +15, …) ve
 * `/api/register` icin 60, `/api/login` icin 70 esigini asani 403 ile reddeder.
 *
 * Node'un `fetch`i bu basliklarin cogunu GONDERMEZ ve tam esik civarinda bir
 * skor uretir; kurulum bu yuzden rastgele basarisiz oluyordu. Bu harness
 * GERCEK KULLANICININ yerine gecer ve kullanici tarayicidan gelir.
 *
 * Sunucu tarafinda HICBIR SEY GEVSETILMEZ: filtre herkes icin etkin kalir,
 * yalnizca test istemcisi kendini dogru tanitir.
 */
const BROWSER_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
};

// ══════════════════════════════════════════════════════════════════════════
// KIMLIKLER YENIDEN KULLANILIR — HER KOSUMDA YENI HESAP ACILMAZ
// ══════════════════════════════════════════════════════════════════════════
// RUN_ID her kosumda RASTGELE uretiliyordu, dolayisiyla her `playwright test`
// cagrisi BES YENI hesap aciyordu. Sunucunun kotuye kullanim korumasi ise
// IP basina saatte `MAX_REG_PER_HOUR` (varsayilan 3) hesapla sinirlidir.
//
// OLCULDU: `/api/register` → 429
//   "Bu IP adresinden son 1 saat icinde cok fazla hesap olusturuldu."
//   retryAfter: 3600
// ardindan global setup login'de 401 alip TUM paketi durduruyordu.
//
// Bu bir URUN kusuru DEGILDIR — koruma dogru calisiyor. Kusur test
// altyapisindaydi. RUN_ID artik diske YAZILIR ve sonraki kosumlar ayni
// kimlikleri LOGIN ile yeniden kullanir; hesap kotasi tuketilmez.
function stableRunId(): string {
  const file = path.join(FIXTURES_DIR, 'run-id.txt');
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing) return existing;
    }
  } catch { /* okunamadi — yenisini uret */ }
  const fresh = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    if (!fs.existsSync(FIXTURES_DIR)) fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    fs.writeFileSync(file, fresh);
  } catch { /* yazilamadi — bu kosum icin gecici kimlik */ }
  return fresh;
}

const RUN_ID = stableRunId();
const TEST_USERS = {
  alice: {
    username: `e2e_alice_${RUN_ID}`,
    email: `alice_${RUN_ID}@bridge-e2e.test`,
    password: 'E2eTestPass123!',
    displayName: 'Alice E2E',
  },
  bob: {
    username: `e2e_bob_${RUN_ID}`,
    email: `bob_${RUN_ID}@bridge-e2e.test`,
    password: 'E2eTestPass456!',
    displayName: 'Bob E2E',
  },
  // carol yalnızca ÜYE OLMAYAN taraf olarak kullanılır: GDM/özel kanal
  // yetkilendirme sınırlarının gerçekten uygulandığını kanıtlamak için
  // hiçbir gruba/sunucuya eklenmeyen üçüncü bir kimlik gerekir.
  carol: {
    username: `e2e_carol_${RUN_ID}`,
    email: `carol_${RUN_ID}@bridge-e2e.test`,
    password: 'E2eTestPass789!',
    displayName: 'Carol E2E',
  },
  // ── MEDYA PAKETINE OZEL KIMLIKLER ────────────────────────────────────────
  // Iki tarayicili ses/ekran testleri KISA SUREDE COK sayida soket olayi
  // uretir. `server/socket/socketRateLimit.ts` KULLANICI BASINA genel bir
  // sinir uygular (`'*': { max: 200, windowMs: 60_000 }`). Medya testleri
  // alice/bob'u paylastiginda toplu kosumda bu butce tukeniyor ve ILGISIZ
  // testler `pending` → `failed` ile dusuyordu.
  //
  // Sinir ZAYIFLATILMAZ — dakikada 200 olay gercek bir kullanicinin
  // ulasamayacagi makul bir kotuye kullanim korumasidir. Dogru cozum medya
  // yukunu AYRI kimliklere tasimaktir.
  //
  // carol KULLANILMAZ: o bilerek "hicbir yere uye olmayan" taraftir ve
  // yetkilendirme sinir testleri buna dayanir.
  media1: {
    username: `e2e_media1_${RUN_ID}`,
    email: `media1_${RUN_ID}@bridge-e2e.test`,
    password: 'E2eTestPass321!',
    displayName: 'Media One E2E',
  },
  media2: {
    username: `e2e_media2_${RUN_ID}`,
    email: `media2_${RUN_ID}@bridge-e2e.test`,
    password: 'E2eTestPass654!',
    displayName: 'Media Two E2E',
  },
};

/**
 * Önbellekteki token hâlâ geçerli mi? `/api/me` ile GERÇEKTEN doğrulanır.
 *
 * ── NEDEN VAR ─────────────────────────────────────────────────────────────
 * Setup her koşuda 5 kullanıcı için register+login deniyordu. Ürünün giriş
 * hız sınırı `RL_LOGIN_MAX` (10/dk) ve `MAX_REG_PER_HOUR` (3) — yani arka
 * arkaya birkaç koşumdan sonra setup KENDİSİ 429 alıp çöküyordu:
 *
 *     Error: Login failed for e2e_media2_...: 429
 *
 * Bu sınırlar DOĞRUDUR ve kötüye kullanım korumasıdır; DEĞİŞTİRİLMEZ.
 * Doğru çözüm, gerçek bir istemcinin yaptığını yapmaktır: geçerli tokenı
 * YENİDEN KULLAN, her açılışta yeniden giriş yapma.
 */
/**
 * Bir tokenin KALAN ömrü (saniye). Çözümlenemezse 0.
 *
 * ── NEDEN GEREKLİ (ÖLÇÜLDÜ) ───────────────────────────────────────────────
 * İlk sürüm yalnızca "`/api/me` 200 mü?" diye soruyordu. Bu YETMEZ: token
 * setup ANINDA geçerli olup koşumun ORTASINDA ölebilir. Gerçekten yaşandı:
 *
 *     iat = 11:12:31Z   exp = 13:12:31Z   (ACCESS_TOKEN_TTL = 2s)
 *     koşum 13:03'te başladı, 8 dk sürdü → token 13:12:31'de öldü
 *     sonuç: 41 test "Invalid or expired token" (401) ile düştü
 *
 * Setup tokeni yeniden kullanmıştı çünkü o an geçerliydi — ama ömrü
 * koşumu TAŞIYACAK kadar değildi. Artık yalnızca yeterli pay varsa
 * yeniden kullanılır.
 */
function tokenRemainingSeconds(token) {
  try {
    const body = token.split('.')[1] ?? '';
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = Number(JSON.parse(json).exp ?? 0);
    return exp ? exp - Math.floor(Date.now() / 1000) : 0;
  } catch {
    return 0;
  }
}

/** Tam bir paket koşumunu rahatça taşıyacak asgari pay. */
const MIN_TOKEN_LIFETIME_S = 45 * 60;

async function reuseValidToken(fetch, token) {
  if (!token) return '';
  // Ömür payı YETERSİZSE yeniden kullanma — koşum ortasında ölmesin.
  const remaining = tokenRemainingSeconds(token);
  if (remaining < MIN_TOKEN_LIFETIME_S) return '';
  try {
    const res = await fetch(`${BASE_URL}/api/me`, {
      headers: { ...BROWSER_HEADERS, Authorization: `Bearer ${token}` },
    });
    return res.ok ? token : '';
  } catch {
    return '';
  }
}

/** Önceki koşumun tokenları — varsa giriş HİÇ yapılmaz. */
function cachedTokens() {
  try {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'tokens.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Tokenın taşıdığı kullanıcı adı (imza DOĞRULANMAZ — yalnızca yönlendirme ipucu). */
function tokenUsername(token) {
  try {
    const body = String(token ?? '').split('.')[1] ?? '';
    return String(JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).username ?? '');
  } catch {
    return '';
  }
}

async function apiRegisterOrLogin(fetch, user, cached) {
  // Geçerli token varsa kimlik uçlarına HİÇ dokunma.
  const reused = await reuseValidToken(fetch, cached);
  if (reused) return reused;

  // ── Final21 Faz 11: HESAP VARSA ÖNCE GİRİŞ (ÖLÇÜLDÜ) ─────────────────────
  // Erişim tokenı 15 dk yaşar, `MIN_TOKEN_LIFETIME_S` 45 dk'dır; yani yukarıdaki
  // yeniden kullanım fiilen HİÇ gerçekleşmez ve her setup, VAR OLAN beş kullanıcı
  // için de önce `/api/register` çağırıyordu (409). Ürünün kayıt sınırı IP başına
  // 5/dk'dır: beşinci 409 bütçeyi bitiriyor, yönetici ve 2FA kayıtları 429 alıyordu.
  // Sonuçlar: (1) 2FA fikstürü HİÇ kurulamadı (kayıt 429 → giriş 401 "Login failed"),
  // (2) her 401 IP'nin başarısız giriş sayacını artırdı (sonraki koşumda 403 captcha),
  // (3) ardışık setup'lar ihlal biriktirdi ve IP 10 dk OTOMATİK BANLANDI
  // ("HTTP rate limit (register) 10x aşıldı"). Ürün sınırları doğrudur ve
  // DEĞİŞTİRİLMEZ; gereksiz kayıt denemesi kaldırılır.
  if (cached && tokenUsername(cached) === user.username) {
    const known = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: BROWSER_HEADERS,
      body: JSON.stringify({ username: user.username, password: user.password }),
    });
    if (known.ok) {
      const data = await known.json();
      if (data.token || data.accessToken) return data.token || data.accessToken;
    }
    // Sınır aşımında kayıt denemek baskıyı yalnızca artırır: nedeni söyle ve dur.
    if (known.status === 429 || known.status === 403) {
      // Gövde de yazılır: hız sınırı (10/dk), giriş kilidi ve IP banı aynı 429'u verir.
      const detail = (await known.text().catch(() => '')).slice(0, 200);
      throw new Error(`Login failed for ${user.username}: ${known.status} (bilinen hesap; kayıt denenmedi) ${detail}`);
    }
  }

  // Önce kayıt dene, zaten varsa login yap
  const regRes = await fetch(`${BASE_URL}/api/register`, {
    method: 'POST',
    headers: BROWSER_HEADERS,
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
    headers: BROWSER_HEADERS,
    body: JSON.stringify({ username: user.username, password: user.password }),
  });

  if (!loginRes.ok) {
    // username yerine email ile dene (eski kayıt)
    const loginRes2 = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: BROWSER_HEADERS,
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    if (!loginRes2.ok) {
      // Kayıt durumu da yazılır: "giriş 401"in asıl nedeni çoğu zaman kaydın 429 almasıdır.
      throw new Error(`Login failed for ${user.username}: ${loginRes.status} (register: ${regRes.status})`);
    }
    const data2 = await loginRes2.json();
    return data2.token || data2.accessToken;
  }

  const data = await loginRes.json();
  // Sprint 9: refreshToken cookie'de, body'de yok
  return data.token || data.accessToken;
}

// ── YONETICI SAGLAMA (v1.123) ────────────────────────────────────────────────
// plugins.spec.ts'in 6 testi "Admin giris yapilamadi (401)" ile ATLANIYORDU:
// ortamda hicbir yonetici KURULMUYORDU. Atlanan sey onemsiz degil — eklenti
// YUKLEME/KALDIRMA ucudur, yani rastgele kod calistiran bir yuzey. Yesil
// sayiyi korumak icin kapali birakilmasi dogru olmazdi.
//
// Yonetici yetkisi yalnizca `users.isAdmin` VERITABANI bayragidir (middleware/
// auth.ts:549 onu DB'den okur; jeton iddiasi BILEREK yetki tasimaz). Bu yuzden
// kullanici normal yoldan kaydedilir, sonra bayrak dogrudan yazilir.
//
// GUVENLIK SINIRI: bu yalnizca TEK KULLANIMLIK e2e/staging veritabaninda
// calisir. `NODE_ENV=production` ise ya da DATABASE_URL yoksa HICBIR SEY
// yapilmaz — uretim verisine dokunmak bu betigin isi degildir.
async function ensureAdminUser(fetch, cachedAdmin): Promise<string | null> {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'AdminPass123!';
  const databaseUrl = process.env.DATABASE_URL;

  if (process.env.NODE_ENV === 'production') {
    console.warn('SKIP yonetici saglama: NODE_ENV=production — uretim veritabanina dokunulmaz.');
    return null;
  }
  if (!databaseUrl) {
    console.warn('SKIP yonetici saglama: DATABASE_URL yok — plugins.spec.ts atlanacak.');
    return null;
  }

  let token: string | null = null;
  try {
    token = await apiRegisterOrLogin(fetch, {
      username,
      email: `${username}@bridge-e2e.test`,
      password,
      displayName: 'E2E Admin',
    }, cachedAdmin);
  } catch (err) {
    console.warn('SKIP yonetici saglama: kayit/giris basarisiz —', String(err));
    return null;
  }
  if (!token) return null;

  // Bayragi yaz. `pg` kok node_modules'ten cozulur.
  try {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const res = await pool.query('UPDATE users SET "isAdmin" = TRUE WHERE username = $1', [username]);
      if (res.rowCount !== 1) {
        console.warn(`Yonetici bayragi yazilamadi (rowCount=${res.rowCount}).`);
        return null;
      }
      console.log(`Yonetici saglandi: ${username} (isAdmin=true)`);
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.warn('SKIP yonetici saglama: DB guncellemesi basarisiz —', String(err));
    return null;
  }

  return token;
}

// ── 2FA FIKSTURU (v1.123) ────────────────────────────────────────────────────
// `2fa.spec.ts:115` "2FA kullanici credential eksik" diyerek ATLANIYORDU:
// ortamda 2FA kayitli hicbir kullanici YOKTU, dolayisiyla "2FA acik bir
// kullanicinin girisi DOGRUDAN jeton DONDURMEMELI" iddiasi hic dogrulanmadi.
// Bu, kimlik dogrulamanin en kritik dallarindan biridir; atlanmasi ucuz ama
// pahaliya mal olabilecek bir bosluktu.
//
// TOTP kodu URUNUN kendi algoritmasiyla uretilir (routes/twoFactor.ts):
// base32 secret + HMAC-SHA1 + 30 sn adim + 6 hane. Yeni bagimlilik EKLENMEZ.
function base32Decode(str: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function totpCode(secret: string): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  let c = BigInt(Math.floor(Date.now() / 1000 / 30));
  for (let i = 7; i >= 0; i--) { buf[i] = Number(c & 0xffn); c >>= 8n; }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16)
             | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * 2FA acik bir kullanici saglar. Basarisiz olursa `null` doner ve ilgili test
 * DURUSTCE atlanir — sahte bir gecis uretmez.
 */
async function ensureTwoFactorUser(fetch, cachedTwoFactor): Promise<{ username: string; password: string } | null> {
  const username = `e2e_2fa_${RUN_ID}`;
  const password = 'E2eTwoFactor123!';
  try {
    // Final21 Faz 11: hesabın var olduğu BİLİNMİYORSA önce KAYIT denenir.
    // Eskiden önce giriş "yoklanıyordu"; hesap yoksa bu her setup'ta bir
    // BAŞARISIZ GİRİŞ (401) kaydediyordu ve IP'nin captcha sayacını besliyordu.
    let token = '';
    if (cachedTwoFactor?.username !== username) {
      const reg = await fetch(`${BASE_URL}/api/register`, {
        method: 'POST', headers: BROWSER_HEADERS,
        body: JSON.stringify({ username, email: `${username}@bridge-e2e.test`, password, displayName: '2FA E2E' }),
      });
      if (reg.ok) {
        const data = await reg.json().catch(() => ({}));
        token = (data as { token?: string; accessToken?: string }).token
          ?? (data as { accessToken?: string }).accessToken ?? '';
      } else if (reg.status !== 409) {
        throw new Error(`2FA fikstur kaydi basarisiz: HTTP ${reg.status}`);
      }
    }

    if (!token) {
      // Hesap VAR. 2FA aciksa duz giris 202 + {requiresTwoFactor:true} doner ve
      // JETON VERMEZ — bu, kaydin tamamlandiginin KANITIDIR. (Ilk surumde bu durum
      // "jeton yok" diye basarisizlik sayiliyordu ve fikstur ikinci kosumda kayboluyordu.)
      const probe = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST', headers: BROWSER_HEADERS,
        body: JSON.stringify({ username, password }),
      });
      const body = await probe.json().catch(() => ({}));
      if (probe.status === 202 && (body as { requiresTwoFactor?: boolean }).requiresTwoFactor) {
        return { username, password };
      }
      token = (body as { token?: string; accessToken?: string }).token
        ?? (body as { accessToken?: string }).accessToken ?? '';
      if (!probe.ok || !token) throw new Error(`2FA fikstur girisi basarisiz: HTTP ${probe.status}`);
    }

    const auth = { ...BROWSER_HEADERS, Authorization: `Bearer ${token}` };

    // OLCULDU: /api/2fa/setup CSRF ister; jetonsuz POST 403 "CSRF token
    // missing" doner ve kayit sessizce basarisiz olurdu.
    const csrfRes = await fetch(`${BASE_URL}/api/csrf-token`, { headers: auth });
    const csrfBody = csrfRes.ok ? await csrfRes.json().catch(() => ({})) : {};
    const csrf = (csrfBody as { token?: string; csrfToken?: string }).token
      ?? (csrfBody as { csrfToken?: string }).csrfToken;
    const cookies = (csrfRes.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie?.().map(c => c.split(';')[0]).join('; ') ?? '';
    const writeHeaders = {
      ...auth,
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
    };

    // Zaten acik mi? (tekrarli kosumlarda kayit yeniden yapilmaz)
    const status = await fetch(`${BASE_URL}/api/2fa/status`, { headers: auth });
    if (status.ok) {
      const body = await status.json().catch(() => ({}));
      if (body?.enabled) return { username, password };
    }

    const setup = await fetch(`${BASE_URL}/api/2fa/setup`, { method: 'POST', headers: writeHeaders, body: '{}' });
    if (!setup.ok) return null;
    const { secret } = await setup.json() as { secret?: string };
    if (!secret) return null;

    const verify = await fetch(`${BASE_URL}/api/2fa/verify`, {
      method: 'POST', headers: writeHeaders, body: JSON.stringify({ code: totpCode(secret) }),
    });
    if (!verify.ok) return null;

    console.log(`2FA fiksturu hazir: ${username}`);
    return { username, password };
  } catch (err) {
    console.warn('SKIP 2FA fiksturu:', String(err));
    return null;
  }
}

async function setup() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  console.log('\n🔧 E2E Setup: Test kullanıcıları hazırlanıyor...');

  const cache = cachedTokens();

  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Node fetch (Node 18+)
  const nodeFetch = globalThis.fetch;

  // Alice token al
  const aliceToken = await apiRegisterOrLogin(nodeFetch, TEST_USERS.alice, cache.alice);
  console.log('✅ Alice hazır');

  // Bob token al
  const bobToken = await apiRegisterOrLogin(nodeFetch, TEST_USERS.bob, cache.bob);
  console.log('✅ Bob hazır');

  const carolToken = await apiRegisterOrLogin(nodeFetch, TEST_USERS.carol, cache.carol);
  console.log('✅ Carol hazır');

  const media1Token = await apiRegisterOrLogin(nodeFetch, TEST_USERS.media1, cache.media1);
  const media2Token = await apiRegisterOrLogin(nodeFetch, TEST_USERS.media2, cache.media2);
  const adminToken = await ensureAdminUser(nodeFetch, cache.admin);
  const twoFactor = await ensureTwoFactorUser(nodeFetch, cache.twoFactor);
  if (twoFactor) {
    process.env.BRIDGE_E2E_2FA_USER = twoFactor.username;
    process.env.BRIDGE_E2E_2FA_PASS = twoFactor.password;
  }
  console.log('✅ Medya kullanıcıları hazır');

  // ══════════════════════════════════════════════════════════════════════════
  // FIKSTUR BUDAMA — URUN SINIRINA CARPMAYI ONLER
  // ══════════════════════════════════════════════════════════════════════════
  // Cok sayida spec `beforeAll` icinde sunucu olusturur ve hicbiri silmez.
  // Bridge kullanici basina `MAX_SERVERS_PER_USER` (varsayilan 100) sunucuya
  // izin verir. OLCULDU: alice tam 100'e ulasti; `POST /api/servers` 400
  // "Server creation limit reached" dondu, `createTestServer` null verdi ve
  // bagimli TUM testler bos sunucu kimligiyle dustu — IZOLE kosumda bile.
  //
  // Urun siniri DOGRUDUR ve degistirilmez. Biriken TEST fikstur'u budanir.
  const pruneCtx = await pwRequest.newContext();
  try {
    for (const [name, token] of [
      ['alice', aliceToken], ['bob', bobToken],
      ['media1', media1Token], ['media2', media2Token],
    ] as const) {
      const r = await pruneOwnedServers(pruneCtx, token, userIdOf(token), 5);
      if (r.before > 20) {
        console.log(`🧹 ${name}: ${r.before} sunucu → ${r.after} (silinen: ${r.deleted})`);
      }
    }
  } catch (err) {
    console.warn('⚠️  Fikstur budama atlandi:', (err as Error).message);
  } finally {
    await pruneCtx.dispose();
  }

  // Auth state'i localStorage'a kaydet (Playwright'ın storageState formatı)
  // Alice'in auth state'ini kaydet (ana test kullanıcısı)
  const authStatePath = path.join(FIXTURES_DIR, 'auth-state.json');
  await context.addCookies([]);

  // Token'ları fixture dosyasına da kaydet (API testleri için)
  const tokensPath = path.join(FIXTURES_DIR, 'tokens.json');
  fs.writeFileSync(
    tokensPath,
    JSON.stringify({
      alice: aliceToken, bob: bobToken, carol: carolToken,
      media1: media1Token, media2: media2Token, users: TEST_USERS,
      // null olabilir: yonetici saglanamadiysa plugins.spec.ts atlar.
      admin: adminToken,
      // 2FA fikstur kimligi; yoksa 2fa.spec.ts ilgili testi atlar.
      twoFactor,
    }, null, 2)
  );

  // Alice ile giriş yapıp storageState kaydet
  const page = await context.newPage();
  await page.goto(BASE_URL);

  // ── FİKSTÜR KULLANICISI İLK KEZ GİRMİYOR (Final21 Faz 19, 19-25) ─────────
  // Tanıtım turu (OnboardingWizard) kullanıcı-kapsamlı `bridge_onboarding_v3:<userId>`
  // anahtarı yoksa, girişten 1.6 sn sonra kullanıcı fareye/klavyeye dokunmadıysa açılır.
  // Paylaşılan oturum durumunda anahtar YOKTU: 1.6 sn'den uzun bekleyen HER UI testi turu
  // arayüzün üstünde buluyordu (ölçüldü: upload/typing-convergence tıklamaları düştü).
  // İlk giriş davranışı `onboarding-wizard.spec.ts`te anahtarları KENDİSİ silerek ölçülür.
  const aliceUserId = (() => {
    try { return String(JSON.parse(Buffer.from(aliceToken.split('.')[1], 'base64url').toString('utf8')).id || ''); }
    catch { return ''; }
  })();
  if (!aliceUserId) throw new Error('alice jetonundan kullanıcı kimliği okunamadı (tur anahtarı yazılamaz)');

  // Token'ı localStorage'a inject et
  await page.evaluate(([token, uid]) => {
    localStorage.setItem('token', token);
    localStorage.setItem('bridge_token', token);
    localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
  }, [aliceToken, aliceUserId] as const);

  // ══════════════════════════════════════════════════════════════════════════
  // YENILEME COOKIE'SI YAKALANIR — YOKSA UZUN KOSUMLAR COKUYOR
  // ══════════════════════════════════════════════════════════════════════════
  // Buraya kadar yalnizca `localStorage`a token enjekte ediliyordu; tarayici
  // baglaminda GERCEK bir giris yapilmadigi icin httpOnly `refresh` cookie'si
  // HIC olusmuyordu.
  //
  // Erisim token'i 15 dakika yasar (`ACCESS_TOKEN_TTL`). Tam E2E kosumu 17+
  // dakika suruyor. Cookie olmadan `api-fetch` yenileme yapamaz; token
  // suresi dolan her test giris ekranina dusuyor ve `#app` GIZLI kaliyor.
  //
  // OLCULDU: `auth-state.json` icinde cookie sayisi 0 ve kayitli token
  // `exp` degeri -218 saniye (yani zaten SURESI DOLMUS) olarak bulundu;
  // tam kosumda 59 test tam olarak "#app gorunur olmadi" ile dustu.
  //
  // Bu bir URUN kusuru DEGILDIR — yenileme akisi urunde vardir; test
  // fikstur'u onu tasimayi atliyordu.
  const loginForCookie = await context.request.post(`${BASE_URL}/api/login`, {
    headers: BROWSER_HEADERS,
    data: { username: TEST_USERS.alice.username, password: TEST_USERS.alice.password },
  });
  if (!loginForCookie.ok()) {
    console.warn('⚠️  Yenileme cookie alinamadi (HTTP ' + loginForCookie.status()
      + ') — uzun kosumlarda token suresi dolabilir.');
  }

  // Sayfayı yenile ve giriş teyit et
  await page.reload();
  await page.waitForTimeout(1000);

  // ══════════════════════════════════════════════════════════════════════════
  // AYNI SUNUCU, IKI KAYNAK GOSTERIMI — OTURUM HER IKISINDE DE OLMALI
  // ══════════════════════════════════════════════════════════════════════════
  // `localStorage` KAYNAK (origin) basinadir. Fikstur oturumu `BASE_URL`
  // (127.0.0.1) altinda yaziliyor; ama bazi paketler ayni sunucuya
  // `http://localhost:3000` uzerinden BAGLANMAK ZORUNDADIR:
  //
  //   · `webauthn-virtual.spec.ts` — WebAuthn, rpId'nin sayfa origin'inin
  //     kayitli alan adi soneki olmasini SART kosar. Sunucunun RP_ID
  //     varsayilani `localhost` oldugundan sayfa 127.0.0.1'den acilamaz.
  //   · `security-tab-live.spec.ts` — ayni ORIGIN sabitini paylasir.
  //
  // Bu paketler 127.0.0.1 icin yazilmis oturumu GOREMIYOR, giris ekraninda
  // kaliyor ve "jeton yok" / "ayarlar dugmesi gorunmuyor" diye dusuyordu.
  // Sebep urun degil, FIKSTURUN kaynak kapsamiydi.
  //
  // Cozum, ZATEN VERILMIS ayni oturumu ikinci gosterim altinda da yazmaktir.
  // Yeni bir yetki uretilmez; `scripts/e2e-server.js` her iki kaynagi da
  // ACIKCA `ALLOWED_ORIGINS` icinde sayar.
  const alternateOrigin = BASE_URL.includes('127.0.0.1')
    ? BASE_URL.replace('127.0.0.1', 'localhost')
    : BASE_URL.replace('localhost', '127.0.0.1');
  if (alternateOrigin !== BASE_URL) {
    try {
      // Yenileme cookie'si de ALAN ADI basinadir; `localhost` ve `127.0.0.1`
      // AYRI konaklardir. Once gercek bir giris yapilir (cookie olusur).
      const altLogin = await context.request.post(`${alternateOrigin}/api/login`, {
        headers: BROWSER_HEADERS,
        data: { username: TEST_USERS.alice.username, password: TEST_USERS.alice.password },
      });
      if (!altLogin.ok()) {
        console.warn('⚠️  Alternatif kaynak girisi basarisiz (HTTP ' + altLogin.status() + ')');
      }

      // ── UYGULAMA SAYFASI ACILMAZ ────────────────────────────────────────
      // `localStorage` yazmak icin o kaynakta bir belge gerekir, ama UYGULAMA
      // belgesi acilirsa uygulama kendi acilis akisini kosar: jeton yokken
      // "oturum yok" yoluna girer ve o yolun sonunda yazdigimiz degeri
      // TEMIZLER.
      //
      // Olculdu: yazma sonrasi dogrulama GECIYOR, ama `storageState()` cagrisi
      // ile arada gecen surede `token` siliniyordu — kaydedilen dosyada
      // `localhost` kaynagi yalnizca `bridge:refresh:result` tasiyordu.
      //
      // Cozum, ayni kaynakta UYGULAMA OLMAYAN bir belge acmaktir. `/api/health`
      // ayni origin'dedir, JSON dondurur ve hicbir uygulama betigi calistirmaz.
      await page.goto(`${alternateOrigin}/api/health`);
      await page.evaluate(([token, uid]) => {
        localStorage.setItem('token', token);
        localStorage.setItem('bridge_token', token);
        localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
      }, [aliceToken, aliceUserId] as const);

      const altToken = await page.evaluate(() => localStorage.getItem('token'));
      if (!altToken) {
        console.warn('⚠️  Alternatif kaynakta oturum jetonu tutunamadi.');
      }
    } catch (err) {
      console.warn('⚠️  Alternatif kaynak oturumu yazilamadi:', String(err));
    }
  }

  // storageState kaydet
  await context.storageState({ path: authStatePath });
  // onboarding-wizard.spec.ts `fixtures/alice-state.json` bekliyor; aynı
  // alice oturumudur, ayrı bir isimle de yazılır (eksikliği tüm suite'i düşürüyordu).
  await context.storageState({ path: path.join(FIXTURES_DIR, 'alice-state.json') });
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
