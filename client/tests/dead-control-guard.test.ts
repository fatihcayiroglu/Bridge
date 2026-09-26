// client/tests/dead-control-guard.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÖLÜ DENETİM KORUMASI — DÜRÜSTLÜK SÖZLEŞMESİ
// ════════════════════════════════════════════════════════════════════════════
// `dead-control-guard.ts` 100 satırdır ve HİÇ testi yoktu. Yaptığı iş
// kullanıcıya doğrudan görünür: satır içi `onclick="birSey()"` taşıyan ama
// `birSey` tanımlı OLMAYAN düğmeler, tıklanınca sessizce ReferenceError
// üretiyordu — kullanıcı hiçbir geri bildirim almıyordu.
//
// ── BU MODÜLDE İKİ YÖNLÜ RİSK VAR ───────────────────────────────────────────
// Yalnızca "eksik olanı yakala" yeterli DEĞİL. Asıl tehlike YANLIŞ POZİTİF:
// koruma ÇALIŞAN bir düğmeyi etkisizleştirirse, hiçbir şeyin bozuk olmadığı
// yerde gerçek bir arıza YARATIR. Bu yüzden testler her iki yönü de tutar:
//
//   * tanımsız handler  -> KORUNMALI
//   * tanımlı handler   -> ASLA DOKUNULMAMALI
//   * çözülemeyen ifade -> ASLA DOKUNULMAMALI (belirsizlikte geri çekil)
//
// Bu dosyayı kaybetmek, ya sessiz ReferenceError'ları ya da çalışan
// düğmelerin ölmesini geri getirir.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const _toastlar: Array<{ mesaj: string; tur: string }> = [];
vi.mock('../js/core/utils.ts', () => ({
  toast: (mesaj: string, tur: string) => { _toastlar.push({ mesaj, tur }); },
}));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/i18n/index', () => ({
  // Gercek t() gibi {label} yerine koyar — mesajin kullaniciya anlamli
  // ulastigini dogrulayabilmek icin.
  t: (_k: string, fallback: string, vars?: Record<string, string>) =>
    (fallback || _k).replace(/\{(\w+)\}/g, (_m, ad) => vars?.[ad] ?? `{${ad}}`),
}));

import { guardDeadControls } from '../js/core/dead-control-guard.ts';

const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  document.body.innerHTML = '';
  _toastlar.length = 0;
  delete g.tanimliIslev;
  delete g.BridgeE2E;
});

/** Verilen onclick ile bir dugme kurar. */
function dugme(onclick: string, extra = ''): HTMLElement {
  document.body.innerHTML = `<button onclick="${onclick}" ${extra}>Gonder</button>`;
  return document.querySelector('button') as HTMLElement;
}

// ════════════════════════════════════════════════════════════════════════════
// TANIMSIZ HANDLER -> KORUNUR
// ════════════════════════════════════════════════════════════════════════════
describe('tanimsiz denetim korunur', () => {
  it('onclick KALDIRILIR ve isaretlenir', () => {
    const b = dugme('hicYokBoyleBirSey()');
    const sayi = guardDeadControls();
    expect(sayi).toBe(1);
    expect({
      onclick: b.getAttribute('onclick'),
      isaret:  b.dataset.deadControl,
      aria:    b.getAttribute('aria-disabled'),
    }).toEqual({ onclick: null, isaret: 'guarded', aria: 'true' });
  });

  it('TIKLAMA kullaniciya bildirim gosterir (sessiz hata DEGIL)', () => {
    // Asil kullanici sikayeti buydu: tiklaniyor, hicbir sey olmuyor.
    const b = dugme('hicYokBoyleBirSey()', 'aria-label="Mesaj gonder"');
    guardDeadControls();
    b.click();
    expect(_toastlar).toHaveLength(1);
    expect(_toastlar[0].mesaj).toContain('Mesaj gonder');
    expect(_toastlar[0].tur).toBe('info');
  });

  it('etiket olarak aria-label yoksa METIN kullanilir', () => {
    const b = dugme('yokBoyle()');
    guardDeadControls();
    b.click();
    expect(_toastlar[0].mesaj).toContain('Gonder');
  });

  it('NOKTALI yol da cozulur (BridgeE2E.acilmayan)', () => {
    g.BridgeE2E = { vardir: () => {} };
    const b = dugme('BridgeE2E.yoktur()');
    expect(guardDeadControls()).toBe(1);
    expect(b.dataset.deadControl).toBe('guarded');
  });

  it('bos etikette guvenli varsayilan islem adini kullanir', () => {
    document.body.innerHTML = '<button onclick="olmayan()"></button>';
    const b = document.querySelector('button') as HTMLElement;
    guardDeadControls();
    b.click();
    expect(_toastlar[0].mesaj).toContain('Bu işlem');
  });

  it('ara parcasi eksik nokta yolunu guvenli bicimde tanimsiz sayar', () => {
    g.BridgeE2E = {};
    const b = dugme('BridgeE2E.eksik.dahaDerin()');
    expect(guardDeadControls()).toBe(1);
    expect(b.dataset.deadControl).toBe('guarded');
  });

  it('global getter hata firlatsa da denetim cokmez', () => {
    Object.defineProperty(g, 'ThrowingOwner', {
      configurable: true,
      get: () => { throw new Error('getter failed'); },
    });
    const b = dugme('ThrowingOwner.open()');
    expect(() => guardDeadControls()).not.toThrow();
    expect(b.dataset.deadControl).toBe('guarded');
    delete g.ThrowingOwner;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// YANLIS POZITIF — CALISAN DUGMEYE DOKUNULMAZ
// ════════════════════════════════════════════════════════════════════════════
describe('calisan denetime DOKUNULMAZ', () => {
  it('tanimli global handler korunmaz', () => {
    // Koruma burada devreye girerse CALISAN bir dugmeyi oldurur.
    g.tanimliIslev = () => {};
    const b = dugme('tanimliIslev()');
    expect(guardDeadControls()).toBe(0);
    expect(b.getAttribute('onclick')).toBe('tanimliIslev()');
    expect(b.dataset.deadControl).toBeUndefined();
  });

  it('NOKTALI yol tanimliysa korunmaz', () => {
    g.BridgeE2E = { ac: () => {} };
    const b = dugme('BridgeE2E.ac()');
    expect(guardDeadControls()).toBe(0);
    expect(b.getAttribute('onclick')).toBe('BridgeE2E.ac()');
  });

  it('ad CIKARILAMAYAN karmasik ifadeye dokunulmaz', () => {
    // Belirsizlikte geri cekilme kurali: yanlis pozitif riski almaktansa
    // hicbir sey yapma.
    const b = dugme('(function(){ return 1; })()');
    expect(guardDeadControls()).toBe(0);
    expect(b.getAttribute('onclick')).toBe('(function(){ return 1; })()');
  });

  it('onclick TASIMAYAN ogeler etkilenmez', () => {
    document.body.innerHTML = '<button id="temiz">Normal</button>';
    expect(guardDeadControls()).toBe(0);
    expect(document.getElementById('temiz')!.dataset.deadControl).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TEKRAR CAGRILABILIRLIK
// ════════════════════════════════════════════════════════════════════════════
describe('birden cok tarama', () => {
  it('ayni ogeyi IKI KEZ saymaz (idempotent)', () => {
    // Yeni icerik eklendiginde tekrar cagrilir; her turda ayni dugmeyi
    // yeniden isleseydi her taramada bir dinleyici daha eklenir ve tek
    // tiklamada birden cok bildirim cikardi.
    const b = dugme('yokBoyle()');
    expect(guardDeadControls()).toBe(1);
    expect(guardDeadControls()).toBe(0);
    b.click();
    expect(_toastlar).toHaveLength(1);
  });

  it('SONRADAN eklenen icerik de taranir', () => {
    dugme('yokBoyle()');
    guardDeadControls();
    document.body.insertAdjacentHTML('beforeend', '<button onclick="baskaYok()">Yeni</button>');
    expect(guardDeadControls()).toBe(1);
  });

  it('yalnizca verilen KOK altinda tarar', () => {
    document.body.innerHTML =
      '<div id="a"><button onclick="yokA()">A</button></div>' +
      '<div id="b"><button onclick="yokB()">B</button></div>';
    const a = document.getElementById('a')!;
    expect(guardDeadControls(a)).toBe(1);
    expect(document.querySelector('#b button')!.getAttribute('onclick')).toBe('yokB()');
  });

  it('onclick tasisa bile onceden isaretlenmis ogeyi tekrar islemez', () => {
    const b = dugme('yokBoyle()', 'data-dead-control="guarded"');
    expect(guardDeadControls()).toBe(0);
    expect(b.getAttribute('onclick')).toBe('yokBoyle()');
  });

  it('tarama ile attribute okuma arasinda onclick kaybolursa yanlis pozitif uretmez', () => {
    const b = dugme('yokBoyle()');
    const original = b.getAttribute.bind(b);
    vi.spyOn(b, 'getAttribute').mockImplementation((name: string) =>
      name === 'onclick' ? null : original(name));
    expect(guardDeadControls()).toBe(0);
    expect(b.dataset.deadControl).toBeUndefined();
  });
});

describe('boot tarama zamanlamasi', () => {
  it('loading belgesinde DOM, load, socket ve auth bariyerlerini calistirir', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    document.body.innerHTML =
      '<div id="auth-screen"><button onclick="missingPasskey()">Passkey</button></div>';

    await import('../js/core/dead-control-guard.ts');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('#auth-screen button')?.getAttribute('aria-disabled')).toBe('true');

    // Ilk genel tarama artik temiz DOM gorur (count=0).
    document.dispatchEvent(new Event('bridge:socket-ready'));

    // Sonradan gelen bir olu denetim auth bariyerinin gecikmeli taramasinda bulunur.
    document.body.insertAdjacentHTML('beforeend', '<button onclick="lateMissing()">Late</button>');
    document.dispatchEvent(new Event('bridge:auth-success'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector('button[aria-disabled="true"]:last-of-type')).toBeTruthy();

    ready.mockRestore();
    vi.useRealTimers();
  });

  it('giris kokunde olu denetim yoksa ek uyari uretmeden tamamlanir', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    document.body.innerHTML = '<div id="auth-screen"><button>Normal</button></div>';

    await import('../js/core/dead-control-guard.ts');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector('#auth-screen [aria-disabled="true"]')).toBeNull();
    ready.mockRestore();
    vi.useRealTimers();
  });
});
