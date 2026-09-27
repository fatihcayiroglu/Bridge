// client/vitest.setup.ts
import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Client testlerinin tek canonical koşucusu Vitest'tir.
// Jest compatibility global'i tutulmaz; testler doğrudan `vi.*` kullanır.

// ── Tarayıcı API'leri ────────────────────────────────────────────────────────
// jsdom bazı medya API'lerini implemente etmiyor; voice/recorder testleri bunları
// yalnızca varlık/temizlik kontrolü için kullanıyor (davranış bypass edilmiyor).
if (typeof (globalThis as { MediaStream?: unknown }).MediaStream === 'undefined') {
  class MediaStreamStub {
    private _tracks: Array<{ stop: () => void; kind: string; readyState: string }>;
    constructor(tracks: Array<{ stop: () => void; kind: string; readyState: string }> = []) {
      this._tracks = tracks;
    }
    getTracks() { return this._tracks; }
    getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
    addTrack(t: { stop: () => void; kind: string; readyState: string }) { this._tracks.push(t); }
    removeTrack(t: unknown) { this._tracks = this._tracks.filter(x => x !== t); }
  }
  (globalThis as { MediaStream?: unknown }).MediaStream = MediaStreamStub;
}

// ── DIL: TESTLER ICIN BELIRLENIMCI ────────────────────────────────────────
// FAZ 4 i18n gocunden sonra ortaya cikti: `i18n/index.ts` dili
// `navigator.language`den tespit eder ve jsdom varsayilani `en-US`tir.
// Yani bilesen testleri sessizce INGILIZCE calisiyordu.
//
// Sabit kodlu Turkce metinler varken bu gorunmezdi — metin dilden bagimsiz
// olarak Turkce geliyordu. Metinler ceviriye tasinir tasinmaz ayni testler
// Ingilizce ciktiyla karsilasti.
//
// Testler bir DIL testi degil, DAVRANIS testidir; bu yuzden dil burada
// urunun birincil diline SABITLENIR. Dili gercekten sinayan testler
// (`i18n-reactivity`) kendi icinde `setLocale` cagirarak bunu ezer.
try { window.localStorage.setItem('bridge_locale', 'tr'); } catch { /* jsdom yoksa */ }

// Dil tespiti `localStorage('bridge_locale')` YOKSA `navigator.language`e duser
// (i18n/index.ts:82-84) ve jsdom varsayilani `en-US`tir. Kendi `beforeEach`inde
// `localStorage.clear()` cagiran her test dosyasi -- ki cogu cagirir -- boylece
// sessizce INGILIZCEYE dusuyordu; Turkce metin bekleyen iddialar bu yuzden
// kirmiziydi. Tarayici dilini de sabitlemek, depolama temizlense bile urunun
// birincil dilini korur.
try {
  Object.defineProperty(window.navigator, 'language', { value: 'tr-TR', configurable: true });
  Object.defineProperty(window.navigator, 'languages', { value: ['tr-TR', 'tr'], configurable: true });
} catch { /* jsdom disinda */ }

// ── AG ERISIMI: TESTLERDE YOK ─────────────────────────────────────────────
// jsdom CALISAN bir `fetch` sunar. Bu yuzden `apiFetch`i mock'lamayan her
// bilesen/modul, mount aninda GERCEKTEN `http://localhost:3000` adresine
// baglanmaya calisiyordu (ornegin `webrtc.ts` icindeki modul seviyesi
// `iceConfigReady` IIFE'si). Kapali bir portu hizla reddeden bir makinede bu
// gorunmezdi; reddi yavas olan bir makinede ayni testler saniyeler suruyor ve
// deterministik iddialar SIRA BAGIMLI kirilganliga donusuyordu.
//
// Kanonik kural: bir test agi kullanmaz. Varsayilan `fetch` baglanti reddini
// ANINDA taklit eder; gercek bir yanit isteyen testler kendi mock'unu kurar.
const rejectNetwork = (): Promise<Response> => Promise.reject(
  Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED (test ortaminda ag erisimi yok)') }),
);
globalThis.fetch = vi.fn(rejectNetwork) as unknown as typeof globalThis.fetch;

// ── DIL TABLOSU HAZIR OLMADAN TEST BASLAMAZ ───────────────────────────────
// `i18n/index.ts` acilis tablosunu ASENKRON yukler. Tablo gelmeden cagrilan
// `t('bir_anahtar')` -- yedek metin verilmemisse -- HAM ANAHTARI dondurur.
// Olculdu: ayni iddia bazi kosularda `'Bridge user'`, bazilarinda
// `'ui_bridge_user'` goruyordu; yani suit ZAMANLAMAYI olcuyordu, davranisi
// degil. Kurulum burada tabloyu bekler ve butun dosyalar icin belirlenimci
// bir baslangic saglar.
// DIKKAT: bu import BILEREK dosyanin SONUNDADIR ve statik degildir.
// `i18n/index.ts` dili MODUL YUKLENIRKEN tespit eder (`_detectLocale()`).
// Dosyanin basina statik bir import konulursa o tespit, yukaridaki
// `bridge_locale` / `navigator.language` sabitlemelerinden ONCE calisir ve
// butun suit sessizce jsdom varsayilani INGILIZCEYE duser (olculdu).
const { localeReady } = await import('./js/core/i18n/index.ts');
await localeReady;
