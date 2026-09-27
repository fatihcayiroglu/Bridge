// client/tests/ux-final21-message-actions.test.ts
//
// Final21 UX turu — MESAJ EYLEMLERİ
//   · masaüstü sağ tık / Menü tuşu → aynı yetki koşullu eylem listesi, imlecin yanında
//     (Discord'dan gelenlerin kas hafızası); tarayıcı menüsü seçili metinde ve bağlantıda korunur
//   · uzun basmanın PARMAK KALDIRMA tıklaması, parmağın altına kayan öğeyi (ölçüldü: "Sil")
//     tetiklemez ve sayfayı anında kapatmaz
//   · "Metni kopyala" eylemi; role=menu için ok tuşu gezintisi

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent, within } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import MessageActionSheet from '../js/core/MessageActionSheet.svelte';
import MessageRenderer, { type MessageData } from '../js/core/MessageRenderer.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const action = (id: string, over: Record<string, unknown> = {}) => ({ id, label: id, run: vi.fn(), ...over });
const message = (over: Partial<MessageData> = {}): MessageData => ({
  _id: 'm-1', userId: 'me', displayName: 'Ada Lovelace', content: 'kopyalanacak metin',
  createdAt: 1_754_000_000_000, channelId: 'channel-1', serverId: 'server-1', ...over,
});
function withDetail(type: string, detail: number, extra: Record<string, unknown> = {}): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, detail });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(e, k, { configurable: true, value: v });
  return e;
}
function pointer(type: string, values: Record<string, unknown>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(values)) Object.defineProperty(event, k, { configurable: true, value: v });
  return event;
}

let clipboardWrite: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clipboardWrite = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboardWrite } });
});
afterEach(() => { cleanup(); BridgeRegistry.unregister('toast'); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('eylem sayfası — parmak kaldırma tıklaması', () => {
  it('öğede BASILI başlamayan işaretçi tıklaması eylemi çalıştırmaz (uzun basma bırakışı)', async () => {
    const del = action('delete', { danger: true });
    const onClose = vi.fn();
    const { container } = render(MessageActionSheet, { props: { open: true, actions: [del], onClose } });
    container.querySelector<HTMLButtonElement>('.mas-item.danger')!.dispatchEvent(withDetail('click', 1));
    expect(del.run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('öğede basılıp bırakılan gerçek dokunuş eylemi çalıştırır', async () => {
    const del = action('delete', { danger: true });
    const { container } = render(MessageActionSheet, { props: { open: true, actions: [del], onClose: vi.fn() } });
    const item = container.querySelector<HTMLButtonElement>('.mas-item.danger')!;
    item.dispatchEvent(pointer('pointerdown', { pointerType: 'touch' }));
    item.dispatchEvent(withDetail('click', 1));
    expect(del.run).toHaveBeenCalledTimes(1);
  });

  it('klavye etkinleştirmesi (detail 0) her zaman sayılır', async () => {
    const reply = action('reply');
    const { container } = render(MessageActionSheet, { props: { open: true, actions: [reply], onClose: vi.fn() } });
    container.querySelector<HTMLButtonElement>('.mas-item')!.dispatchEvent(withDetail('click', 0));
    expect(reply.run).toHaveBeenCalledTimes(1);
  });

  it('bırakış tıklaması örtüye düşerse sayfa AÇIK kalır; örtüde basılıp bırakmak kapatır', async () => {
    const onClose = vi.fn();
    const { container } = render(MessageActionSheet, { props: { open: true, actions: [action('reply')], onClose } });
    const scrim = container.querySelector<HTMLElement>('.mas-scrim')!;
    scrim.dispatchEvent(withDetail('click', 1));
    expect(onClose).not.toHaveBeenCalled();
    scrim.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }));
    scrim.dispatchEvent(withDetail('click', 1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ok tuşları menü öğeleri arasında döner', async () => {
    const { container } = render(MessageActionSheet, { props: { open: true, actions: [action('a'), action('b')], onClose: vi.fn() } });
    const items = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    items[0]!.focus();
    await fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    await fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[2]); // İptal
    await fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
  });
});

describe('eylem sayfası — masaüstü bağlam menüsü kipi', () => {
  it('çapa verildiğinde imleç noktasında kompakt menü: tutamaç, önizleme ve "İptal" yok', async () => {
    const { container } = render(MessageActionSheet, { props: { open: true, anchor: { x: 120, y: 90 }, preview: 'önizleme', actions: [action('reply')], onClose: vi.fn() } });
    await new Promise((r) => setTimeout(r, 0)); flushSync();
    const sheet = container.querySelector<HTMLElement>('.mas-sheet')!;
    expect(sheet.style.opacity).toBe('');
    expect(sheet.classList.contains('anchored')).toBe(true);
    expect(sheet.querySelector('.mas-grip')).toBeNull();
    expect(sheet.querySelector('.mas-preview')).toBeNull();
    expect(sheet.querySelector('.mas-cancel')).toBeNull();
    expect(sheet.style.left).toBe('120px');
    expect(sheet.style.top).toBe('90px');
    expect(container.querySelector('.mas-scrim')!.classList.contains('anchored')).toBe(true);
  });

  // jsdom penceresi 1024×768; menü 200×300 ölçülür.
  const sized = (w: number, h: number) => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const [width, height] = this.classList.contains('mas-sheet') ? [w, h] : [0, 0];
    return { left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });

  // Ölçüm tick() sonrasında yapılır; yerleşim bitince ölçüm için verilen opacity:0 kalkar.
  const placed = async () => { await new Promise((r) => setTimeout(r, 0)); flushSync(); };

  it('alt-sağ köşedeki sağ tıkta menü imlecin ÜSTÜNE ve SOLUNA açılır: köşesi imleçte, imleci örtmez', async () => {
    sized(200, 300);
    const { container } = render(MessageActionSheet, { props: { open: true, anchor: { x: 900, y: 700 }, actions: [action('reply')], onClose: vi.fn() } });
    await placed();
    const sheet = container.querySelector<HTMLElement>('.mas-sheet')!;
    expect(sheet.style.opacity).toBe('');
    // Alt-sağ köşe tam imleçte (700+200 = 900, 400+300 = 700); yalnız sığdırma 816/460'a koyup imleci örterdi.
    expect(sheet.style.left).toBe('700px');
    expect(sheet.style.top).toBe('400px');
  });

  it('yalnız alt kenarda: yukarı açılır, yatayda imleçten başlar', async () => {
    sized(200, 300);
    const { container } = render(MessageActionSheet, { props: { open: true, anchor: { x: 400, y: 714 }, actions: [action('reply')], onClose: vi.fn() } });
    await placed();
    const sheet = container.querySelector<HTMLElement>('.mas-sheet')!;
    expect(sheet.style.opacity).toBe('');
    expect(sheet.style.left).toBe('400px');
    expect(sheet.style.top).toBe('414px');
  });

  it('iki yöne de sığmayan menü yine ekranda kalır (son güvence)', async () => {
    sized(200, 700);
    const { container } = render(MessageActionSheet, { props: { open: true, anchor: { x: 400, y: 300 }, actions: [action('reply')], onClose: vi.fn() } });
    await placed();
    const sheet = container.querySelector<HTMLElement>('.mas-sheet')!;
    expect(sheet.style.opacity).toBe('');
    expect(sheet.style.top).toBe('8px');
  });

  it('örtüde sağ tık menüyü kapatır (tarayıcı menüsü açılmaz)', async () => {
    const onClose = vi.fn();
    const { container } = render(MessageActionSheet, { props: { open: true, anchor: { x: 1, y: 1 }, actions: [action('reply')], onClose } });
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    container.querySelector('.mas-scrim')!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('mesaj — sağ tık', () => {
  it('sağ tık aynı eylem listesini imleçte açar ve tarayıcı menüsünü bastırır', async () => {
    const view = render(MessageRenderer, { props: { message: message(), currentUserId: 'me', onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() } });
    const article = view.container.querySelector<HTMLElement>('article.msg')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 150 });
    article.dispatchEvent(e);
    flushSync();
    expect(e.defaultPrevented).toBe(true);
    const menu = document.querySelector<HTMLElement>('.mas-sheet.anchored')!;
    const labels = within(menu).getAllByRole('menuitem').map((i) => i.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(['Tepki ekle', 'Yanıtla', 'Metni kopyala', 'Düzenle', 'Sil']));
    expect(labels).not.toContain('İptal');
  });

  it('mesajda seçili metin varken tarayıcı menüsü korunur (kopyalama)', () => {
    const view = render(MessageRenderer, { props: { message: message() } });
    const article = view.container.querySelector<HTMLElement>('article.msg')!;
    const range = document.createRange();
    range.selectNodeContents(article.querySelector('.msg-content')!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    article.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(document.querySelector('.mas-sheet')).toBeNull();
    getSelection()!.removeAllRanges();
  });

  it('bağlantı üzerinde tarayıcı menüsü korunur (adresi kopyala)', () => {
    const view = render(MessageRenderer, { props: { message: message({ content: 'bak https://example.test/a' }) } });
    const link = view.container.querySelector<HTMLAnchorElement>('.msg-content a[href]');
    expect(link).not.toBeNull();
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    link!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(document.querySelector('.mas-sheet')).toBeNull();
  });

  it('klavyeden gelen bağlam olayında (0,0) menü mesajın yanında açılır', async () => {
    const view = render(MessageRenderer, { props: { message: message() } });
    const article = view.container.querySelector<HTMLElement>('article.msg')!;
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 40, right: 410, bottom: 80, width: 400, height: 40, x: 10, y: 40, toJSON: () => ({}) } as DOMRect);
    article.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    flushSync();
    const sheet = document.querySelector<HTMLElement>('.mas-sheet.anchored')!;
    expect(sheet.style.left).toBe('386px');
    expect(sheet.style.top).toBe('48px');
  });

  it('"Metni kopyala" ham metni panoya yazar ve onay gösterir', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    const view = render(MessageRenderer, { props: { message: message({ content: '**kalın** metin' }) } });
    const article = view.container.querySelector<HTMLElement>('article.msg')!;
    article.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    flushSync();
    within(document.querySelector<HTMLElement>('.mas-sheet')!).getByRole('menuitem', { name: 'Metni kopyala' }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(clipboardWrite).toHaveBeenCalledWith('**kalın** metin');
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Kopyalandı/), 'success');
  });

  it('pano yoksa kopyalamanın olmadığı açıkça söylenir', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    clipboardWrite.mockRejectedValueOnce(new Error('denied'));
    const view = render(MessageRenderer, { props: { message: message() } });
    view.container.querySelector<HTMLElement>('article.msg')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    flushSync();
    within(document.querySelector<HTMLElement>('.mas-sheet')!).getByRole('menuitem', { name: 'Metni kopyala' }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/kopyalanamadı/), 'warning');
  });
});

describe('CSS sözleşmesi — dokunmatikte eylem çubuğu genişliğe değil YETENEĞE bağlı (U-13)', () => {
  it('hover olmayan cihazda çubuk düzenden çıkar; statik kalıcı çubuk kuralı yok', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const src = readFileSync(join(__dirname, '..', 'js', 'core', 'MessageRenderer.svelte'), 'utf8');
    const css = src.slice(src.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.msg-actions \{ display: none; \}/);
    expect(css).not.toMatch(/\(hover: none\), \(pointer: coarse\)/);
    expect(css).not.toMatch(/\.msg-actions \{ position: static;/);
  });
});

describe('ölü eylem yok', () => {
  it('metni olmayan mesajda (ör. yalnız sticker) "Metni kopyala" sunulmaz', () => {
    const view = render(MessageRenderer, { props: { message: message({ content: '' }) } });
    view.container.querySelector<HTMLElement>('article.msg')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    flushSync();
    const labels = within(document.querySelector<HTMLElement>('.mas-sheet')!).getAllByRole('menuitem').map((i) => i.textContent?.trim());
    expect(labels).not.toContain('Metni kopyala');
  });
});

describe('teslim edilemeyen mesaj — eylem listesinden "Sil"', () => {
  const openMenu = (container: HTMLElement) => {
    container.querySelector<HTMLElement>('article.msg')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    flushSync();
    return document.querySelector<HTMLElement>('.mas-sheet.anchored')!;
  };

  it('kendi başarısız mesajında tek "Sil" vardır ve giden kutusu kaydını ackId ile kaldırır (sunucu silmesi değil)', () => {
    const onDiscard = vi.fn();
    const onDelete = vi.fn();
    const view = render(MessageRenderer, { props: { message: message({ _id: 'pending:ack-9', ackId: 'ack-9', failed: true }), currentUserId: 'me', onReply: vi.fn(), onEdit: vi.fn(), onDelete, onDiscard } });
    const menu = openMenu(view.container);
    const labels = within(menu).getAllByRole('menuitem').map((i) => i.textContent?.trim());
    expect(labels).toEqual(['Metni kopyala', 'Sil']);
    within(menu).getByRole('menuitem', { name: 'Sil' }).dispatchEvent(withDetail('click', 0));
    expect(onDiscard).toHaveBeenCalledWith('ack-9');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('başkasının mesajında vazgeçme "Sil"i sunulmaz', () => {
    const view = render(MessageRenderer, { props: { message: message({ userId: 'other', ackId: 'ack-9', failed: true }), currentUserId: 'me', onDiscard: vi.fn() } });
    const labels = within(openMenu(view.container)).getAllByRole('menuitem').map((i) => i.textContent?.trim());
    expect(labels).not.toContain('Sil');
  });
});

describe('eylem sayfası — dokunmatik alt sayfa "İptal"', () => {
  it('bırakış tıklaması "İptal"e düşerse sayfa açık kalır; bilinçli dokunuş kapatır, eylem çalışmaz', () => {
    const onClose = vi.fn();
    const reply = action('reply');
    const { container } = render(MessageActionSheet, { props: { open: true, actions: [reply], onClose } });
    const cancel = container.querySelector<HTMLButtonElement>('.mas-cancel')!;
    cancel.dispatchEvent(withDetail('click', 1));
    expect(onClose).not.toHaveBeenCalled();
    cancel.dispatchEvent(pointer('pointerdown', { pointerType: 'touch' }));
    cancel.dispatchEvent(withDetail('click', 1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reply.run).not.toHaveBeenCalled();
  });
});
