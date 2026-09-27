// client/tests/slow-mode.test.ts
//
// FAZ 8/6 — YAVAŞ MOD GÖRÜNÜRLÜĞÜ.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// Sunucu yavaş modu ZATEN uyguluyordu (`checkSlowmode` → `error:slowmode
// { remaining, channelId }`). İstemcide bu olayı DİNLEYEN kimse yoktu:
// kullanıcının mesajı gitmiyor ve NEDENİ söylenmiyordu.
//
// ── BU PAKETİN ASIL İŞİ ───────────────────────────────────────────────────
// İki yönü birden kilitlemek:
//   • kısıtlama GÖRÜNÜR olur (sessiz başarısızlık yok)
//   • kısıtlamanın SAHİBİ sunucu kalır (istemci kendi zamanlayıcısını
//     kural yerine koymaz, hiçbir gönderimi kendi başına engellemez)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';

const registryMap: Record<string, unknown> = {};

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    has:  (k: string) => k in registryMap,
    get:  (k: string) => registryMap[k],
    call: (k: string, ...a: unknown[]) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...a) : v;
    },
    register:   (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
  },
}));

import SlowModeIndicator from '../js/core/SlowModeIndicator.svelte';

const badge = () => document.querySelector('.slow-mode');
const setSlowMode = (secs: number) => (registryMap.setSlowMode as (n: number) => void)(secs);
const startCooldown = (secs: number) => (registryMap.startSlowModeCooldown as (n: number) => void)(secs);

beforeEach(() => {
  for (const k of Object.keys(registryMap)) delete registryMap[k];
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

// ════════════════════════════════════════════════════════════════════════════
describe('gösterge', () => {
  it('yavaş mod KAPALIYKEN hiçbir şey çizilmez', async () => {
    render(SlowModeIndicator);
    await waitFor(() => expect(registryMap.setSlowMode).toBeTypeOf('function'));
    expect(badge()).toBeNull();
  });

  it('yavaş mod açıkken kanalın aralığını gösterir', async () => {
    render(SlowModeIndicator);
    await waitFor(() => expect(registryMap.setSlowMode).toBeTypeOf('function'));
    setSlowMode(10);

    await waitFor(() => expect(badge()).toBeTruthy());
    expect(badge()!.textContent).toContain('10');
  });

  it('AÇIKLAMA tam cümledir — "sessizce gitmedi" bırakılmaz', async () => {
    render(SlowModeIndicator);
    await waitFor(() => expect(registryMap.setSlowMode).toBeTypeOf('function'));
    setSlowMode(8);

    await waitFor(() => {
      const label = badge()!.getAttribute('aria-label')!;
      expect(label).toContain('Yavaş mod');
      expect(label).toContain('8');
      expect(label.length).toBeGreaterThan(30);   // rozet dar, açıklama değil
    });
  });

  it('ihlal sonrası KALAN SÜRE gösterilir', async () => {
    render(SlowModeIndicator);
    await waitFor(() => expect(registryMap.setSlowMode).toBeTypeOf('function'));
    setSlowMode(10);
    startCooldown(7);

    await waitFor(() => {
      expect(badge()!.className).toContain('active');
      expect(badge()!.getAttribute('aria-label')).toContain('7 saniye sonra');
    });
  });

  it('geri sayım ilerler ve biter', async () => {
    vi.useFakeTimers();
    render(SlowModeIndicator);
    await vi.advanceTimersByTimeAsync(0);
    setSlowMode(10);
    startCooldown(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(badge()!.getAttribute('aria-label')).toContain('1 saniye');

    await vi.advanceTimersByTimeAsync(1500);
    // Süre bitince "aktif" durum düşer ama kanal hâlâ yavaş moddadır.
    expect(badge()!.className).not.toContain('active');
    expect(badge()!.getAttribute('aria-label')).toContain('10 saniyede bir');
  });

  it('durum canlı bölge olarak duyurulur', async () => {
    render(SlowModeIndicator);
    await waitFor(() => expect(registryMap.setSlowMode).toBeTypeOf('function'));
    setSlowMode(5);

    await waitFor(() => {
      expect(badge()!.getAttribute('role')).toBe('status');
      expect(badge()!.getAttribute('aria-live')).toBe('polite');
    });
  });

  it('unmount kayıtları BIRAKIR', async () => {
    const { unmount } = render(SlowModeIndicator);
    await waitFor(() => expect('setSlowMode' in registryMap).toBe(true));
    unmount();
    expect('setSlowMode' in registryMap).toBe(false);
    expect('startSlowModeCooldown' in registryMap).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bağlama — sunucu SAHİPTİR', () => {
  /** Sahte socket: kanonik `error:slowmode` sözleşmesini taşır. */
  function fakeSocket() {
    const handlers: Record<string, Function[]> = {};
    return {
      on: (e: string, fn: Function) => { (handlers[e] ??= []).push(fn); },
      off: (e: string, fn: Function) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== fn); },
      emit: (e: string, payload: unknown) => { for (const h of handlers[e] ?? []) h(payload); },
      count: (e: string) => (handlers[e] ?? []).length,
    };
  }

  async function boot(channel: unknown, socket: ReturnType<typeof fakeSocket>) {
    const wrap = document.createElement('div');
    wrap.id = 'msg-input-wrap';
    document.body.appendChild(wrap);
    registryMap.socket = socket;
    registryMap.getCurrentChannel = () => channel;

    vi.resetModules();
    const mod = await import('../js/core/slow-mode-svelte.ts');
    mod.mountSlowMode();
    await waitFor(() => expect(registryMap.setSlowMode).toBeTypeOf('function'));
    return mod;
  }

  it('kanal seçilince kanalın yavaş mod aralığı okunur', async () => {
    const socket = fakeSocket();
    const mod = await boot({ _id: 'c1', slowmode: 15 }, socket);
    try {
      await waitFor(() => expect(badge()!.textContent).toContain('15'));
    } finally { mod.unmountSlowMode(); }
  });

  it('sunucunun `error:slowmode` olayı geri sayımı başlatır', async () => {
    const socket = fakeSocket();
    const mod = await boot({ _id: 'c1', slowmode: 10 }, socket);
    try {
      socket.emit('error:slowmode', { remaining: 6, channelId: 'c1' });
      await waitFor(() => expect(badge()!.getAttribute('aria-label')).toContain('6 saniye sonra'));
    } finally { mod.unmountSlowMode(); }
  });

  it('BAŞKA kanalın ihlali gösterilmez', async () => {
    // Yanlış kanalın uyarısı kullanıcıyı yanlış yere bakmaya iter.
    const socket = fakeSocket();
    const mod = await boot({ _id: 'c1', slowmode: 10 }, socket);
    try {
      socket.emit('error:slowmode', { remaining: 6, channelId: 'BASKA' });
      await new Promise(r => setTimeout(r, 20));
      expect(badge()!.className).not.toContain('active');
    } finally { mod.unmountSlowMode(); }
  });

  it('geçersiz kalan süre yok sayılır', async () => {
    const socket = fakeSocket();
    const mod = await boot({ _id: 'c1', slowmode: 10 }, socket);
    try {
      for (const bad of [undefined, null, 'x', -3, 0]) {
        socket.emit('error:slowmode', { remaining: bad, channelId: 'c1' });
      }
      await new Promise(r => setTimeout(r, 20));
      expect(badge()!.className).not.toContain('active');
    } finally { mod.unmountSlowMode(); }
  });

  it('İSTEMCİ hiçbir gönderimi ENGELLEMEZ — kısıtlamanın sahibi sunucudur', async () => {
    const socket = fakeSocket();
    const mod = await boot({ _id: 'c1', slowmode: 10 }, socket);
    try {
      socket.emit('error:slowmode', { remaining: 9, channelId: 'c1' });
      await waitFor(() => expect(badge()!.className).toContain('active'));

      // Gösterge hiçbir gönderim kapısı kaydetmez; yalnızca gösterir.
      for (const key of Object.keys(registryMap)) {
        expect(key).not.toMatch(/^(sendMessage|blockSend|canSend)$/);
      }
    } finally { mod.unmountSlowMode(); }
  });

  it('sökme socket dinleyicisini ÇÖZER', async () => {
    const socket = fakeSocket();
    const mod = await boot({ _id: 'c1', slowmode: 10 }, socket);
    expect(socket.count('error:slowmode')).toBe(1);
    mod.unmountSlowMode();
    expect(socket.count('error:slowmode')).toBe(0);
  });

  it('yavaş modu olmayan kanalda gösterge çizilmez', async () => {
    const socket = fakeSocket();
    const mod = await boot({ _id: 'c1' }, socket);
    try {
      expect(badge()).toBeNull();
    } finally { mod.unmountSlowMode(); }
  });
});
