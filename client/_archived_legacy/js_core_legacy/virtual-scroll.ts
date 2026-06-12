// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/VirtualScrollPanel.svelte
//              client/js/core/virtual-scroll-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/virtual-scroll.ts
// Sprint 95: IntersectionObserver + ResizeObserver ile gerçek yükseklik ölçümü
//
// Önceki sorun: ITEM_EST_H = 56px sabit tahmini spacer hesaplamalarını bozuyordu.
// Uzun mesajlar, embed'ler veya resimler için spacer çok kısa kalıyor, scroll
// pozisyonu kayıyordu.
//
// Düzeltme:
//   - Her mesaj DOM'dan çıkmadan önce gerçek offsetHeight ölçülüp _heights[]'e kaydedilir.
//   - ResizeObserver DOM'daki mesajların boyut değişimlerini (embed yüklenince vs.) izler.
//   - _topSpacerH, tahmini değer yerine _heights[] toplamıyla hesaplanır.
//   - Kanal değişiminde _heights temizlenir.

import { getCurrentChannel } from './globals.js';
import { BridgeRegistry }    from './bridge-registry.js';
import { createLogger }      from './logger.js';

const log = createLogger('VirtualScroll');

// ── Tip tanımları ──────────────────────────────────────────────────────────────

interface MessageEntry {
  id: string;
  el: HTMLElement;
}

interface Message {
  _id: string;
  [key: string]: unknown;
}

interface VSStats {
  total:        number;
  inDOM:        number;
  windowStart:  number;
  windowEnd:    number;
  topSpacerH:   number;
  avgHeight:    number;
}

// ── Sabitler ───────────────────────────────────────────────────────────────────

const WINDOW_SIZE    = 80;   // DOM'da aynı anda max mesaj
const LOAD_THRESHOLD = 120;  // px — üstte bu kadar kalınca eski yükle
const ITEM_EST_H     = 56;   // px — henüz ölçülmemiş mesaj için fallback

// ── State ──────────────────────────────────────────────────────────────────────

const _allMessages: MessageEntry[]       = [];  // en eski başta
const _heights:     Map<string, number>  = new Map(); // id → ölçülmüş yükseklik
let   _windowStart  = 0;
let   _windowEnd    = 0;
let   _topSpacerEl: HTMLDivElement | null = null;
let   _botSpacerEl: HTMLDivElement | null = null;
let   _ticking      = false;
let   _isPatched    = false;
let   _resizeObs:   ResizeObserver | null = null;

// ── Alan alıcı ─────────────────────────────────────────────────────────────────

function _getArea(): HTMLElement | null {
  return document.getElementById('messages-area');
}

// ── Yükseklik yardımcıları ─────────────────────────────────────────────────────

/** Mesajın gerçek yüksekliğini döner; henüz ölçülmemişse ITEM_EST_H. */
function _h(id: string, el?: HTMLElement): number {
  if (_heights.has(id)) return _heights.get(id)!;
  if (el) {
    const h = el.offsetHeight;
    if (h > 0) { _heights.set(id, h); return h; }
  }
  return ITEM_EST_H;
}

/** DOM'dan çıkmadan önce yüksekliği kaydet. */
function _measureBeforeRemove(entry: MessageEntry): void {
  const h = entry.el.offsetHeight;
  if (h > 0) _heights.set(entry.id, h);
}

/** [windowStart, windowEnd) aralığı dışındaki mesajların toplam yüksekliği. */
function _calcTopSpacerH(): number {
  let total = 0;
  for (let i = 0; i < _windowStart; i++) {
    total += _h(_allMessages[i].id, _allMessages[i].el);
  }
  return total;
}

// ── Spacer ─────────────────────────────────────────────────────────────────────

function _setTopSpacer(h: number): void {
  if (_topSpacerEl) _topSpacerEl.style.height = Math.max(0, h) + 'px';
}

// ── ResizeObserver — DOM'daki mesajlar için canlı yükseklik izleme ─────────────

function _startResizeObserver(): void {
  if (_resizeObs) return;
  if (typeof ResizeObserver === 'undefined') return;

  _resizeObs = new ResizeObserver((entries) => {
    let spacerDirty = false;
    for (const entry of entries) {
      const el  = entry.target as HTMLElement;
      const id  = el.id?.replace('msg-', '');
      if (!id) continue;
      const newH = Math.round(entry.contentRect.height + parseFloat(getComputedStyle(el).marginTop || '0') + parseFloat(getComputedStyle(el).marginBottom || '0'));
      if (newH > 0 && _heights.get(id) !== newH) {
        _heights.set(id, newH);
        // Eğer bu mesaj görünür pencere dışındaysa spacer'ı güncelle
        const idx = _allMessages.findIndex(m => m.id === id);
        if (idx !== -1 && idx < _windowStart) spacerDirty = true;
      }
    }
    if (spacerDirty) _setTopSpacer(_calcTopSpacerH());
  });
}

function _observeEl(el: HTMLElement): void {
  _resizeObs?.observe(el);
}

function _unobserveEl(el: HTMLElement): void {
  _resizeObs?.unobserve(el);
}

// ── Sıfırla ────────────────────────────────────────────────────────────────────

function _reset(): void {
  _allMessages.length = 0;
  _heights.clear();
  _windowStart = 0;
  _windowEnd   = 0;
  _topSpacerEl = null;
  _botSpacerEl = null;
}

// ── Spacer ve scroll listener kurulumu ────────────────────────────────────────

function _initVirtualScroll(area: HTMLElement): void {
  if (area.querySelector('.vs-top-spacer')) return;

  _topSpacerEl = document.createElement('div');
  _topSpacerEl.className = 'vs-top-spacer';
  _topSpacerEl.style.cssText = 'width:100%;flex-shrink:0;height:0;';
  area.insertBefore(_topSpacerEl, area.firstChild);

  _botSpacerEl = document.createElement('div');
  _botSpacerEl.className = 'vs-bot-spacer';
  _botSpacerEl.style.cssText = 'width:100%;height:0;flex-shrink:0;';
  area.appendChild(_botSpacerEl);

  area.addEventListener('scroll', _onScroll, { passive: true });
  _startResizeObserver();
}

// ── Scroll handler ─────────────────────────────────────────────────────────────

function _onScroll(): void {
  if (_ticking) return;
  _ticking = true;
  requestAnimationFrame(() => {
    _ticking = false;
    _adjustWindow();
    _checkLoadMore();
  });
}

// ── Pencere hesapla ve uygula ──────────────────────────────────────────────────

function _adjustWindow(): void {
  const area = _getArea();
  if (!area || _allMessages.length === 0) return;

  const total        = _allMessages.length;
  const scrollTop    = area.scrollTop;
  const scrollHeight = area.scrollHeight;
  const clientHeight = area.clientHeight;

  const scrollRatio  = scrollHeight > clientHeight
    ? scrollTop / (scrollHeight - clientHeight)
    : 1;

  const targetCenter = Math.round(scrollRatio * (total - 1));
  const half         = Math.floor(WINDOW_SIZE / 2);
  let newStart       = Math.max(0, targetCenter - half);
  let newEnd         = Math.min(total, newStart + WINDOW_SIZE);
  if (newEnd >= total) {
    newEnd   = total;
    newStart = Math.max(0, newEnd - WINDOW_SIZE);
  }

  if (newStart === _windowStart && newEnd === _windowEnd) return;
  _applyWindow(newStart, newEnd, area);
}

function _applyWindow(newStart: number, newEnd: number, area: HTMLElement): void {
  const oldStart = _windowStart;
  const oldEnd   = _windowEnd;

  // Üstten kaldır — yüksekliği ölç, sonra DOM'dan çıkar
  if (newStart > oldStart) {
    for (let i = oldStart; i < Math.min(newStart, oldEnd); i++) {
      const entry = _allMessages[i];
      if (entry.el.parentNode === area) {
        _measureBeforeRemove(entry);
        _unobserveEl(entry.el);
        area.removeChild(entry.el);
      }
    }
    _setTopSpacer(_calcTopSpacerH());
  }

  // Üste ekle (yukarı kaydırdı)
  if (newStart < oldStart) {
    const ref = _getFirstVisibleEl(area);
    for (let i = Math.min(oldStart, newEnd) - 1; i >= newStart; i--) {
      const entry = _allMessages[i];
      if (entry.el.parentNode !== area) {
        area.insertBefore(entry.el, ref ?? (_topSpacerEl?.nextSibling ?? null));
        _observeEl(entry.el);
      }
    }
    _setTopSpacer(_calcTopSpacerH());
  }

  // Alttan kaldır
  if (newEnd < oldEnd) {
    for (let i = newEnd; i < oldEnd; i++) {
      const entry = _allMessages[i];
      if (entry.el.parentNode === area) {
        _measureBeforeRemove(entry);
        _unobserveEl(entry.el);
        area.removeChild(entry.el);
      }
    }
  }

  // Alta ekle (aşağı kaydırdı)
  if (newEnd > oldEnd) {
    const before = (_botSpacerEl?.parentNode === area) ? _botSpacerEl : null;
    for (let i = Math.max(oldEnd, newStart); i < newEnd; i++) {
      const entry = _allMessages[i];
      if (entry.el.parentNode !== area) {
        before ? area.insertBefore(entry.el, before) : area.appendChild(entry.el);
        _observeEl(entry.el);
      }
    }
  }

  _windowStart = newStart;
  _windowEnd   = newEnd;
}

function _getFirstVisibleEl(area: HTMLElement): Node | null {
  let node: Node | null = _topSpacerEl ? _topSpacerEl.nextSibling : area.firstChild;
  while (node) {
    if (node !== _botSpacerEl && node.nodeType === 1) return node;
    node = node.nextSibling;
  }
  return null;
}

// ── Üstten yükleme tetikleyici ─────────────────────────────────────────────────

function _checkLoadMore(): void {
  const area = _getArea();
  if (!area) return;
  const channel = getCurrentChannel();
  if (
    area.scrollTop < LOAD_THRESHOLD &&
    !BridgeRegistry.get('loadingMoreMessages') &&
    !BridgeRegistry.get('noMoreMessages') &&
    BridgeRegistry.get('oldestMessageTimestamp') &&
    channel
  ) {
    const prevScrollH = area.scrollHeight;
    (BridgeRegistry.call('loadOlderMessages', channel._id) as Promise<void>)
      .then(() => { area.scrollTop += area.scrollHeight - prevScrollH; })
      .catch(() => { /* ignore */ });
  }
}

// ── Patch ──────────────────────────────────────────────────────────────────────

let _setupRetries = 0;
const _SETUP_MAX_RETRIES = 100;

function _setup(): void {
  if (typeof BridgeRegistry.get('renderMessage') !== 'function') {
    if (++_setupRetries > _SETUP_MAX_RETRIES) {
      log.warn('[VirtualScroll] renderMessage yüklenemedi, virtual scroll devre dışı.');
      return;
    }
    setTimeout(_setup, 50);
    return;
  }
  if (_isPatched) return;
  _isPatched = true;

  const _origRender    = BridgeRegistry.get('renderMessage') as (msg: Message, cont: boolean) => void;
  const _origLoadOlder = BridgeRegistry.get('loadOlderMessages') as (id: string) => Promise<void>;

  // ── renderMessage patch ──────────────────────────────────────────────────────
  BridgeRegistry.register('renderMessage', function (msg: Message, isContinuation: boolean) {
    if (_allMessages.some(m => m.id === msg._id)) return;

    const area = _getArea();
    if (!area) { _origRender(msg, isContinuation); return; }

    let capturedEl: HTMLElement | null = null;
    const realAppend = area.appendChild.bind(area) as typeof area.appendChild;
    (area as unknown as { appendChild: (el: Node) => Node }).appendChild = function (el: Node) {
      if (el === _topSpacerEl || el === _botSpacerEl) return realAppend(el as HTMLElement);
      capturedEl = el as HTMLElement;
      (area as unknown as { appendChild: (el: Node) => Node }).appendChild = realAppend as unknown as (el: Node) => Node;
      return el;
    };

    _origRender(msg, isContinuation);
    (area as unknown as { appendChild: (el: Node) => Node }).appendChild = realAppend as unknown as (el: Node) => Node;

    if (!capturedEl) return;

    const entry: MessageEntry = { id: msg._id, el: capturedEl };
    _allMessages.push(entry);
    const idx = _allMessages.length - 1;

    if (idx >= _windowStart) {
      _windowEnd = idx + 1;
      if (_windowEnd - _windowStart > WINDOW_SIZE) {
        const oldest = _allMessages[_windowStart];
        if (oldest.el.parentNode === area) {
          _measureBeforeRemove(oldest);
          _unobserveEl(oldest.el);
          area.removeChild(oldest.el);
        }
        _windowStart++;
        _setTopSpacer(_calcTopSpacerH());
      }
      const before = (_botSpacerEl?.parentNode === area) ? _botSpacerEl : null;
      before ? area.insertBefore(capturedEl, before) : realAppend(capturedEl);
      // Yüksekliği bir sonraki frame'de ölç (layout henüz tamamlanmamış olabilir)
      requestAnimationFrame(() => {
        const h = capturedEl!.offsetHeight;
        if (h > 0) _heights.set(msg._id, h);
        _observeEl(capturedEl!);
      });
    }
  });

  // ── loadOlderMessages patch ──────────────────────────────────────────────────
  BridgeRegistry.register('loadOlderMessages', async function (channelId: string) {
    const area = _getArea();
    if (!area) return _origLoadOlder(channelId);

    const capturedEls: HTMLElement[] = [];
    const origInsertBefore = area.insertBefore.bind(area);

    (area as unknown as { insertBefore: (node: Node, ref: Node | null) => Node }).insertBefore = function (node: Node, ref: Node | null) {
      if (node instanceof DocumentFragment) {
        [...node.children].forEach(el => capturedEls.push(el as HTMLElement));
        while (node.firstChild) node.removeChild(node.firstChild);
        return node;
      }
      if (node === _topSpacerEl || node === _botSpacerEl) return origInsertBefore(node as HTMLElement, ref as HTMLElement | null);
      capturedEls.unshift(node as HTMLElement);
      return node;
    };

    await _origLoadOlder(channelId);
    (area as unknown as { insertBefore: typeof origInsertBefore }).insertBefore = origInsertBefore;

    if (!capturedEls.length) return;

    const newEntries: MessageEntry[] = capturedEls.map(el => ({
      id: (el.id || '').replace('msg-', '') || ('old-' + Math.random()),
      el,
    }));

    _allMessages.unshift(...newEntries);
    _windowStart += newEntries.length;
    _windowEnd   += newEntries.length;

    // Tahmini değer yerine mevcut ölçümleri kullan
    _setTopSpacer(_calcTopSpacerH());
  });

  // ── initInfiniteScroll patch ─────────────────────────────────────────────────
  BridgeRegistry.register('initInfiniteScroll', function () {
    const area = _getArea();
    if (area) _initVirtualScroll(area);
  });

  const area = _getArea();
  if (area) _initVirtualScroll(area);

  // ── scrollToMsg override ─────────────────────────────────────────────────────
  const _origScrollToMsg = BridgeRegistry.get('scrollToMsg') as ((id: string) => void) | undefined;
  BridgeRegistry.register('scrollToMsg', function (msgId: string) {
    const idx = _allMessages.findIndex(m => m.id === msgId);
    if (idx === -1) { _origScrollToMsg?.(msgId); return; }

    const area = _getArea();
    if (!area) return;

    if (idx < _windowStart || idx >= _windowEnd) {
      const newStart = Math.max(0, idx - Math.floor(WINDOW_SIZE / 2));
      const newEnd   = Math.min(_allMessages.length, newStart + WINDOW_SIZE);
      _applyWindow(newStart, newEnd, area);
    }

    const el = _allMessages[idx].el;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.classList.add('msg-highlight');
    setTimeout(() => el?.classList.remove('msg-highlight'), 1500);
  });
}

// ── Kanal değişimini izle ──────────────────────────────────────────────────────

function _watchChannelChange(): void {
  const area = _getArea();
  if (!area) { setTimeout(_watchChannelChange, 200); return; }

  const observer = new MutationObserver(() => {
    const a = _getArea();
    if (!a) return;
    const nonSpacer = [...a.children].filter(
      el => !el.classList.contains('vs-top-spacer') && !el.classList.contains('vs-bot-spacer'),
    );
    if (nonSpacer.length === 0 || (nonSpacer.length === 1 && nonSpacer[0].classList.contains('channel-welcome'))) {
      _reset();
      _initVirtualScroll(a);
    }
  });

  observer.observe(area.parentNode ?? document.body, { childList: true, subtree: false });
  observer.observe(area, { childList: true });
}

// ── Başlat ─────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { _setup(); _watchChannelChange(); });
} else {
  _setup();
  _watchChannelChange();
}

// ── Debug API ──────────────────────────────────────────────────────────────────

BridgeRegistry.register('_bridgeVS', () => ({
  stats: (): VSStats => {
    const measured = _heights.size;
    const avgHeight = measured > 0
      ? [..._heights.values()].reduce((a, b) => a + b, 0) / measured
      : ITEM_EST_H;
    return {
      total:       _allMessages.length,
      inDOM:       _windowEnd - _windowStart,
      windowStart: _windowStart,
      windowEnd:   _windowEnd,
      topSpacerH:  _topSpacerEl ? parseFloat(_topSpacerEl.style.height) : 0,
      avgHeight:   Math.round(avgHeight),
    };
  },
  reset: _reset,
  dump:  () => _allMessages.map(m => ({ id: m.id, h: _heights.get(m.id) ?? null })),
}));

export const virtualScrollReady = true;
