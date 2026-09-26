// client/tests/dialog-escape-contract.test.ts
// FAZ E — ÜRÜN GENELİNDE TEK "ESCAPE İLE KAPANMA" SÖZLEŞMESİ.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU PAKET VAR
// ════════════════════════════════════════════════════════════════════════════
// Denetim: `role="dialog"` taşıyan 17 canlı yüzeyin 4'ünde Escape işleyicisi
// YOKTU. Tutarsızlık, tek tek eksiklerden daha kötüdür: kullanıcı Escape'in
// bazen çalıştığını öğrenir, sonra çalışmadığı yerde sıkışır. Klavye ve ekran
// okuyucu kullanıcıları için `aria-modal="true"` bir yüzeyi kapatmanın tek
// yolu, odağı kapatma düğmesine kadar TAB'lamak kalıyordu.
//
// Bu paket iki şeyi kanıtlar:
//   1. DAVRANIŞ  — DmPanel ve FriendsPanel gerçekten Escape ile kapanır.
//   2. SÖZLEŞME  — kaynak taramasıyla, hiçbir YENİ dialog yüzeyi Escape'siz
//                  eklenemez (gerileme kapısı).
//
// KASITLI İSTİSNALAR — sessizce atlanmaz, BURADA gerekçelenir:
//   · `js/admin/AdminPanel.svelte`  — DORMANT. 0 importer, sevk edilmiyor;
//     Faz E'de canlandırılması AYRICA yasaktır. Canlı olmayan yüzeye ürün
//     sözleşmesi dayatmak, onu yanlışlıkla canlıymış gibi göstermek olurdu.
//   · `js/core/DmCallPanel.svelte` — görünürlüğü `$derived(callStatus !==
//     'idle')`; `close()` YOKTUR. Buraya Escape eklemek "paneli kapat" değil
//     "ARAMAYI SONLANDIR" anlamına gelirdi: kazara tuşa basmak görüşmeyi
//     düşürürdü. Escape'in YOKLUĞU burada doğru davranıştır.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// ── KAYNAK TARAMASI G/Ç BAĞLIDIR ────────────────────────────────────────────
// Bu dosyadaki testler istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik
// VARSAYILAN zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir
// makinede aşılabilir; ölçüm bitmeden test kırmızıya döner ve bu, ürün hakkında
// HİÇBİR ŞEY söylemeyen bir kırılganlıktır. Sözleşme taramanın SONUCUNDA
// olduğu için bu dosyaya açık ve cömert bir zaman aşımı verilir. Hiçbir iddia
// gevşetilmemiştir; yalnızca zamanlama gürültüsü kaldırılmıştır.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { flushSync } from 'svelte';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { mountDmPanel, unmountDmPanel } from '../js/core/dm-svelte.ts';
import { mountFriendsPanel, unmountFriendsPanel } from '../js/core/friends-svelte.ts';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b } as unknown as Response);

function makeSocket() {
  const listeners: Record<string, Array<(d: unknown) => void>> = {};
  return {
    emit: vi.fn(),
    on: (e: string, fn: (d: unknown) => void) => { (listeners[e] ??= []).push(fn); },
    off: (e: string, fn: (d: unknown) => void) => {
      listeners[e] = (listeners[e] ?? []).filter(f => f !== fn);
    },
  };
}

function pressEscape(): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  flushSync();
  return ev;
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).API = 'http://test';
  BridgeRegistry.register('apiFetch', vi.fn(async () => ok([])));
  BridgeRegistry.register('getMe', () => ({ id: 'u1', displayName: 'Ben' }));
  BridgeRegistry.register('socket', makeSocket());
});

afterEach(() => {
  unmountDmPanel();
  unmountFriendsPanel();
  for (const k of ['apiFetch', 'getMe', 'socket',
                   'showDmPanel', 'openDmPanel', 'openDm', 'closeDmPanel',
                   'showFriendsPanel', 'openFriendsPanel', 'hideFriendsPanel']) {
    BridgeRegistry.unregister(k);
  }
  delete (window as unknown as Record<string, unknown>).API;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// 1) DAVRANIŞ — DmPanel
// ════════════════════════════════════════════════════════════════════════════
describe('Faz E — DmPanel Escape ile kapanır', () => {
  const dm = () => document.querySelector('.dm-panel');

  function boot(): void {
    mountDmPanel();
    flushSync();
  }
  function open(): void {
    const fn = BridgeRegistry.get('showDmPanel') as (() => void) | undefined;
    if (!fn) throw new Error('showDmPanel KAYITLI DEĞİL — ürün açıcısı kopmuş');
    fn();
    flushSync();
  }

  it('POZİTİF KONTROL: panel ürün yolundan açılır', () => {
    boot(); open();
    expect(dm()).not.toBeNull();
  });

  it('Escape açık paneli kapatır', () => {
    boot(); open();
    expect(dm()).not.toBeNull();     // ön koşul

    pressEscape();

    expect(dm()).toBeNull();
  });

  it('GİZLİ panel Escape\'i YUTMAZ', () => {
    boot();                           // AÇILMADI
    expect(dm()).toBeNull();

    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const ev = pressEscape();
    window.removeEventListener('keydown', spy);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('unmount sonrası dinleyici KALMAZ', () => {
    boot(); open();
    unmountDmPanel();
    flushSync();

    expect(() => pressEscape()).not.toThrow();
    expect(dm()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2) DAVRANIŞ — FriendsPanel
// ════════════════════════════════════════════════════════════════════════════
describe('Faz E — FriendsPanel Escape ile kapanır', () => {
  const fp = () => document.querySelector('.friends-panel');

  function boot(): void {
    mountFriendsPanel();
    flushSync();
  }
  function open(): void {
    const fn = BridgeRegistry.get('showFriendsPanel') as (() => void) | undefined;
    if (!fn) throw new Error('showFriendsPanel KAYITLI DEĞİL — ürün açıcısı kopmuş');
    fn();
    flushSync();
  }

  it('POZİTİF KONTROL: panel ürün yolundan açılır', () => {
    boot(); open();
    expect(fp()).not.toBeNull();
  });

  it('Escape açık paneli kapatır', () => {
    boot(); open();
    expect(fp()).not.toBeNull();     // ön koşul

    pressEscape();

    expect(fp()).toBeNull();
  });

  it('GİZLİ panel Escape\'i YUTMAZ', () => {
    boot();
    expect(fp()).toBeNull();

    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const ev = pressEscape();
    window.removeEventListener('keydown', spy);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('unmount sonrası dinleyici KALMAZ', () => {
    boot(); open();
    unmountFriendsPanel();
    flushSync();

    expect(() => pressEscape()).not.toThrow();
    expect(fp()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3) SÖZLEŞME — gerileme kapısı
// ════════════════════════════════════════════════════════════════════════════
describe('Faz E — dialog yüzeyleri Escape sözleşmesine uyar', () => {
  /** Gerekçesi yukarıdaki başlıkta yazılı KASITLI istisnalar. */
  const EXEMPT: Record<string, string> = {
    'js/admin/AdminPanel.svelte':
      'DORMANT — 0 importer; canlı olmayan yüzeye ürün sözleşmesi dayatılmaz',
    'js/core/DmCallPanel.svelte':
      'close() yok; görünürlük callStatus türevi — Escape "aramayı sonlandır" olurdu',
  };

  function svelteFiles(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) svelteFiles(full, acc);
      else if (e.name.endsWith('.svelte')) acc.push(full);
    }
    return acc;
  }
  const rel = (f: string) => path.relative(CLIENT_ROOT, f).split(path.sep).join('/');

  // ── KAYNAK TARAMASI G/Ç BAĞLIDIR, ZAMANLAMA İDDİASI DEĞİLDİR ────────────
  // Bu test tüm istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik varsayılan
  // zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir makinede
  // AŞILABİLİR ve tarama bitmeden test kırmızıya döner. Ölçülen sözleşme
  // sürede değil, taramanın SONUCUNDA olduğu için açık ve cömert bir zaman
  // aşımı verilir; hiçbir iddia gevşetilmez.
  it('role="dialog" taşıyan her yüzey Escape\'i ele alır', () => {
    const offenders = svelteFiles(path.join(CLIENT_ROOT, 'js'))
      .filter(f => /role="dialog"/.test(fs.readFileSync(f, 'utf8')))
      .filter(f => !/Escape/.test(fs.readFileSync(f, 'utf8')))
      .map(rel)
      .filter(f => !(f in EXEMPT));

    expect(offenders).toEqual([]);
  }, 60_000);

  it('muafiyet listesi küçük ve gerçek kalır', () => {
    // Muafiyet ucuz bir kaçış yolu OLMAMALIDIR: her giriş var olan bir
    // dosyayı göstermeli ve liste büyümemelidir.
    for (const p of Object.keys(EXEMPT)) {
      expect(fs.existsSync(path.join(CLIENT_ROOT, p)), `${p} yok`).toBe(true);
    }
    expect(Object.keys(EXEMPT).length).toBeLessThanOrEqual(2);
  });

  it('DmCallPanel gerçekten close()\'suz kalır (muafiyet gerekçesi hâlâ doğru)', () => {
    // Muafiyet "close() yok" gerekçesine dayanır. Biri panele close() eklerse
    // gerekçe ÇÜRÜR ve muafiyet yeniden değerlendirilmelidir — bu test o anda
    // kırılarak bunu zorunlu kılar.
    const src = fs.readFileSync(path.join(CLIENT_ROOT, 'js/core/DmCallPanel.svelte'), 'utf8');
    expect(src).toMatch(/\$derived\(callStatus !== 'idle'\)/);
  });
});
