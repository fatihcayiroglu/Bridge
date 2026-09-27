// client/tests/auth-screen-dead-controls.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GIRIS EKRANINDAKI DENETIMLER GERCEKTEN CALISMALI
// ════════════════════════════════════════════════════════════════════════════
// BULGU (kapsam defterinden cikti): `index.html` giris ekraninda IKI gorunur
// passkey dugmesi var —
//
//     data-auth-action="passkey-login"
//     data-auth-action="passkey-register"
//
// Bu global'i `js/webauthn.ts` tanimlar (satir 489, yorumu da tam olarak bu
// iki dugmeyi isaret eder). ANCAK o dosya HICBIR giris noktasindan import
// edilmiyor; yani uretim paketine hic girmiyor.
//
// Sonuc: kullanici "Passkey ile giris yap" dugmesine basiyor ve HICBIR SEY
// olmuyor — yalnizca konsola `ReferenceError: BridgeWebAuthn is not defined`
// dusuyor. Sunucu tarafi WebAuthn'i TAM destekliyor (6 rota, mount edilmis,
// testli), dolayisiyla bu bir baglama boslugu.
//
// ── NEDEN GIRIS EKRANI OZEL ─────────────────────────────────────────────────
// `dead-control-guard` bu sinifi zaten ele aliyordu, ama yalnizca
// `bridge:socket-ready` ve `bridge:auth-success` ile — ikisi de KIMLIK
// DOGRULAMADAN SONRA. Giris ekranindaki denetimler tam olarak ondan ONCE
// kullanilir, yani hic korunmuyorlardi.
//
// ── BU TEST NEDEN "YA / YA DA" KURULU ───────────────────────────────────────
// Iddia bir AYRIM olarak yazildi: modul PAKETTEYSE dugme gercekten calisir ve
// test gecer; PAKETTE DEGILSE dugme koruma kapsaminda olmali. Boylece ozellik
// ileride dogru sekilde baglandiginda test KIRMIZI OLMAZ — yalnizca "ne
// calisiyor ne de korunuyor" durumunda duser. Urunu duzeltince bozulan bir
// test, duzeltmeyi cezalandirirdi.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLIENT = path.resolve(__dirname, '..');

// ── Uretim giris noktasindan ulasilabilir dosya kumesi ──────────────────────
const UZANTILAR = ['', '.ts', '.svelte', '.js', '/index.ts', '/index.js'];

function coz(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const temel = path.resolve(path.dirname(fromFile), spec);
  const adaylar = [temel, temel.replace(/\.js$/, '.ts'), temel.replace(/\.js$/, '.svelte')];
  for (const a of adaylar) {
    for (const u of UZANTILAR) {
      try { if (fs.statSync(a + u).isFile()) return a + u; } catch { /* yok */ }
    }
  }
  return null;
}

/**
 * ── PAYLASILAN TARAYICI ────────────────────────────────────────────────────
 * Burada eskiden AYRI bir import tarayicisi vardi ve deseni `\s*` kullaniyordu.
 * `\s*` satir sonlarini gecer; bu depodaki Turkce yorumlar kesme isareti (')
 * icerdigi icin bir yorumdaki "from" kelimesi asagidaki bir kesme isaretiyle
 * eslesip ARADAKI GERCEK import'u yutuyordu.
 *
 * Sonuc: ulasilabilirlik OLDUGUNDAN DAR olcuyordu. Bu dosyadaki
 *     expect(ULASILABILIR.has(ESKI)).toBe(false)
 * iddiasi -- "eski webauthn modulu PAKETLENMIYOR" -- bu yuzden YANLIS NEDENLE
 * de gecebilirdi: tarayici zaten hicbir seyi bulamiyor olabilirdi.
 *
 * Artik kanonik tarayici paylasilir (yorumlari cikarir, satir atlamaz), yani
 * iddia gercekten olculur.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reachableSet } = require('../scripts/production-reachable-coverage.js');

function ulasilabilirKume(_giris: string): Set<string> {
  return reachableSet();
}

const KABUK = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
const ULASILABILIR = ulasilabilirKume('js/app.ts');
// KANONIK sahip: `js/core/webauthn-svelte.ts`. Eski `js/webauthn.ts` bilincli
// olarak baglanmadi (mojibake, tanimsiz showToast, ikinci dugme enjeksiyonu).
const KANONIK = path.join(CLIENT, 'js', 'core', 'webauthn-svelte.ts');
const ESKI    = path.join(CLIENT, 'js', 'webauthn.ts');
const webauthnPaketde = ULASILABILIR.has(KANONIK);

/** `#auth-screen` blogunu kaba ama yeterli sekilde ayirir. */
function authEkraniHtml(): string {
  const bas = KABUK.indexOf('id="auth-screen"');
  if (bas < 0) return '';
  // Uygulama kabugunun basladigi yere kadar al.
  const son = KABUK.indexOf('id="app"', bas);
  return KABUK.slice(bas, son > 0 ? son : bas + 20000);
}

describe('giris ekrani — passkey denetimleri', () => {
  it('passkey dugmeleri GERCEKTEN kabukta var (bulgunun on kosulu)', () => {
    // Bu iddia dusarse asagidaki testler anlamsizlasirdi; once varligi tespit
    // edilir ki sessizce "hicbir sey test etmeyen" bir dosya olmasin.
    expect(KABUK).toContain('data-auth-action="passkey-login"');
    expect(KABUK).toContain('data-auth-action="passkey-register"');
  });

  it('passkey dugmeleri GIRIS EKRANI blogunda yer alir', () => {
    // Korumanin kapsami `#auth-screen` ile sinirli oldugu icin konum onemli.
    const auth = authEkraniHtml();
    expect(auth).toContain('data-auth-action="passkey-login"');
    expect(auth).toContain('data-auth-action="passkey-register"');
  });

  it('YA modul pakette OLMALI YA DA denetimler koruma kapsaminda', () => {
    // Kotu durum: ne calisir ne korunur -> kullanici sessiz basarisizlik yasar.
    const korumaAuthEkraniniTariyor =
      fs.readFileSync(path.join(CLIENT, 'js/core/dead-control-guard.ts'), 'utf8')
        .includes("getElementById('auth-screen')");

    expect(webauthnPaketde || korumaAuthEkraniniTariyor).toBe(true);
  });

  it('ARTIK GERCEKTEN BAGLI: kanonik sahip uretim paketinde', () => {
    // Koruma yalnizca GECICI bir guvenlik durumuydu. Istenen son durum
    // ozelligin calismasidir.
    expect(webauthnPaketde).toBe(true);
  });

  it('ESKI modul baglanmadi (ikinci sahip yok)', () => {
    // Iki sahip olsaydi iki `BridgeWebAuthn` kaydi ve iki dugme davranisi
    // olurdu; eski dosya ayrica mojibake ve tanimsiz `showToast` iceriyor.
    expect(ULASILABILIR.has(ESKI)).toBe(false);
  });

  it('kanonik sahip DUGME ENJEKTE ETMEZ', () => {
    // Eski modulun enjeksiyon fonksiyonu, kabukta zaten sabit iki dugme
    // varken UCUNCU bir dugme ekliyordu.
    //
    // ONEMLI: iddia YORUMLARI DEGIL KODU olcer. Ilk yazimda ham kaynakta
    // arama yapiyordu ve kanonik dosyanin "eski yaklasim neden reddedildi"
    // aciklamasi testi dusurdu — yani prosa, davranis gibi olculuyordu.
    const kod = fs.readFileSync(KANONIK, 'utf8')
      .split('\n')
      .filter(l => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      })
      .join('\n');
    expect(kod).not.toMatch(/createElement\(\s*['"]button['"]\s*\)/);
    expect(kod).not.toContain('injectPasskeyLoginButton');
    expect(kod).not.toContain('appendChild');
  });

  it('kanonik sahip KANONIK oturum yolunu kullanir', () => {
    // Ikinci bir auth mimarisi olmamali: oturum `auth-compat.startApp` ile
    // kurulur, parola girisiyle ayni yol.
    const src = fs.readFileSync(KANONIK, 'utf8');
    expect(src).toContain("from './auth-compat.ts'");
    expect(src).toContain('startApp(');
  });

  it('koruma modulu URETIM paketindedir', () => {
    // Koruma yalnizca kendisi yukleniyorsa ise yarar.
    expect(ULASILABILIR.has(path.join(CLIENT, 'js', 'core', 'dead-control-guard.ts'))).toBe(true);
  });
});

describe('giris ekrani — CALISAN denetimler bozulmamali', () => {
  // Yanlis pozitif kontrolu: koruma, giris ekranindaki GERCEK dugmeleri
  // etkisizlestirirse oturum acmayi tamamen kirar. Bu global'ler
  // `auth-compat.ts` tarafindan modul degerlendirmesinde atanir.
  // `completeTwoFactorLogin` / `cancelTwoFactorLogin` 2FA adimi eklendiginde
  // kabuga girdi ama bu listeye ALINMAMISTI. Yani iki GORUNUR dugme, "uretim
  // modulunde tanimli mi" iddiasinin DISINDA kaldi. Liste genisletiliyor:
  // asagidaki dongu her ad icin ayri bir kanit uretir.
  const canliGloballer = [
    'login', 'register', 'switchAuthTab',
    'completeTwoFactorLogin', 'cancelTwoFactorLogin',
  ];

  it('auth-compat URETIM paketindedir', () => {
    expect(ULASILABILIR.has(path.join(CLIENT, 'js', 'core', 'auth-compat.ts'))).toBe(true);
  });

  for (const ad of canliGloballer) {
    it(`\`${ad}\` uretim paketindeki bir modul tarafindan TANIMLANIR`, () => {
      const kaynak = fs.readFileSync(path.join(CLIENT, 'js/core/auth-compat.ts'), 'utf8');
      // `Object.assign(globalThis, { switchAuthTab, login, register, ... })`
      expect(kaynak).toMatch(new RegExp(`\\b${ad}\\b`));
    });
  }

  it('giris ekraninda SATIR ICI onclick kalmadi', () => {
    // Kabuk `onclick="..."` satir ici isleyicilerinden `data-auth-action`
    // delegasyonuna TASINDI (CSP icin de dogrusu budur). Bu testin eski
    // hali hala satir ici kokleri sayiyor ve bos kume gordugu icin
    // kiriliyordu; oysa olculmesi gereken sey artik satir ici handler
    // KALMAMASIDIR.
    expect(authEkraniHtml()).not.toMatch(/\bonclick=/);
  });

  it('giris ekranindaki data-auth-action kumesi beklenen kumedir', () => {
    // Ayni koruma, yeni bicimde: kabuktaki HER eylem adi burada listelenir.
    // Yeni bir dugme eklenirse test duser ve o eylemin GERCEKTEN ele
    // alindigini kanitlamak zorunlu olur (asagidaki dispatcher denetimi).
    const eylemler = new Set(
      [...authEkraniHtml().matchAll(/data-auth-action="([^"]+)"/g)].map(m => m[1]),
    );
    expect([...eylemler].sort()).toEqual([
      'cancel-2fa',
      'complete-2fa',
      // Final21 UX (U-01): hesap kurtarma — "Şifremi unuttum", istek, yeni şifre, geri.
      'forgot',
      'forgot-send',
      'login',
      'passkey-login',
      'passkey-register',
      'recovery-back',
      'register',
      'reset-save',
    ]);
  });

  it('kabuktaki her data-auth-action dispatcher tarafindan ELE ALINIR', () => {
    // "Olu denetim" tam olarak budur: ekranda duran ama hicbir sey yapmayan
    // bir dugme. Eylem adlarini dispatcher'in `case` etiketleriyle esleriz.
    const kaynak = fs.readFileSync(path.join(CLIENT, 'js/core/auth-compat.ts'), 'utf8');
    const eylemler = [...new Set(
      [...authEkraniHtml().matchAll(/data-auth-action="([^"]+)"/g)].map(m => m[1]),
    )];
    const elealinmayan = eylemler.filter(ad => !kaynak.includes(`case '${ad}':`));
    expect(elealinmayan).toEqual([]);
  });
});

describe('bulgunun kaydi', () => {
  it('passkey ozelligi BAGLI, eski kopya degil (durum kaydi)', () => {
    // Bu test bir IDDIA degil, olculen durumun kaydidir. Ozellik dogru
    // sekilde baglandiginda burasi guncellenmelidir; o zamana kadar
    // "sunucu destekliyor ama istemci baglamiyor" boslugu gorunur kalir.
    // Durum kaydi: kanonik sahip bagli, eski kopya degil.
    expect({ kanonik: webauthnPaketde, eski: ULASILABILIR.has(ESKI) })
      .toEqual({ kanonik: true, eski: false });
  });
});


// ════════════════════════════════════════════════════════════════════════════
// CALISMA ZAMANI — koruma giris ekraninda DOGRU olani yapiyor mu?
// ════════════════════════════════════════════════════════════════════════════
// Yukaridaki testler STATIK sozlesmeyi tutar. Bu blok davranisi olcer:
// olu passkey dugmesi etkisizlestirilmeli, GERCEK giris dugmesine
// DOKUNULMAMALI. Ikincisi kritik — koruma `login()`u etkisizlestirseydi
// oturum acmayi tamamen kirardi.
describe('calisma zamani — giris ekrani taramasi', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="auth-screen" class="auth-screen">
        <button id="giris" onclick="login()">Giris yap</button>
        <button id="passkey" onclick="BridgeWebAuthn.passkeyLogin()">Passkey ile giris</button>
      </div>`;
    (globalThis as Record<string, unknown>).login = () => {};
    delete (globalThis as Record<string, unknown>).BridgeWebAuthn;
  });

  it('OLU passkey dugmesi etkisizlestirilir', async () => {
    const { guardDeadControls } = await import('../js/core/dead-control-guard.ts');
    const kok = document.getElementById('auth-screen') as HTMLElement;
    expect(guardDeadControls(kok)).toBe(1);
    const p = document.getElementById('passkey') as HTMLElement;
    expect({ onclick: p.getAttribute('onclick'), aria: p.getAttribute('aria-disabled') })
      .toEqual({ onclick: null, aria: 'true' });
  });

  it('GERCEK giris dugmesine DOKUNULMAZ', async () => {
    const { guardDeadControls } = await import('../js/core/dead-control-guard.ts');
    guardDeadControls(document.getElementById('auth-screen') as HTMLElement);
    const g = document.getElementById('giris') as HTMLElement;
    expect(g.getAttribute('onclick')).toBe('login()');
    expect(g.dataset.deadControl).toBeUndefined();
  });

  it('BridgeWebAuthn tanimliysa passkey dugmesi de KORUNMAZ', async () => {
    // Ozellik ileride dogru baglandiginda koruma kendiliginden devre disi
    // kalmali; aksi halde calisan bir dugmeyi oldururdu.
    (globalThis as Record<string, unknown>).BridgeWebAuthn = { passkeyLogin: () => {} };
    const { guardDeadControls } = await import('../js/core/dead-control-guard.ts');
    expect(guardDeadControls(document.getElementById('auth-screen') as HTMLElement)).toBe(0);
    delete (globalThis as Record<string, unknown>).BridgeWebAuthn;
  });
});
