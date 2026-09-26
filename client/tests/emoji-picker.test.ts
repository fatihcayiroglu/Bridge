// client/tests/emoji-picker.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// FAZ K/4 — COMPOSER EMOJI SECICI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK BOSLUK
// ════════════════════════════════════════════════════════════════════════════
// Composer'da emoji EKLEMENIN hicbir yolu yoktu: kabukta yalnizca "dosya ekle",
// textarea ve "gonder" vardi. `MessageRenderer`in hizli tepki seti mesaja
// TEPKI verir — mesaj YAZMAZ.
//
// En kritik davranis, en kolay gozden kacan yerdedir: emoji programatik
// yazildiginda `input` OLAYI elle yayilmalidir. `MessageInputPanel` taslak
// kaydini, otomatik buyumeyi ve gonder dugmesini o olaya bagliyor; olay
// yayilmazsa emoji GORUNUR ama taslak kaydedilmez ve kutu buyumez.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';

const registryMap: Record<string, unknown> = {};

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register:   (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
    has:        (k: string) => k in registryMap,
    get:        (k: string) => registryMap[k],
    call:       (k: string, ...a: unknown[]) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...a) : v;
    },
  },
}));

vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../js/core/a11y/focusTrap.ts', () => ({ focusTrap: () => ({ destroy() {} }) }));

import { insertEmoji, applyEmojiToInput } from '../js/core/composer/emoji-insert.ts';
import { searchEmojis, EMOJI_CATEGORIES, ALL_EMOJIS } from '../js/core/composer/emoji-data.ts';
import EmojiPickerPanel from '../js/core/EmojiPickerPanel.svelte';

// ── Yardimcilar ────────────────────────────────────────────────────────────

function composer(value = ''): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.id = 'msg-input';
  el.value = value;
  document.body.appendChild(el);
  return el;
}

async function openPicker() {
  (registryMap.openEmojiPicker as () => void)();
  await waitFor(() => expect(document.querySelector('.ep-panel')).toBeTruthy());
  return document.querySelector<HTMLElement>('.ep-panel')!;
}

const items = () => [...document.querySelectorAll<HTMLElement>('.ep-item')];
const selected = () => document.querySelector('.ep-item[aria-selected="true"]');

beforeEach(() => {
  for (const k of Object.keys(registryMap)) delete registryMap[k];
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

// ════════════════════════════════════════════════════════════════════════════
describe('insertEmoji — yerlestirme kurallari', () => {
  it('bos metne yerlestirir', () => {
    expect(insertEmoji('', 0, 0, '👍')).toEqual({ value: '👍 ', caret: 3 });
  });

  it('onceki KELIMEYE YAPISMAZ', () => {
    // "merhaba👍" hem okunmaz hem bazi istemcilerde ayristirmayi bozar.
    expect(insertEmoji('merhaba', 7, 7, '👍').value).toBe('merhaba 👍 ');
  });

  it('zaten bosluk varsa IKINCISINI eklemez', () => {
    expect(insertEmoji('merhaba ', 8, 8, '👍').value).toBe('merhaba 👍 ');
  });

  it('imlec ORTADAYKEN oraya yerlestirir', () => {
    const r = insertEmoji('ab cd', 2, 2, '🔥');
    expect(r.value).toBe('ab 🔥 cd');
  });

  it('SECILI metni degistirir', () => {
    expect(insertEmoji('sil beni', 0, 3, '✅').value).toBe('✅ beni');
  });

  it('imlec emojiden SONRAYA konur', () => {
    const r = insertEmoji('ab', 2, 2, '🔥');
    expect(r.value.slice(0, r.caret)).toBe('ab 🔥 ');
  });

  it('sinir disi imlec degerleri kirpilir', () => {
    expect(() => insertEmoji('ab', -5, 99, '🔥')).not.toThrow();
    expect(insertEmoji('ab', -5, 99, '🔥').value).toBe('🔥 ');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('applyEmojiToInput', () => {
  it('`input` OLAYINI yayar — taslak kaydi buna baglidir', () => {
    // Bu olay yayilmazsa emoji gorunur ama taslak kaydedilmez, kutu buyumez
    // ve gonder dugmesi etkinlesmez.
    const el = composer('merhaba');
    el.setSelectionRange(7, 7);
    const spy = vi.fn();
    el.addEventListener('input', spy);

    expect(applyEmojiToInput(el, '👍')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(el.value).toBe('merhaba 👍 ');
  });

  it('olay KABARIR (bubbles) — dinleyici ust dugumde olabilir', () => {
    const el = composer();
    const spy = vi.fn();
    document.body.addEventListener('input', spy);
    applyEmojiToInput(el, '🔥');
    expect(spy).toHaveBeenCalled();
    document.body.removeEventListener('input', spy);
  });

  it('kutu yoksa sessizce basarili DEMEZ', () => {
    expect(applyEmojiToInput(null, '👍')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('emoji verisi ve arama', () => {
  it('her kategori bos degildir ve etiketlidir', () => {
    for (const c of EMOJI_CATEGORIES) {
      expect(c.emojis.length).toBeGreaterThan(0);
      // Kategoriler artik SABIT etiket degil, i18n ANAHTARI tasir (`labelKey`);
      // etiket render aninda cozulur. Sozlesme: anahtar var ve GERCEKTEN
      // sozlukte tanimli.
      expect(c.labelKey.length).toBeGreaterThan(0);
      expect(t(c.labelKey)).not.toBe(c.labelKey);
    }
  });

  it('emoji karakterleri TEKRARSIZDIR', () => {
    const chars = ALL_EMOJIS.map(e => e.char);
    expect(new Set(chars).size).toBe(chars.length);
  });

  it('Turkce anahtarla bulunur', () => {
    expect(searchEmojis('kahve').map(e => e.char)).toContain('☕');
  });

  it('Ingilizce anahtarla da bulunur', () => {
    // Arayuz Turkce ama emoji adlari evrensel olarak Ingilizce bilinir.
    expect(searchEmojis('fire').map(e => e.char)).toContain('🔥');
    expect(searchEmojis('thumbs').map(e => e.char)).toContain('👍');
  });

  it('ONEK eslesmesi ustte gelir', () => {
    const results = searchEmojis('ates');
    expect(results[0]!.char).toBe('🔥');
  });

  it('emojinin KENDISI yazilirsa dogrudan eslesir', () => {
    expect(searchEmojis('🔥')[0]!.char).toBe('🔥');
  });

  it('buyuk/kucuk harf duyarsizdir', () => {
    expect(searchEmojis('FIRE').map(e => e.char)).toContain('🔥');
  });

  it('bos sorgu sonuc uretmez', () => {
    expect(searchEmojis('   ')).toEqual([]);
  });

  it('eslesmeyen sorgu bos doner', () => {
    expect(searchEmojis('zzzqqqxxx')).toEqual([]);
  });

  it('sonuc sayisi sinirlanir', () => {
    expect(searchEmojis('a', 5)).toHaveLength(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('EmojiPickerPanel', () => {
  it('kabuk dugmesi seciciyi ACAR', async () => {
    const button = document.createElement('button');
    button.id = 'btn-emoji';
    document.body.appendChild(button);
    render(EmojiPickerPanel);

    await fireEvent.click(button);
    await waitFor(() => expect(document.querySelector('.ep-panel')).toBeTruthy());
  });

  it('emojiye tiklayinca composer\'a YAZAR ve kapanir', async () => {
    const el = composer('merhaba');
    render(EmojiPickerPanel);
    await openPicker();

    await fireEvent.click(items()[0]!);
    await waitFor(() => expect(document.querySelector('.ep-panel')).toBeNull());
    expect(el.value).toMatch(/^merhaba \S+ $/u);
  });

  it('arama izgarayi daraltir', async () => {
    composer();
    render(EmojiPickerPanel);
    await openPicker();
    const before = items().length;

    await fireEvent.input(document.querySelector('.ep-search')!, { target: { value: 'kahve' } });
    await waitFor(() => expect(items().length).toBeLessThan(before));
    expect(items()[0]!.textContent!.trim()).toBe('☕');
  });

  it('eslesme yoksa BOS DURUM gosterilir', async () => {
    composer();
    render(EmojiPickerPanel);
    await openPicker();

    await fireEvent.input(document.querySelector('.ep-search')!, { target: { value: 'zzzqqq' } });
    await waitFor(() => expect(document.querySelector('.ep-empty')).toBeTruthy());
  });

  it('kategori sekmeleri izgarayi degistirir', async () => {
    composer();
    render(EmojiPickerPanel);
    await openPicker();

    const tabs = [...document.querySelectorAll<HTMLElement>('.ep-tab')];
    const first = items()[0]!.textContent;
    await fireEvent.click(tabs[tabs.length - 1]!);
    await waitFor(() => expect(items()[0]!.textContent).not.toBe(first));
  });

  it('SON KULLANILANLAR hatirlanir', async () => {
    composer();
    const { unmount } = render(EmojiPickerPanel);
    await openPicker();
    const chosen = items()[0]!.textContent!.trim();
    await fireEvent.click(items()[0]!);
    await waitFor(() => expect(document.querySelector('.ep-panel')).toBeNull());
    unmount();

    render(EmojiPickerPanel);
    await openPicker();
    // Son kullanilanlar sekmesi acilista secili olur.
    await waitFor(() => expect(items()[0]!.textContent!.trim()).toBe(chosen));
  });

  it('ok tuslari ve Enter ile klavyeden secilebilir', async () => {
    const el = composer();
    render(EmojiPickerPanel);
    const panel = await openPicker();

    const firstChar = items()[0]!.textContent!.trim();
    await fireEvent.keyDown(panel, { key: 'ArrowRight' });
    await waitFor(() => expect(selected()!.textContent!.trim()).not.toBe(firstChar));

    const target = selected()!.textContent!.trim();
    await fireEvent.keyDown(panel, { key: 'Enter' });
    await waitFor(() => expect(el.value).toContain(target));
  });

  it('ArrowDown bir SATIR atlar (izgara duzeniyle tutarli)', async () => {
    composer();
    render(EmojiPickerPanel);
    const panel = await openPicker();

    await fireEvent.keyDown(panel, { key: 'ArrowDown' });
    await waitFor(() => {
      const idx = items().findIndex(i => i.getAttribute('aria-selected') === 'true');
      expect(idx).toBe(8);
    });
  });

  it('uclarda SARMA YOK', async () => {
    composer();
    render(EmojiPickerPanel);
    const panel = await openPicker();

    await fireEvent.keyDown(panel, { key: 'ArrowLeft' });
    await waitFor(() => {
      const idx = items().findIndex(i => i.getAttribute('aria-selected') === 'true');
      expect(idx).toBe(0);
    });
  });

  it('Escape kapatir ve odagi COMPOSER\'a verir', async () => {
    const el = composer();
    render(EmojiPickerPanel);
    const panel = await openPicker();

    await fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.ep-panel')).toBeNull());
    expect(document.activeElement).toBe(el);
  });

  it('bozuk ve tip dışı recent kaydını güvenli biçimde sınırlar', async () => {
    localStorage.setItem('bridge:recent-emojis', '{broken json');
    composer();
    const { unmount } = render(EmojiPickerPanel);
    await openPicker();
    expect(document.querySelector('.ep-heading')).not.toHaveTextContent('Son kullanılanlar');
    unmount();

    localStorage.setItem('bridge:recent-emojis', JSON.stringify([42, null, 'bilinmeyen', '🔥', ...Array(20).fill('☕')]));
    render(EmojiPickerPanel);
    await openPicker();
    expect(document.querySelector('.ep-heading')).toHaveTextContent('Son kullanılanlar');
    expect(items().map(item => item.textContent?.trim())).toEqual(['🔥', '☕']);
  });

  it('yalnız bilinmeyen recent değerlerini atar ve boş aramada klavye korumalarını uygular', async () => {
    localStorage.setItem('bridge:recent-emojis', JSON.stringify(['not-an-emoji']));
    composer();
    render(EmojiPickerPanel);
    const panel = await openPicker();

    expect(items().length).toBeGreaterThan(0);
    await fireEvent.input(document.querySelector('.ep-search')!, { target: { value: 'no-match-at-all' } });
    await waitFor(() => expect(items()).toHaveLength(0));
    expect(document.querySelector('.ep-empty')).toHaveTextContent('Eşleşen emoji yok.');
    expect(document.querySelector('.ep-search')).not.toHaveAttribute('aria-activedescendant');
    await fireEvent.keyDown(panel, { key: 'ArrowRight' });
    await fireEvent.keyDown(panel, { key: 'Home' });
    await fireEvent.keyDown(panel, { key: 'End' });
    await fireEvent.keyDown(panel, { key: 'Enter' });
    expect(items()).toHaveLength(0);
  });

  it('dizi olmayan recent kaydını reddeder ve geçmişi üst sınırda keser', async () => {
    localStorage.setItem('bridge:recent-emojis', JSON.stringify({ recent: ['🔥'] }));
    composer();
    const first = render(EmojiPickerPanel);
    await openPicker();
    expect(document.querySelector('.ep-heading')).not.toHaveTextContent('Son kullanılanlar');
    first.unmount();

    localStorage.setItem('bridge:recent-emojis', JSON.stringify(ALL_EMOJIS.slice(0, 20).map(entry => entry.char)));
    render(EmojiPickerPanel);
    await openPicker();
    expect(document.querySelector('.ep-heading')).toHaveTextContent('Son kullanılanlar');
    expect(items()).toHaveLength(16);
  });

  it('composer yoksa seçim yapmaz ve geçerli dönüş odağına geri döner', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render(EmojiPickerPanel);
    await openPicker();

    await fireEvent.click(items()[0]!);
    expect(document.querySelector('.ep-panel')).not.toBeNull();
    await fireEvent.click(document.querySelector('.ep-close')!);
    await waitFor(() => expect(document.querySelector('.ep-panel')).toBeNull());
    expect(document.activeElement).toBe(opener);

    // Zaten kapalı olan sahip çağrısı başka bir odağı değiştirmemelidir.
    (registryMap.closeEmojiPicker as () => void)();
    expect(document.activeElement).toBe(opener);
  });

  it('bağlantısı kopmuş dönüş odağını çağırmaz', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render(EmojiPickerPanel);
    await openPicker();
    opener.remove();

    expect(() => (registryMap.closeEmojiPicker as () => void)()).not.toThrow();
    await waitFor(() => expect(document.querySelector('.ep-panel')).toBeNull());
  });

  it('tüm gezinme uçlarını, fare seçimini ve görünür öğeye kaydırmayı uygular', async () => {
    composer();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      render(EmojiPickerPanel);
      const panel = await openPicker();

      await fireEvent.keyDown(panel, { key: 'End' });
      expect(selected()).toBe(items().at(-1));
      await fireEvent.keyDown(panel, { key: 'Home' });
      expect(selected()).toBe(items()[0]);
      await fireEvent.keyDown(panel, { key: 'ArrowDown' });
      await fireEvent.keyDown(panel, { key: 'ArrowUp' });
      expect(selected()).toBe(items()[0]);
      await fireEvent.mouseMove(items()[3]!);
      expect(selected()).toBe(items()[3]);
      await fireEvent.keyDown(panel, { key: 'Unrelated' });
      expect(selected()).toBe(items()[3]);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('recent sekmesine döner, tekrarı tekilleştirir ve depolama kotasını yutar', async () => {
    localStorage.setItem('bridge:recent-emojis', JSON.stringify(['🔥', '☕']));
    composer();
    render(EmojiPickerPanel);
    await openPicker();
    const recentTab = document.querySelector<HTMLElement>('.ep-tab[aria-label="Son kullanılanlar"]')!;
    const categoryTabs = [...document.querySelectorAll<HTMLElement>('.ep-tab')];
    await fireEvent.click(categoryTabs.at(-1)!);
    await fireEvent.click(recentTab);
    expect(items()[0]).toHaveTextContent('🔥');

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota'); });
    await fireEvent.click(items()[0]!);
    await waitFor(() => expect(document.querySelector('.ep-panel')).toBeNull());
    expect(JSON.parse(localStorage.getItem('bridge:recent-emojis')!)).toEqual(['🔥', '☕']);
    setItem.mockRestore();
  });

  it('kabuk düğmesi ikinci tıklamada kapatır ve scrim de kapatır', async () => {
    composer();
    const button = document.createElement('button');
    button.id = 'btn-emoji';
    document.body.appendChild(button);
    render(EmojiPickerPanel);

    await fireEvent.click(button);
    await waitFor(() => expect(document.querySelector('.ep-panel')).not.toBeNull());
    await fireEvent.click(button);
    await waitFor(() => expect(document.querySelector('.ep-panel')).toBeNull());
    await fireEvent.click(button);
    await fireEvent.click(document.querySelector('.ep-scrim')!);
    await waitFor(() => expect(document.querySelector('.ep-panel')).toBeNull());
  });

  it('unmount kayitlari birakir', () => {
    const { unmount } = render(EmojiPickerPanel);
    expect('openEmojiPicker' in registryMap).toBe(true);
    unmount();
    expect('openEmojiPicker' in registryMap).toBe(false);
  });

  it('erisilebilirlik sozlesmesi', async () => {
    composer();
    render(EmojiPickerPanel);
    const panel = await openPicker();

    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById('ep-grid')!.getAttribute('role')).toBe('listbox');
    // Her emoji ADLANDIRILIR — ekran okuyucuda ciplak karakter anlamsizdir.
    for (const item of items().slice(0, 5)) {
      expect(item.getAttribute('aria-label')!.length).toBeGreaterThan(0);
    }
    expect(document.querySelector('.ep-search')!.getAttribute('aria-controls')).toBe('ep-grid');
  });
});
