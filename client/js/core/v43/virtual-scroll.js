// client/js/core/v43/virtual-scroll.js (tam yeniden yazım)
//
// Strateji: "DOM penceresi" yaklaşımı
//   - Tüm mesajlar bir in-memory dizisinde tutulur (_allMessages[])
//   - DOM'a sadece görünen pencere (WINDOW_SIZE) kadar mesaj render edilir
//   - Yukarı/aşağı kaydırınca pencere kayar, eski DOM node'ları kaldırılır
//   - Silinen node'ların yüksekliği üst spacer div ile korunur
//     (scroll pozisyonu atlamasın diye)
//
// Entegrasyon: messages.js'teki renderMessage, loadOlderMessages ve
//   initInfiniteScroll fonksiyonlarını monkey-patch eder.

'use strict';
import { getCurrentChannel } from '../globals.js';

(function () {

  // ─── Sabitler ──────────────────────────────────────────────
  const WINDOW_SIZE    = 80;   // DOM'da aynı anda max mesaj
  const LOAD_THRESHOLD = 120;  // px — üstte bu kadar kalınca eski yükle
  const ITEM_EST_H     = 56;   // px — mesaj yüksekliği tahmini

  // ─── State ─────────────────────────────────────────────────
  const _allMessages = [];     // { id, el } — en eski başta
  let _windowStart   = 0;
  let _windowEnd     = 0;
  let _topSpacerEl   = null;
  let _botSpacerEl   = null;
  let _topSpacerH    = 0;
  let _ticking       = false;
  let _isPatched     = false;

  // ─── Alan alıcı ────────────────────────────────────────────
  function _getArea() {
    return document.getElementById('messages-area');
  }

  // ─── Spacer ────────────────────────────────────────────────
  function _setTopSpacer(h) {
    _topSpacerH = Math.max(0, h);
    if (_topSpacerEl) _topSpacerEl.style.height = _topSpacerH + 'px';
  }

  // ─── Sıfırla ────────────────────────────────────────────────
  function _reset() {
    _allMessages.length = 0;
    _windowStart = 0;
    _windowEnd   = 0;
    _topSpacerH  = 0;
    _topSpacerEl = null;
    _botSpacerEl = null;
  }

  // ─── Spacer ve scroll listener kurulumu ────────────────────
  function _initVirtualScroll(area) {
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
  }

  // ─── Scroll handler ────────────────────────────────────────
  function _onScroll() {
    if (_ticking) return;
    _ticking = true;
    requestAnimationFrame(() => {
      _ticking = false;
      _adjustWindow();
      _checkLoadMore();
    });
  }

  // ─── Pencere hesapla ve uygula ──────────────────────────────
  function _adjustWindow() {
    const area = _getArea();
    if (!area || _allMessages.length === 0) return;

    const total = _allMessages.length;
    const scrollTop    = area.scrollTop;
    const scrollHeight = area.scrollHeight;
    const clientHeight = area.clientHeight;

    const scrollRatio = scrollHeight > clientHeight
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

  function _applyWindow(newStart, newEnd, area) {
    const oldStart = _windowStart;
    const oldEnd   = _windowEnd;

    // Üstten kaldır
    if (newStart > oldStart) {
      for (let i = oldStart; i < Math.min(newStart, oldEnd); i++) {
        const el = _allMessages[i].el;
        if (el.parentNode === area) {
          _topSpacerH += el.offsetHeight || ITEM_EST_H;
          area.removeChild(el);
        }
      }
      _setTopSpacer(_topSpacerH);
    }

    // Üste ekle (yukarı kaydırdı)
    if (newStart < oldStart) {
      let addedH = 0;
      const ref = _getFirstVisibleEl(area);
      for (let i = Math.min(oldStart, newEnd) - 1; i >= newStart; i--) {
        const el = _allMessages[i].el;
        if (el.parentNode !== area) {
          area.insertBefore(el, ref || (_topSpacerEl ? _topSpacerEl.nextSibling : null));
          addedH += el.offsetHeight || ITEM_EST_H;
        }
      }
      _topSpacerH = Math.max(0, _topSpacerH - addedH);
      _setTopSpacer(_topSpacerH);
    }

    // Alttan kaldır
    if (newEnd < oldEnd) {
      for (let i = newEnd; i < oldEnd; i++) {
        const el = _allMessages[i].el;
        if (el.parentNode === area) area.removeChild(el);
      }
    }

    // Alta ekle (aşağı kaydırdı)
    if (newEnd > oldEnd) {
      const before = (_botSpacerEl && _botSpacerEl.parentNode === area) ? _botSpacerEl : null;
      for (let i = Math.max(oldEnd, newStart); i < newEnd; i++) {
        const el = _allMessages[i].el;
        if (el.parentNode !== area) {
          before ? area.insertBefore(el, before) : area.appendChild(el);
        }
      }
    }

    _windowStart = newStart;
    _windowEnd   = newEnd;
  }

  function _getFirstVisibleEl(area) {
    let node = _topSpacerEl ? _topSpacerEl.nextSibling : area.firstChild;
    while (node) {
      if (node !== _botSpacerEl && node.nodeType === 1) return node;
      node = node.nextSibling;
    }
    return null;
  }

  // ─── Üstten yükleme tetikleyici ─────────────────────────────
  function _checkLoadMore() {
    const area = _getArea();
    if (!area) return;
    if (area.scrollTop < LOAD_THRESHOLD &&
        !window.loadingMoreMessages &&
        !window.noMoreMessages &&
        window.oldestMessageTimestamp &&
        getCurrentChannel()) {
      const prevScrollH = area.scrollHeight;
      window.loadOlderMessages(getCurrentChannel()._id).then(() => {
        // Scroll pozisyonunu koru
        const added = area.scrollHeight - prevScrollH;
        area.scrollTop = area.scrollTop + added;
      }).catch(() => {
      });
    }
  }

  // ─── Patch ─────────────────────────────────────────────────
  let _setupRetries = 0;
  const _SETUP_MAX_RETRIES = 100; // 5 saniye (100 × 50ms)

  function _setup() {
    if (typeof window.renderMessage !== 'function') {
      if (++_setupRetries > _SETUP_MAX_RETRIES) {
        console.warn('[VirtualScroll] renderMessage yüklenemedi, virtual scroll devre dışı.');
        return;
      }
      setTimeout(_setup, 50);
      return;
    }
    if (_isPatched) return;
    _isPatched = true;

    const _origRender      = window.renderMessage;
    const _origLoadOlder   = window.loadOlderMessages;
    const _origInitScroll  = window.initInfiniteScroll;

    // ── renderMessage patch ─────────────────────────────────
    // Yeni gelen mesajı buffer'a ekle, gerekirse DOM'a yaz
    window.renderMessage = function (msg, isContinuation) {
      if (_allMessages.some(m => m.id === msg._id)) return;

      const area = _getArea();
      if (!area) { _origRender(msg, isContinuation); return; }

      // messages.js area.appendChild ile el ekler — onu yakala
      let capturedEl = null;
      const realAppend = area.appendChild.bind(area);
      area.appendChild = function (el) {
        if (el === _topSpacerEl || el === _botSpacerEl) return realAppend(el);
        capturedEl = el;
        area.appendChild = realAppend; // hemen restore
        return el; // DOM'a ekleme — biz yöneteceğiz
      };

      _origRender(msg, isContinuation);
      area.appendChild = realAppend; // her halükarda restore

      if (!capturedEl) return; // zaten engellendi

      const entry = { id: msg._id, el: capturedEl };
      _allMessages.push(entry);
      const idx = _allMessages.length - 1;

      // Pencerede son mesajlardan biriyse DOM'a ekle
      if (idx >= _windowStart) {
        _windowEnd = idx + 1;
        if (_windowEnd - _windowStart > WINDOW_SIZE) {
          // Pencere doldu — en üstteki mesajı kaldır
          const oldest = _allMessages[_windowStart];
          if (oldest.el.parentNode === area) {
            _topSpacerH += oldest.el.offsetHeight || ITEM_EST_H;
            area.removeChild(oldest.el);
          }
          _windowStart++;
          _setTopSpacer(_topSpacerH);
        }
        // Bot spacer'dan önce ekle
        const before = (_botSpacerEl && _botSpacerEl.parentNode === area) ? _botSpacerEl : null;
        before ? area.insertBefore(capturedEl, before) : realAppend(capturedEl);
      }
      // Pencere dışındaysa buffer'da tut, DOM'a ekleme
    };

    // ── loadOlderMessages patch ─────────────────────────────
    // Eski mesajları buffer başına ekle, yüksekliği spacer'a yaz
    window.loadOlderMessages = async function (channelId) {
      const area = _getArea();
      if (!area) return _origLoadOlder(channelId);

      const capturedEls = [];
      const origInsertBefore = area.insertBefore.bind(area);

      area.insertBefore = function (node, ref) {
        if (node instanceof DocumentFragment) {
          [...node.children].forEach(el => capturedEls.push(el));
          while (node.firstChild) node.removeChild(node.firstChild);
          return node;
        }
        if (node === _topSpacerEl || node === _botSpacerEl) {
          return origInsertBefore(node, ref);
        }
        // Tekil el — eski mesaj
        capturedEls.unshift(node);
        return node;
      };

      await _origLoadOlder(channelId);
      area.insertBefore = origInsertBefore;

      if (capturedEls.length === 0) return;

      // Buffer başına ekle — eski mesajlar en başa
      const newEntries = capturedEls.map(el => ({
        id: (el.id || '').replace('msg-', '') || ('old-' + Math.random()),
        el,
      }));

      _allMessages.unshift(...newEntries);
      _windowStart += newEntries.length;
      _windowEnd   += newEntries.length;

      // Yükseklikleri spacer'a yaz (henüz DOM'da değiller)
      const addedH = newEntries.length * ITEM_EST_H;
      _setTopSpacer(_topSpacerH + addedH);
    };

    // ── initInfiniteScroll patch ────────────────────────────
    // Orijinal scroll listener'ı devre dışı bırak — biz yönetiyoruz
    window.initInfiniteScroll = function () {
      const area = _getArea();
      if (area) _initVirtualScroll(area);
      // Orijinalin scroll listener'ını ÇAĞIRMA — duplicate olur
    };

    // Eğer area varsa hemen kur
    const area = _getArea();
    if (area) _initVirtualScroll(area);

    console.log('[VirtualScroll] v51 aktif | pencere:', WINDOW_SIZE, '| eşik:', LOAD_THRESHOLD + 'px');
  }

  // ─── scrollToMsg override ────────────────────────────────
  // Reply'e tıklanınca mesaj pencere dışındaysa pencereyi taşı
  const _origScrollToMsg = window.scrollToMsg;
  window.scrollToMsg = function (msgId) {
    const idx = _allMessages.findIndex(m => m.id === msgId);
    if (idx === -1) return _origScrollToMsg?.(msgId);

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
  };

  // ─── Kanal değişimini izle ──────────────────────────────────
  // messages.js kanal değişince area.innerHTML = '' yapıyor
  // Bunu MutationObserver ile yakala
  function _watchChannelChange() {
    const area = _getArea();
    if (!area) { setTimeout(_watchChannelChange, 200); return; }

    const observer = new MutationObserver(() => {
      const a = _getArea();
      if (!a) return;
      // Spacer'lar dışında hiçbir şey kalmadıysa → kanal değişti
      const nonSpacer = [...a.children].filter(
        el => !el.classList.contains('vs-top-spacer') && !el.classList.contains('vs-bot-spacer')
      );
      if (nonSpacer.length === 0 || (nonSpacer.length === 1 && nonSpacer[0].classList.contains('channel-welcome'))) {
        _reset();
        _initVirtualScroll(a);
      }
    });

    observer.observe(area.parentNode || document.body, { childList: true, subtree: false });
    // area'nın kendisini de izle
    observer.observe(area, { childList: true });
  }

  // ─── Başlat ─────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { _setup(); _watchChannelChange(); });
  } else {
    _setup();
    _watchChannelChange();
  }

  // ─── Debug API ───────────────────────────────────────────────
  window._bridgeVS = {
    stats: () => ({
      total: _allMessages.length,
      inDOM: _windowEnd - _windowStart,
      windowStart: _windowStart,
      windowEnd: _windowEnd,
      topSpacerH: _topSpacerH,
    }),
    reset: _reset,
    dump:  () => _allMessages.map(m => m.id),
  };

})();
