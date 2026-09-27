// client/tests/onboarding-wizard-navigation.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// OnboardingWizard.svelte — ADIM GEZİNMESİ, KLAVYE VE GEÇİŞ KİLİDİ
// ════════════════════════════════════════════════════════════════════════════
// `onboarding-wizard.test.ts` görünürlük/kullanıcı kapsamı sözleşmesini ölçer.
// Bu dosya, turun İÇİNDEKİ gezinmeyi ölçer: sekiz adımın her biri, ok tuşları,
// nokta (dot) sekmeleri, arka plan tıklaması ve geçiş animasyonu sırasındaki
// KİLİT.
//
// Geçiş kilidi önemsiz bir detay değildir: `scheduleStep` adım değişimini bir
// zamanlayıcıya erteler. Kilit olmasaydı hızlı tekrar tıklama sırayı bozar,
// birden çok zamanlayıcı yarışır ve tur son adımın ötesine geçip çökebilirdi.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import OnboardingWizard from '../js/core/OnboardingWizard.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const STORAGE_PREFIX = 'bridge_onboarding_v3';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

const backdrop = () => { flushSync(); return document.querySelector('.ow-backdrop'); };
const counter = () => document.querySelector('.ow-counter')?.textContent?.trim() ?? '';
const dots = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.ow-dot'));
/** Adım geçiş zamanlayıcısını bitirir. */
const settleStep = () => { vi.advanceTimersByTime(400); flushSync(); };

function key(name: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('token', 'tok-u1');
  BridgeRegistry.register('getMe', () => ({ _id: 'u1' }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(OnboardingWizard, { target: host });
  flushSync();
  BridgeRegistry.call('showOnboardingWizard');
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host?.remove();
  BridgeRegistry.unregister('getMe');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('step navigation', () => {
  it('renders a distinct illustration for every step of the tour', () => {
    const total = dots().length;
    // Final21 UX (U-05): tur 8 adımdan 6 adıma indi (yanlış E2EE/federasyon iddiaları ve
    // yinelenen Ctrl+K adımı çıktı, davet adımı eklendi). Uzunluk bilinçli bir ürün kararıdır.
    expect(total).toBe(6);

    const shapes = new Set<string>();
    for (let index = 0; index < total; index += 1) {
      expect(counter()).toBe(`${index + 1} / ${total}`);
      const svg = document.querySelector('.ow-icon svg');
      expect(svg).not.toBeNull();
      shapes.add(svg!.innerHTML);
      if (index < total - 1) { key('ArrowRight'); settleStep(); }
    }
    // Her adımın KENDİ görseli olmalıdır; tek bir yedek ikon tekrar etseydi
    // kullanıcı ilerlediğini göremezdi.
    expect(shapes.size).toBe(total);
  });

  it('moves backwards with ArrowLeft and refuses to move before the first step', () => {
    key('ArrowRight'); settleStep();
    expect(counter()).toBe(`2 / ${dots().length}`);
    key('ArrowLeft'); settleStep();
    expect(counter()).toBe(`1 / ${dots().length}`);
    key('ArrowLeft'); settleStep();
    expect(counter()).toBe(`1 / ${dots().length}`);
  });

  it('jumps to an arbitrary step through the dot tablist and ignores the current one', () => {
    const total = dots().length;
    dots()[3]!.click(); settleStep();
    expect(counter()).toBe(`4 / ${total}`);
    expect(dots()[3]!.getAttribute('aria-selected')).toBe('true');
    expect(dots()[0]!.classList.contains('done')).toBe(true);

    dots()[3]!.click(); settleStep();
    expect(counter()).toBe(`4 / ${total}`);

    dots()[0]!.click(); settleStep();
    expect(counter()).toBe(`1 / ${total}`);
  });

  it('locks navigation while a step transition is still running', () => {
    const total = dots().length;
    key('ArrowRight');            // geçiş başlar, henüz tamamlanmadı
    key('ArrowRight');            // kilitli: yok sayılır
    dots()[5]!.click();           // kilitli: yok sayılır
    key('ArrowLeft');             // kilitli: yok sayılır
    settleStep();
    expect(counter()).toBe(`2 / ${total}`);
  });

  it('closes on the final step, records completion for this user and stays closed', () => {
    const total = dots().length;
    dots()[total - 1]!.click(); settleStep();
    expect(counter()).toBe(`${total} / ${total}`);

    key('ArrowRight'); settleStep();
    expect(backdrop()).toBeNull();
    expect(localStorage.getItem(`${STORAGE_PREFIX}:u1`)).toBe('done');

    // Kapalıyken klavye olayları hiçbir şey yapmaz.
    key('ArrowLeft'); key('Escape'); settleStep();
    expect(backdrop()).toBeNull();
  });
});

describe('dismissal surfaces', () => {
  it('closes when the backdrop itself is clicked but not when the card is', () => {
    const card = document.querySelector('.ow-card') as HTMLElement;
    card.click();
    expect(backdrop()).not.toBeNull();

    (backdrop() as HTMLElement).click();
    expect(backdrop()).toBeNull();
  });

  it('closes through the explicit close control and through Escape', () => {
    (document.querySelector('.ow-close') as HTMLButtonElement).click();
    flushSync();
    expect(backdrop()).toBeNull();

    BridgeRegistry.call('showOnboardingWizard');
    flushSync();
    expect(backdrop()).not.toBeNull();
    key('Escape');
    expect(backdrop()).toBeNull();
  });

  it('exposes a labelled progressbar that tracks the current step', () => {
    const bar = document.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-label')).toBeTruthy();
    expect(bar.getAttribute('aria-valuemin')).toBe('1');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe(String(dots().length));

    key('ArrowRight'); settleStep();
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    const fill = document.querySelector('.ow-progress-fill') as HTMLElement;
    expect(fill.getAttribute('style')).toMatch(/width:\s*\d+(\.\d+)?%/);
  });
});

// Final21 UX (U-05): tur her yeni kullanıcıya DOĞRU OLMAYAN şeyler söylüyordu — DM'de var
// olmayan bir E2EE kilidi (denetim Faz 11'de bilerek kaldırılmıştı), sol çubukta var olmayan bir
// yer küre simgesi, Bot Marketi'nin sunucu ayarlarında olduğu; Ctrl+K iki adımda iki farklı
// adla anlatılıyordu. Tur sunucu oluşturulunca açılır; o anın asıl işi davettir.
describe('tour content', () => {
  function readAllSteps(): Array<{ title: string; text: string }> {
    const steps: Array<{ title: string; text: string }> = [];
    for (let i = 0; i < dots().length; i += 1) {
      steps.push({
        title: document.querySelector('.ow-title')?.textContent?.trim() ?? '',
        text: `${document.querySelector('.ow-text')?.textContent ?? ''} ${document.querySelector('.ow-tip')?.textContent ?? ''}`,
      });
      if (i < dots().length - 1) { key('ArrowRight'); settleStep(); }
    }
    return steps;
  }

  it('six steps, in task order, with no claim about controls that do not exist', () => {
    const steps = readAllSteps();
    expect(steps.map((s) => s.title)).toEqual([
      "Bridge'e Hoş Geldin", 'Arkadaşlarını davet et', 'Ses Kanalları & Ekran Paylaşımı',
      'Bot Marketi', 'Komut paleti ve kısayollar', 'Hazırsın!',
    ]);
    const all = steps.map((s) => `${s.title} ${s.text}`).join(' ');
    expect(all).not.toMatch(/E2E|şifreleme|kilit simgesi|ActivityPub|Mastodon|yer küre|federasyon/i);
  });

  it('points to the real places: server name → invite, server name → "Bot ekle"', () => {
    const steps = readAllSteps();
    expect(steps[1]!.text).toMatch(/sunucunun adına tıkla.*Arkadaşlarını davet et/);
    expect(steps[3]!.text).toMatch(/sunucunun adına tıkla.*Bot ekle/);
    expect(steps[3]!.text).not.toMatch(/ayarlarından/);
    // Ctrl+K tek adımda ve tek adla anlatılır.
    expect(steps.filter((s) => /Ctrl\+K/.test(s.text))).toHaveLength(1);
  });
});
