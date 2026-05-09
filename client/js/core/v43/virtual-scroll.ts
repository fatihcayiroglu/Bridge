// client/js/core/v43/virtual-scroll.js (tam yeniden yazÄ±m)
//
// Strateji: "DOM penceresi" yaklaÅŸÄ±mÄ±
//   - TÃ¼m mesajlar bir in-memory dizisinde tutulur (_allMessages[])
//   - DOM'a sadece gÃ¶rÃ¼nen pencere (WINDOW_SIZE) kadar mesaj render edilir
//   - YukarÄ±/aÅŸaÄŸÄ± kaydÄ±rÄ±nca pencere kayar, eski DOM node'larÄ± kaldÄ±rÄ±lÄ±r
//   - Silinen node'larÄ±n yÃ¼ksekliÄŸi Ã¼st spacer div ile korunur
//     (scroll pozisyonu atlamasÄ±n diye)
//
// Entegrasyon: messages.js'teki renderMessage, loadOlderMessages ve
//   initInfiniteScroll fonksiyonlarÄ±nÄ± monkey-patch eder.

'use strict';

(function () {

  // â”€â”€â”€ Sabitler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const WINDOW_SIZE    = 80;   // DOM'da aynÄ± anda max mesaj
  const LOAD_THRESHOLD = 120;  // px â€” Ã¼stte bu kadar kalÄ±nca eski yÃ¼kle
  const ITEM_EST_H     = 56;   // px â€” mesaj yÃ¼ksekliÄŸi tahmini

  // â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const _allMessages = [];     // { id, el } â€” en eski baÅŸta
  let _windowStart   = 0;
  let _windowEnd     = 0;
  let _topSpacerEl   = null;
  let _botSpacerEl   = null;
  let _topSpacerH    = 0;
  let _ticking       = false;
  let _isPatched     = false;

  // â”€â”€â”€ Alan alÄ±cÄ± â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _getArea() {
    return document.getElementById('messages-area');
  }

  // â”€â”€â”€ Spacer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _setTopSpacer(h) {
    _topSpacerH = Math.max(0, h);
    if (_topSpacerEl) _topSpacerEl.style.height = _topSpacerH + 'px';
  }

  // â”€â”€â”€ SÄ±fÄ±rla â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _reset() {
    _allMessages.length = 0;
    _windowStart = 0;
    _windowEnd   = 0;
    _topSpacerH  = 0;
    _topSpacerEl = null;
    _botSpacerEl = null;
  }

  // â”€â”€â”€ Spacer ve scroll listener kurulumu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€â”€ Scroll handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _onScroll() {
    if (_ticking) return;
    _ticking = true;
    requestAnimationFrame(() => {
      _ticking = false;
      _adjustWindow();
      _checkLoadMore();
    });
  }

  // â”€â”€â”€ Pencere hesapla ve uygula â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // Ãœstten kaldÄ±r
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

    // Ãœste ekle (yukarÄ± kaydÄ±rdÄ±)
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

    // Alttan kaldÄ±r
    if (newEnd < oldEnd) {
      for (let i = newEnd; i < oldEnd; i++) {
        const el = _allMessages[i].el;
        if (el.parentNode === area) area.removeChild(el);
      }
    }

    // Alta ekle (aÅŸaÄŸÄ± kaydÄ±rdÄ±)
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

  // â”€â”€â”€ Ãœstten yÃ¼kleme tetikleyici â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _checkLoadMore() {
    const area = _getArea();
    if (!area) return;
    if (area.scrollTop < LOAD_THRESHOLD &&
        !window.loadingMoreMessages &&
        !window.noMoreMessages &&
        window.oldestMessageTimestamp &&
        window.currentChannel) {
      window.loadingMoreMessages = true;
      const prevScrollH = area.scrollHeight;
      window.loadOlderMessages(window.currentChannel._id).then(() => {
        // Scroll pozisyonunu koru
        const added = area.scrollHeight - prevScrollH;
        area.scrollTop = area.scrollTop + added;
        window.loadingMoreMessages = false;
      }).catch(() => {
        window.loadingMoreMessages = false;
      });
    }
  }

  // â”€â”€â”€ Patch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let _setupRetries = 0;
  const _SETUP_MAX_RETRIES = 100; // 5 saniye (100 Ã— 50ms)

  function _setup() {
    if (typeof window.renderMessage !== 'function') {
      if (++_setupRetries > _SETUP_MAX_RETRIES) {
        console.warn('[VirtualScroll] renderMessage yÃ¼klenemedi, virtual scroll devre dÄ±ÅŸÄ±.');
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

    // â”€â”€ renderMessage patch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Yeni gelen mesajÄ± buffer'a ekle, gerekirse DOM'a yaz
    window.renderMessage = function (msg, isContinuation) {
      if (_allMessages.some(m => m.id === msg._id)) return;

      const area = _getArea();
      if (!area) { _origRender(msg, isContinuation); return; }

      // messages.js area.appendChild ile el ekler â€” onu yakala
      let capturedEl = null;
      const realAppend = area.appendChild.bind(area);
      area.appendChild = function (el) {
        if (el === _topSpacerEl || el === _botSpacerEl) return realAppend(el);
        capturedEl = el;
        area.appendChild = realAppend; // hemen restore
        return el; // DOM'a ekleme â€” biz yÃ¶neteceÄŸiz
      };

      _origRender(msg, isContinuation);
      area.appendChild = realAppend; // her halÃ¼karda restore

      if (!capturedEl) return; // zaten engellendi

      const entry = { id: msg._id, el: capturedEl };
      _allMessages.push(entry);
      const idx = _allMessages.length - 1;

      // Pencerede son mesajlardan biriyse DOM'a ekle
      if (idx >= _windowStart) {
        _windowEnd = idx + 1;
        if (_windowEnd - _windowStart > WINDOW_SIZE) {
          // Pencere doldu â€” en Ã¼stteki mesajÄ± kaldÄ±r
          const oldest = _allMessages[_windowStart];
          if (oldest.el.parentNode === area) {
            _topSpacerH += oldest.el.offsetHeight || ITEM_EST_H;
            area.removeChild(oldest.el);
          }
          _windowStart++;
          _setTopSpacer(_topSpacerH);
        }
        // Bot spacer'dan Ã¶nce ekle
        const before = (_botSpacerEl && _botSpacerEl.parentNode === area) ? _botSpacerEl : null;
        before ? area.insertBefore(capturedEl, before) : realAppend(capturedEl);
      }
      // Pencere dÄ±ÅŸÄ±ndaysa buffer'da tut, DOM'a ekleme
    };

    // â”€â”€ loadOlderMessages patch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Eski mesajlarÄ± buffer baÅŸÄ±na ekle, yÃ¼ksekliÄŸi spacer'a yaz
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
        // Tekil el â€” eski mesaj
        capturedEls.unshift(node);
        return node;
      };

      await _origLoadOlder(channelId);
      area.insertBefore = origInsertBefore;

      if (capturedEls.length === 0) return;

      // Buffer baÅŸÄ±na ekle â€” eski mesajlar en baÅŸa
      const newEntries = capturedEls.map(el => ({
        id: (el.id || '').replace('msg-', '') || ('old-' + Math.random()),
        el,
      }));

      _allMessages.unshift(...newEntries);
      _windowStart += newEntries.length;
      _windowEnd   += newEntries.length;

      // YÃ¼kseklikleri spacer'a yaz (henÃ¼z DOM'da deÄŸiller)
      const addedH = newEntries.length * ITEM_EST_H;
      _setTopSpacer(_topSpacerH + addedH);
    };

    // â”€â”€ initInfiniteScroll patch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Orijinal scroll listener'Ä± devre dÄ±ÅŸÄ± bÄ±rak â€” biz yÃ¶netiyoruz
    window.initInfiniteScroll = function () {
      const area = _getArea();
      if (area) _initVirtualScroll(area);
      // Orijinalin scroll listener'Ä±nÄ± Ã‡AÄIRMA â€” duplicate olur
    };

    // EÄŸer area varsa hemen kur
    const area = _getArea();
    if (area) _initVirtualScroll(area);

    console.log('[VirtualScroll] v51 aktif | pencere:', WINDOW_SIZE, '| eÅŸik:', LOAD_THRESHOLD + 'px');
  }

  // â”€â”€â”€ scrollToMsg override â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Reply'e tÄ±klanÄ±nca mesaj pencere dÄ±ÅŸÄ±ndaysa pencereyi taÅŸÄ±
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

  // â”€â”€â”€ Kanal deÄŸiÅŸimini izle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // messages.js kanal deÄŸiÅŸince area.innerHTML = '' yapÄ±yor
  // Bunu MutationObserver ile yakala
  function _watchChannelChange() {
    const area = _getArea();
    if (!area) { setTimeout(_watchChannelChange, 200); return; }

    const observer = new MutationObserver(() => {
      const a = _getArea();
      if (!a) return;
      // Spacer'lar dÄ±ÅŸÄ±nda hiÃ§bir ÅŸey kalmadÄ±ysa â†’ kanal deÄŸiÅŸti
      const nonSpacer = [...a.children].filter(
        el => !el.classList.contains('vs-top-spacer') && !el.classList.contains('vs-bot-spacer')
      );
      if (nonSpacer.length === 0 || (nonSpacer.length === 1 && nonSpacer[0].classList.contains('channel-welcome'))) {
        _reset();
        _initVirtualScroll(a);
      }
    });

    observer.observe(area.parentNode || document.body, { childList: true, subtree: false });
    // area'nÄ±n kendisini de izle
    observer.observe(area, { childList: true });
  }

  // â”€â”€â”€ BaÅŸlat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { _setup(); _watchChannelChange(); });
  } else {
    _setup();
    _watchChannelChange();
  }

  // â”€â”€â”€ Debug API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

