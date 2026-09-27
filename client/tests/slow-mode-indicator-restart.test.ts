// client/tests/slow-mode-indicator-restart.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SlowModeIndicator.svelte — GERİ SAYIMIN YENİDEN BAŞLATILMASI
// ════════════════════════════════════════════════════════════════════════════
// Yavaş modda kullanıcı ART ARDA denemeler yapar. Her ret için sunucu yeni bir
// `remaining` bildirir ve gösterge YENİDEN başlatılır.
//
// Ölçülen kusur şudur: her başlatma yeni bir zamanlayıcı kurar. Öncekini
// durdurmayan bir uygulama, saniyede BİRDEN ÇOK kez azaltır — geri sayım
// hızlanır ve kullanıcıya sunucunun uygulayacağından DAHA KISA bir süre
// gösterilir. O süre dolduğunda kullanıcı tekrar dener ve yine reddedilir;
// arayüz yalan söylemiş olur.
//
// İkinci sözleşme: yüzde çubuğu, kanalın yavaş mod süresi BİLİNMEDEN
// çizilemez. Bölme sıfıra düşerse `NaN%` bir stil değeri üretilir ve çubuk
// bozulur. Bu durumda pay sıfır kabul edilir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';

const registryMap: Record<string, unknown> = {};

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    has: (key: string) => key in registryMap,
    get: (key: string) => registryMap[key],
    call: (key: string, ...args: unknown[]) => {
      const owner = registryMap[key];
      return typeof owner === 'function' ? (owner as (...a: unknown[]) => unknown)(...args) : undefined;
    },
    register: (key: string, fn: unknown) => { registryMap[key] = fn; },
    unregister: (key: string) => { delete registryMap[key]; },
  },
}));

import SlowModeIndicator from '../js/core/SlowModeIndicator.svelte';

const setSlowMode = (secs: number) => (registryMap['setSlowMode'] as (s: number) => void)(secs);
const startCooldown = (secs: number) => (registryMap['startSlowModeCooldown'] as (s: number) => void)(secs);
const badge = () => { flushSync(); return document.querySelector('.slow-mode'); };
const seconds = () => { flushSync(); return document.querySelector('.sm-secs')?.textContent ?? ''; };
const fillWidth = () => { flushSync(); return document.querySelector<HTMLElement>('.sm-fill')?.style.width ?? ''; };
const advance = (ms: number) => { vi.advanceTimersByTime(ms); flushSync(); };

beforeEach(() => {
  vi.useFakeTimers();
  for (const key of Object.keys(registryMap)) delete registryMap[key];
  document.body.innerHTML = '';
  render(SlowModeIndicator);
  flushSync();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('restarting the countdown replaces the previous timer', () => {
  it('never ticks faster than once per second after repeated rejections', () => {
    setSlowMode(30);
    startCooldown(10);
    expect(seconds()).toBe('10s');

    // Kullanıcı tekrar dener; sunucu kalan süreyi yeniden bildirir.
    startCooldown(10);
    startCooldown(10);

    advance(1_000);
    // Üç zamanlayıcı birikseydi burada 7s görünürdü — geri sayım hızlanmış,
    // arayüz sunucudan DAHA KISA bir süre vaat etmiş olurdu.
    expect(seconds()).toBe('9s');

    advance(3_000);
    expect(seconds()).toBe('6s');
  });

  it('stops exactly at zero and hides the countdown', () => {
    setSlowMode(5);
    startCooldown(2);
    advance(2_000);

    // Geri sayım biter: kanalın kuralı gösterilmeye devam eder, sayaç durur.
    expect(seconds()).toBe('5s');
    expect(badge()?.className).not.toContain('active');

    // Zamanlayıcı gerçekten durmuştur; süre eksiye DÜŞMEZ.
    advance(10_000);
    expect(seconds()).toBe('5s');
  });

  it('draws a progress bar proportional to the channel rule', () => {
    setSlowMode(10);
    startCooldown(10);
    expect(fillWidth()).toBe('100%');
    advance(5_000);
    expect(fillWidth()).toBe('50%');
  });

  it('never produces an unusable width when the channel rule is unknown', () => {
    // `setSlowMode` hiç çağrılmadan bir ret gelirse (kanal verisi henüz
    // yüklenmemiş) pay sıfırdır; `NaN%` bir stil DEĞERİ üretilmez.
    startCooldown(5);
    expect(badge()).toBeNull();      // kural bilinmeden rozet çizilmez

    setSlowMode(0);
    expect(badge()).toBeNull();
  });
});

describe('the badge explains itself to assistive technology', () => {
  it('states the remaining time while counting down', () => {
    setSlowMode(20);
    startCooldown(7);
    const label = badge()?.getAttribute('aria-label') ?? '';
    expect(label).toContain('7 saniye');
    expect(badge()?.getAttribute('title')).toBe(label);
    expect(badge()?.getAttribute('role')).toBe('status');
  });

  it('states the channel rule while idle', () => {
    setSlowMode(20);
    const label = badge()?.getAttribute('aria-label') ?? '';
    expect(label).toContain('20 saniyede bir');
    expect(label).not.toContain('sonra tekrar');
  });
});
