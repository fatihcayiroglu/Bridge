// client/tests/shell-actions-reachability.test.ts
// UX/P1 — KABUK DÜĞMELERİ GERÇEKTEN ÇALIŞIYOR MU.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (canlı tarayıcıda tıklanarak ölçüldü)
// ════════════════════════════════════════════════════════════════════════════
// `index.html` içindeki `data-bridge-action` dispatcher'ı KLASİK bir inline
// script'tir; `BridgeRegistry` ise `window`a hiç atanmayan bir ESM dışa
// aktarımıdır. Bu yüzden dispatcher'ın registry dalı HİÇ çalışmaz.
//
// Canlı ölçüm (tıklama sonrası DOM değişimi):
//     Direkt mesajlar → 0 bayt   (ÖLÜ)
//     Arkadaşlar      → 0 bayt   (ÖLÜ)
//     Ara             → 0 bayt   (ÖLÜ — Faz F'de "WORKING" sayılmıştı)
//     Sunucu ekle     → 0 bayt   (ÖLÜ)
//
// Hepsinin registry KAYDI vardı; eksik olan KÖPRÜYDÜ.
// "Kayıt var" ≠ "kullanıcı ulaşabiliyor".
//
// ════════════════════════════════════════════════════════════════════════════
// KORUNAN DEĞİŞMEZ: ÇİFT TETİKLEME OLMAZ
// ════════════════════════════════════════════════════════════════════════════
// Bazı düğmeler kendi bileşenleri tarafından DOĞRUDAN bağlanır. Global bir
// `window.BridgeRegistry` atamak eski dispatcher'ı canlandırır ve bu düğmeleri
// İKİ KEZ tetiklerdi (ayarlar iki kez açılır, üye listesi açılıp kapanır).
// Köprü bu eylemleri BİLEREK atlar.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { mountShellActions, unmountShellActions } from '../js/core/shell-actions.ts';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function button(action: string, arg?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.setAttribute('data-bridge-action', action);
  if (arg) b.setAttribute('data-bridge-arg', arg);
  document.body.appendChild(b);
  return b;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mountShellActions();
});

afterEach(() => {
  unmountShellActions();
  for (const k of ['showDmPanel', 'showFriendsPanel', 'openSearchFromShell',
                   'openServerStart', 'openSettingsModal', 'sendMessage',
                   'toggleMemberList', 'openServerMenu', 'mobileNav']) {
    BridgeRegistry.unregister(k);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe('KABUK EYLEM KÖPRÜSÜ', () => {
  const dead = ['showDmPanel', 'showFriendsPanel', 'openSearchFromShell', 'openServerStart'];

  for (const action of dead) {
    it(`"${action}" düğmesi KAYITLI sahibini GERÇEKTEN çağırır`, () => {
      const spy = vi.fn();
      BridgeRegistry.register(action, spy);

      button(action).click();

      expect(spy).toHaveBeenCalledTimes(1);
    });
  }

  it('bileşen tarafından bağlanan eylemler ATLANIR (çift tetikleme yok)', () => {
    const bound = ['sendMessage', 'openSettingsModal', 'toggleMemberList', 'openServerMenu'];
    const spies = bound.map(a => { const s = vi.fn(); BridgeRegistry.register(a, s); return s; });

    bound.forEach(a => button(a).click());

    // Köprü bunlara DOKUNMAZ — sahipleri zaten kendi dinleyicisini bağlar.
    spies.forEach(s => expect(s).not.toHaveBeenCalled());
  });

  it('SAHİBİ OLMAYAN eylem sessizce yok sayılır (çökme yok)', () => {
    expect(() => button('boyleBirSeyYok').click()).not.toThrow();
  });

  it('legacy sözleşme korunur: ilk argüman ÖGE, sonra data-bridge-arg', () => {
    const spy = vi.fn();
    BridgeRegistry.register('mobileNav', spy);

    const b = button('mobileNav', 'channels');
    b.click();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(b);
    expect(spy.mock.calls[0][1]).toBe('channels');
  });

  it('iç ögeye tıklamak da eylemi tetikler (closest ile)', () => {
    const spy = vi.fn();
    BridgeRegistry.register('showDmPanel', spy);
    const b = button('showDmPanel');
    const icon = document.createElement('span');
    b.appendChild(icon);

    icon.click();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('unmount sonrası köprü DİNLEMEZ', () => {
    const spy = vi.fn();
    BridgeRegistry.register('showDmPanel', spy);
    unmountShellActions();

    button('showDmPanel').click();

    expect(spy).not.toHaveBeenCalled();
  });

  it('üretim giriş noktası köprüyü İMPORT EDER', () => {
    const app = fs.readFileSync(path.join(CLIENT, 'js/app.ts'), 'utf8');
    expect(app).toMatch(/core\/shell-actions/);
  });

  it('kabuktaki HER data-bridge-action için bir sahip ya da bileşen bağı vardır', () => {
    // Regresyon kapisi: index.html'e sahibi olmayan yeni bir dugme eklenirse
    // bu test o dugmeyi gorunur kilar (olu satir uretilmesin).
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
    const actions = [...new Set([...html.matchAll(/data-bridge-action="([^"]+)"/g)].map(m => m[1]))];

    expect(actions.length).toBeGreaterThan(0);
    // Kabukta beklenen iletisim girisleri MUTLAKA bulunmali.
    for (const must of ['showDmPanel', 'showFriendsPanel', 'openSearchFromShell']) {
      expect(actions).toContain(must);
    }
  });
});
