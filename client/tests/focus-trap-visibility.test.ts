// client/tests/focus-trap-visibility.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// a11y/focusTrap.ts — GÖRÜNÜRLÜK KALITIMI VE TEPE TUZAK OTORİTESİ
// ════════════════════════════════════════════════════════════════════════════
// `focus-trap.test.ts` sarmalama ve odak iadesi sözleşmesini ölçer. Bu dosya,
// ölçülmemiş kalan iki sınıfı kapatır:
//
//   1. GÖRÜNÜRLÜĞÜN KALITIMI — bir kontrol KENDİSİ görünür olabilir ama gizli
//      bir ATA içinde bulunabilir (`hidden`, `aria-hidden`, `inert`,
//      `display:none`, `visibility:hidden`). Böyle bir kontrole Tab ile
//      ulaşılması, ekran okuyucudan gizlenmiş bir alanı klavye kullanıcısına
//      açık bırakır. Sekme sırası ile erişilebilirlik ağacı ayrışamaz.
//
//   2. TEPE TUZAK OTORİTESİ — odak koruması yalnız yığının TEPESİ için
//      uygulanır ve düğüm DOM'dan koptuğunda hiç uygulanmaz. Aksi hâlde
//      sökülmüş bir modal, canlı sayfadan odağı çalmaya devam ederdi.
import { describe, it, expect, afterEach } from 'vitest';
import { focusTrap, getFocusable, _activeTrapCount } from '../js/core/a11y/focusTrap.ts';

const handles: Array<{ destroy(): void }> = [];

function trap(node: HTMLElement, options: Parameters<typeof focusTrap>[1] = {}) {
  const handle = focusTrap(node, options);
  handles.push(handle);
  return handle;
}

function dialog(html: string): HTMLElement {
  const node = document.createElement('div');
  node.innerHTML = html;
  document.body.appendChild(node);
  return node;
}

afterEach(() => {
  while (handles.length) handles.pop()!.destroy();
  document.body.innerHTML = '';
});

describe('focusable discovery inherits ancestor visibility', () => {
  it('excludes a control nested inside a hidden, aria-hidden or inert ancestor', () => {
    const node = dialog(`
      <button id="visible">ok</button>
      <div hidden><button id="in-hidden">no</button></div>
      <div aria-hidden="true"><button id="in-aria-hidden">no</button></div>
      <div inert><button id="in-inert">no</button></div>
    `);
    expect(getFocusable(node).map(el => el.id)).toEqual(['visible']);
  });

  it('excludes a control whose own computed style removes it from the layout', () => {
    // NOT: jsdom düzen (layout) hesaplamaz, bu yüzden `display` KALITIMI
    // yalnız gerçek tarayıcıda görülür. Burada ölçülen, öğenin KENDİ hesaplanan
    // stilinin sekme sırasından çıkarılmasıdır — `hidden`/`inert` kalıtımı ise
    // yukarıdaki testte ayrıca kanıtlanır.
    const node = dialog(`
      <button id="visible">ok</button>
      <button id="display-none" style="display:none">no</button>
      <button id="visibility-hidden" style="visibility:hidden">no</button>
    `);
    expect(getFocusable(node).map(el => el.id)).toEqual(['visible']);
  });

  it('moves initial focus past a preferred target that is hidden by an ancestor', () => {
    const node = dialog(`
      <div hidden><input id="preferred" /></div>
      <button id="fallback">ok</button>
    `);
    trap(node, { initialFocus: '#preferred' });
    expect(document.activeElement).toBe(node.querySelector('#fallback'));
  });
});

describe('top-of-stack authority', () => {
  it('ignores a focus escape once the trapped node has left the document', () => {
    const outside = document.createElement('button');
    outside.id = 'outside';
    document.body.appendChild(outside);

    const node = dialog('<button id="inside">ok</button>');
    trap(node);
    expect(document.activeElement).toBe(node.querySelector('#inside'));

    // Düğüm koptuğunda tuzak SESSİZLEŞİR: sökülmüş bir modal canlı sayfadan
    // odağı geri çalmamalıdır.
    node.remove();
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });

  it('arms and disarms through the action lifecycle without leaking stack entries', () => {
    const outside = document.createElement('button');
    outside.id = 'outside';
    document.body.appendChild(outside);
    outside.focus();

    const node = dialog('<button id="inside">ok</button>');
    const before = _activeTrapCount();
    const handle = trap(node, { active: false });
    // Pasif başlayan bir tuzak odağı HİÇ hareket ettirmez.
    expect(_activeTrapCount()).toBe(before);
    expect(document.activeElement).toBe(outside);

    handle.update({ active: true });
    expect(_activeTrapCount()).toBe(before + 1);
    expect(document.activeElement).toBe(node.querySelector('#inside'));

    // Tekrar etkin istemek yığını BÜYÜTMEZ; aksi hâlde tek bir `destroy()`
    // tuzağı kaldıramaz ve odak kalıcı olarak hapsolurdu.
    handle.update({ active: true });
    expect(_activeTrapCount()).toBe(before + 1);

    handle.update({ active: false });
    expect(_activeTrapCount()).toBe(before);
    expect(document.activeElement).toBe(outside);
    handle.update({ active: false });
    expect(_activeTrapCount()).toBe(before);
  });

  it('wraps to the last control when Tab arrives while focus sits outside the trap', () => {
    const outside = document.createElement('button');
    outside.id = 'outside';
    document.body.appendChild(outside);

    const node = dialog('<button id="first">a</button><button id="last">b</button>');
    trap(node);

    // Odak koruması kapalı olsa bile Shift+Tab dışarıdan gelirse SON kontrole
    // sarılır — odak arka plana kaçamaz.
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => outside });
    const shift = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    node.dispatchEvent(shift);
    expect(shift.defaultPrevented).toBe(true);

    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    node.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    delete (document as unknown as Record<string, unknown>).activeElement;
  });
});
