// client/tests/group-dm-keyboard.test.ts
// FAZ E — GROUP DM KLAVYE ERİŞİLEBİLİRLİĞİ.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU PAKET VAR
// ════════════════════════════════════════════════════════════════════════════
// GDM, C4.7'de CANLI bir yüzey hâline geldi. Uykudan çıkan bir yüzey, kod
// tabanının geri kalanının uyduğu sözleşmelere de uymak zorundadır. İki
// ölçülmüş sapma vardı:
//
//  1. ESCAPE YOK. Üç modal (create/members/settings) yalnız FARE ile — arka
//     perdeye tıklayarak — kapanabiliyordu. `grep -n "Escape" GroupDmPanel`
//     sıfır sonuç veriyordu; oysa ServerSettingsModal.svelte:68 ve
//     SettingsModal Escape ile kapanır.
//
//  2. `role="button"` ÖĞESİ SPACE'E YANITSIZ. Liste öğesi yalnız Enter'ı
//     dinliyordu. ARIA sözleşmesi `role="button"` için HEM Enter HEM Space
//     ister; dahası odaklı bir div'de Space, varsayılan olarak SAYFAYI
//     KAYDIRIR — yani sessiz bir eksiklik değil, aktif olarak yanlış davranış.
//     Kanonik biçim ChannelItem.svelte:39-45'te zaten mevcuttu.
//
// POZİTİF KONTROL KURALI: her "kapanmamalı/açılmamalı" iddiasının yanında
// davranışa gerçekten ULAŞILDIĞINI gösteren bir kontrol vardır. Hiçbir şey
// olmadığı için geçen test kanıt sayılmaz.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { mountGroupDmPanel, unmountGroupDmPanel } from '../js/core/group-dm-svelte.ts';

const GROUPS = [
  { _id: 'gdm-A', name: 'Grup A', ownerId: 'u1', icon: '👥', memberCount: 2 },
  { _id: 'gdm-B', name: 'Grup B', ownerId: 'u1', icon: '🎮', memberCount: 2 },
];

const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b } as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;

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

const panel = () => document.querySelector('#gdm-panel');
const items = () => [...document.querySelectorAll<HTMLElement>('.gdm-item')];
const modal = () => document.querySelector('.modal-overlay');

/** ÜRETİM YOLU: kabuk kökü + gerçek mount köprüsü. */
function bootShell(): void {
  const root = document.createElement('div');
  root.id = 'gdm-root';
  document.body.appendChild(root);
  mountGroupDmPanel();
  flushSync();
}

/** Gerçek ürün açıcısı (FriendsPanel bu kaydı çağırır). */
function openPanel(): void {
  const open = BridgeRegistry.get('showGroupDmPanel') as (() => void) | undefined;
  if (!open) throw new Error('showGroupDmPanel KAYITLI DEĞİL — ürün açıcısı kopmuş');
  open();
  flushSync();
}

/** GERÇEK klavye olayı — window'a, üretimdeki dinleyicinin durduğu yere. */
function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  flushSync();
}

async function waitForList(): Promise<void> {
  await vi.waitFor(() => { flushSync(); expect(items().length).toBe(GROUPS.length); });
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).API = 'http://test';
  fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (/\/messages/.test(u)) return ok([]);
    if (u.endsWith('/api/gdm')) return ok(GROUPS);
    const g = u.match(/\/api\/gdm\/([^/?]+)$/);
    if (g) return ok(GROUPS.find(x => x._id === g[1]) ?? GROUPS[0]);
    return ok([]);
  });
  BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
  BridgeRegistry.register('getMe', () => ({ id: 'u1', displayName: 'Ben' }));
  BridgeRegistry.register('socket', makeSocket());
});

afterEach(() => {
  unmountGroupDmPanel();
  for (const k of ['apiFetch', 'getMe', 'socket', 'showGroupDmPanel', 'openGroupDmPanel', 'closeGroupDmPanel']) {
    BridgeRegistry.unregister(k);
  }
  delete (window as unknown as Record<string, unknown>).API;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// 1) ESCAPE — KATMANLI KAPANMA
// ════════════════════════════════════════════════════════════════════════════
describe('Faz E — Escape ile katmanlı kapanma', () => {
  it('POZİTİF KONTROL: panel ürün yolundan gerçekten açılır', async () => {
    bootShell();
    openPanel();
    await waitForList();

    expect(panel()).not.toBeNull();
  });

  it('Escape açık paneli kapatır', async () => {
    bootShell();
    openPanel();
    await waitForList();
    expect(panel()).not.toBeNull();   // ön koşul

    pressKey('Escape');

    expect(panel()).toBeNull();
  });

  it('modal açıkken Escape YALNIZ modalı kapatır, paneli AÇIK bırakır', async () => {
    bootShell();
    openPanel();
    await waitForList();

    // Gerçek ürün yolundan modalı aç: boş-durum değil, başlıktaki "yeni grup".
    const opener = document.querySelector<HTMLElement>('[data-gdm-action="create"]')
      ?? [...document.querySelectorAll<HTMLElement>('button')]
           .find(b => /Yeni|Oluştur|\+/.test(b.textContent ?? ''));
    expect(opener, 'modal açıcı bulunamadı').toBeTruthy();
    opener!.click();
    flushSync();
    expect(modal(), 'ön koşul: modal açılmalıydı').not.toBeNull();

    pressKey('Escape');

    // En üst katman gitti…
    expect(modal()).toBeNull();
    // …ama alttaki panel KORUNDU. Tek tuşla iki katman kaybolursa kullanıcı
    // bağlamını yitirir; bu testin asıl koruduğu davranış budur.
    expect(panel()).not.toBeNull();
  });

  it('ikinci Escape modaldan sonra paneli kapatır', async () => {
    bootShell();
    openPanel();
    await waitForList();

    const opener = [...document.querySelectorAll<HTMLElement>('button')]
      .find(b => /Yeni|Oluştur|\+/.test(b.textContent ?? ''));
    opener!.click();
    flushSync();

    pressKey('Escape');   // modal
    pressKey('Escape');   // panel

    expect(panel()).toBeNull();
  });

  it('GİZLİ panel Escape\'i YUTMAZ (başka yüzeylerin tuşunu çalmaz)', () => {
    // Dinleyici `window` üzerindedir ve panel GİZLİYKEN de mount hâlinde
    // durur. Koşulsuz kapatma yazılsaydı, açık bir arama kutusu veya başka
    // bir modal Escape'i hiç GÖREMEZDİ. Bu, sessiz ve teşhisi zor bir
    // gerileme olurdu — bu yüzden ayrıca kanıtlanır.
    bootShell();
    // Panel AÇILMADI.
    expect(panel()).toBeNull();

    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    pressKey('Escape');
    window.removeEventListener('keydown', spy);

    // Olay başka dinleyicilere ULAŞTI: panel ne durdurdu ne de tüketti.
    expect(spy).toHaveBeenCalledTimes(1);
    const ev = spy.mock.calls[0]![0] as KeyboardEvent;
    expect(ev.defaultPrevented).toBe(false);
    expect(panel()).toBeNull();
  });

  it('Escape DIŞINDAKİ tuşlar paneli kapatmaz', async () => {
    bootShell();
    openPanel();
    await waitForList();

    for (const k of ['Enter', 'a', 'Tab', 'ArrowDown']) pressKey(k);

    expect(panel()).not.toBeNull();
  });

  it('unmount sonrası window dinleyicisi KALMAZ (sızıntı yok)', async () => {
    bootShell();
    openPanel();
    await waitForList();

    unmountGroupDmPanel();
    flushSync();

    // Sökülmüş bileşenin dinleyicisi hâlâ bağlıysa bu çağrı patlar veya
    // ölü duruma dokunur. Sessizce geçmeli ve panel geri GELMEMELİ.
    expect(() => pressKey('Escape')).not.toThrow();
    expect(panel()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2) role="button" — ENTER **VE** SPACE
// ════════════════════════════════════════════════════════════════════════════
describe('Faz E — liste öğesi klavyeyle etkinleşir', () => {
  /** Öğeye doğrudan tuş gönderir (üretimde odaklı öğe bunu alır). */
  function keyOnItem(el: HTMLElement, key: string): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    flushSync();
    return ev;
  }

  it('liste öğesi klavye ile ODAKLANABİLİR ve role="button" taşır', async () => {
    bootShell();
    openPanel();
    await waitForList();

    const el = items()[0]!;
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('Enter grubu açar', async () => {
    bootShell();
    openPanel();
    await waitForList();

    const before = fetchMock.mock.calls.filter(c => /\/messages/.test(String(c[0]))).length;
    keyOnItem(items()[0]!, 'Enter');

    await vi.waitFor(() => {
      flushSync();
      const after = fetchMock.mock.calls.filter(c => /\/messages/.test(String(c[0]))).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('SPACE de grubu açar (asıl kapatılan boşluk)', async () => {
    bootShell();
    openPanel();
    await waitForList();

    const before = fetchMock.mock.calls.filter(c => /\/messages/.test(String(c[0]))).length;
    keyOnItem(items()[0]!, ' ');

    await vi.waitFor(() => {
      flushSync();
      const after = fetchMock.mock.calls.filter(c => /\/messages/.test(String(c[0]))).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('SPACE varsayılanı ENGELLENİR (odaklı div sayfayı kaydırmasın)', async () => {
    bootShell();
    openPanel();
    await waitForList();

    const ev = keyOnItem(items()[0]!, ' ');

    // preventDefault çağrılmazsa tarayıcı sayfayı kaydırır: kullanıcı grubu
    // açar ve AYNI ANDA görünümü kaybeder.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('ilgisiz tuşlar grubu AÇMAZ', async () => {
    bootShell();
    openPanel();
    await waitForList();

    const before = fetchMock.mock.calls.filter(c => /\/messages/.test(String(c[0]))).length;
    for (const k of ['a', 'Shift', 'ArrowRight', 'Escape']) keyOnItem(items()[0]!, k);
    flushSync();

    const after = fetchMock.mock.calls.filter(c => /\/messages/.test(String(c[0]))).length;
    expect(after).toBe(before);
  });
});
