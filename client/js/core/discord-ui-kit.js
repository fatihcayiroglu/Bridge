// client/js/core/discord-ui-kit.js
// Bridge Design System — UI bileşen kütüphanesi
// Butonlar, Select menüler, Badge, Tooltip, Divider, Switch, Modal aksiyonları
// Tüm bileşenler Bridge CSS token'larını kullanır (tokens.css) — temayı destekler
// NOT: Bu dosya Discord'dan tamamen bağımsız Bridge özel tasarım sistemidir.

'use strict';

/* ══════════════════════════════════════════════════════════════
   BUTON BİLEŞENİ
   Kullanım: BridgeUI.button({ label, style, emoji, disabled, onClick })
   style: 'primary' | 'secondary' | 'danger' | 'success' | 'link' | 'ghost'
══════════════════════════════════════════════════════════════ */
const BridgeUIButton = {
  create({ label = '', style = 'secondary', emoji = '', disabled = false, onClick = null, size = 'md', id = '' } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (id) btn.id = id;
    btn.className = `dui-btn dui-btn--${style} dui-btn--${size}`;
    btn.disabled = disabled;
    if (disabled) btn.setAttribute('aria-disabled', 'true');

    const inner = document.createElement('span');
    inner.className = 'dui-btn__inner';
    if (emoji) {
      const em = document.createElement('span');
      em.className = 'dui-btn__emoji';
      em.textContent = emoji;
      em.setAttribute('aria-hidden', 'true');
      inner.appendChild(em);
    }
    const txt = document.createElement('span');
    txt.textContent = label;
    inner.appendChild(txt);
    btn.appendChild(inner);

    // Ripple efekti
    btn.addEventListener('pointerdown', (e) => {
      if (disabled) return;
      const rect = btn.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'dui-btn__ripple';
      const size = Math.max(rect.width, rect.height);
      ripple.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
      btn.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    });

    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  },
};

/* ══════════════════════════════════════════════════════════════
   SELECT MENÜ BİLEŞENİ
   Kullanım: BridgeUI.select({ options, value, placeholder, onChange })
   options: [{ value, label, emoji, description, disabled }]
══════════════════════════════════════════════════════════════ */
const BridgeUISelect = {
  create({ options = [], value = '', placeholder = 'Seçiniz...', onChange = null, id = '', multiple = false, maxValues = 1, disabled = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `dui-select${disabled ? ' dui-select--disabled' : ''}`;
    if (id) wrap.id = id;

    // Seçili değerleri takip et
    const selected = new Set(value ? [value] : []);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dui-select__trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.disabled = disabled;

    const triggerContent = document.createElement('span');
    triggerContent.className = 'dui-select__value';
    triggerContent.textContent = placeholder;

    const arrow = document.createElement('span');
    arrow.className = 'dui-select__arrow';
    arrow.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;

    trigger.appendChild(triggerContent);
    trigger.appendChild(arrow);

    const dropdown = document.createElement('div');
    dropdown.className = 'dui-select__dropdown';
    dropdown.setAttribute('role', 'listbox');
    dropdown.hidden = true;

    function updateTrigger() {
      const selOpts = options.filter(o => selected.has(o.value));
      if (selOpts.length === 0) {
        triggerContent.textContent = placeholder;
        triggerContent.classList.remove('dui-select__value--filled');
      } else {
        triggerContent.innerHTML = selOpts.map(o =>
          `${o.emoji ? `<span aria-hidden="true">${o.emoji}</span> ` : ''}${escHtml ? escHtml(o.label) : o.label}`
        ).join(', ');
        triggerContent.classList.add('dui-select__value--filled');
      }
    }

    function renderOptions() {
      dropdown.innerHTML = '';
      options.forEach(opt => {
        if (opt.type === 'divider') {
          const div = document.createElement('div');
          div.className = 'dui-select__divider';
          if (opt.label) {
            const span = document.createElement('span');
            span.textContent = opt.label;
            div.appendChild(span);
          }
          dropdown.appendChild(div);
          return;
        }

        const item = document.createElement('div');
        item.className = `dui-select__option${selected.has(opt.value) ? ' dui-select__option--selected' : ''}${opt.disabled ? ' dui-select__option--disabled' : ''}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', selected.has(opt.value));
        item.dataset.value = opt.value;

        let html = '';
        if (opt.emoji) html += `<span class="dui-select__opt-emoji" aria-hidden="true">${opt.emoji}</span>`;
        html += `<div class="dui-select__opt-text"><span class="dui-select__opt-label">${opt.label}</span>`;
        if (opt.description) html += `<span class="dui-select__opt-desc">${opt.description}</span>`;
        html += '</div>';
        if (selected.has(opt.value)) html += `<span class="dui-select__opt-check" aria-hidden="true">✓</span>`;

        item.innerHTML = html;
        if (!opt.disabled) {
          item.addEventListener('click', () => {
            if (multiple) {
              if (selected.has(opt.value)) selected.delete(opt.value);
              else if (selected.size < maxValues) selected.add(opt.value);
            } else {
              selected.clear();
              selected.add(opt.value);
              close();
            }
            updateTrigger();
            renderOptions();
            onChange?.([...selected], opt.value);
          });
        }
        dropdown.appendChild(item);
      });
    }

    function open() {
      dropdown.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      wrap.classList.add('dui-select--open');
      // Ekranın dışına taşarsa yukarı aç
      const rect = wrap.getBoundingClientRect();
      if (rect.bottom + 240 > window.innerHeight) dropdown.classList.add('dui-select__dropdown--up');
      else dropdown.classList.remove('dui-select__dropdown--up');
    }

    function close() {
      dropdown.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('dui-select--open');
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dropdown.hidden) { renderOptions(); open(); } else close();
    });

    // Dışarı tıklayınca kapat
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });

    // Klavye navigasyonu
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (dropdown.hidden) { renderOptions(); open(); } else close(); }
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (dropdown.hidden) { renderOptions(); open(); }
        const items = [...dropdown.querySelectorAll('.dui-select__option:not(.dui-select__option--disabled)')];
        const focused = dropdown.querySelector('.dui-select__option--focused') || items[0];
        items.forEach(i => i.classList.remove('dui-select__option--focused'));
        const idx = items.indexOf(focused);
        const next = e.key === 'ArrowDown' ? items[idx + 1] || items[0] : items[idx - 1] || items[items.length - 1];
        next?.classList.add('dui-select__option--focused');
        next?.scrollIntoView({ block: 'nearest' });
      }
    });

    renderOptions();
    updateTrigger();
    wrap.appendChild(trigger);
    wrap.appendChild(dropdown);

    wrap.getValue = () => multiple ? [...selected] : [...selected][0] || '';
    wrap.setValue = (v) => { selected.clear(); if (v) (Array.isArray(v) ? v : [v]).forEach(x => selected.add(x)); updateTrigger(); renderOptions(); };
    wrap.setOptions = (opts) => { options.splice(0, options.length, ...opts); renderOptions(); updateTrigger(); };

    return wrap;
  },
};

/* ══════════════════════════════════════════════════════════════
   BADGE BİLEŞENİ
   Kullanım: BridgeUI.badge({ text, color, size })
   color: 'blurple' | 'green' | 'red' | 'yellow' | 'gray' | custom hex
══════════════════════════════════════════════════════════════ */
const BridgeUIBadge = {
  create({ text = '', color = 'blurple', size = 'sm', dot = false } = {}) {
    const badge = document.createElement('span');
    badge.className = `dui-badge dui-badge--${color} dui-badge--${size}${dot ? ' dui-badge--dot' : ''}`;
    if (!dot) badge.textContent = text;
    return badge;
  },
};

/* ══════════════════════════════════════════════════════════════
   TOOLTIP BİLEŞENİ
   Kullanım: BridgeUI.tooltip(element, { text, position })
   position: 'top' | 'bottom' | 'left' | 'right'
══════════════════════════════════════════════════════════════ */
const BridgeUITooltip = {
  _active: null,

  attach(el, { text = '', position = 'top', delay = 600 } = {}) {
    let timer = null;
    const tip = document.createElement('div');
    tip.className = `dui-tooltip dui-tooltip--${position}`;
    tip.textContent = text;
    tip.setAttribute('role', 'tooltip');

    const show = () => {
      timer = setTimeout(() => {
        document.body.appendChild(tip);
        const r = el.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        let top, left;
        if (position === 'top')    { top = r.top - tr.height - 8; left = r.left + r.width / 2 - tr.width / 2; }
        if (position === 'bottom') { top = r.bottom + 8; left = r.left + r.width / 2 - tr.width / 2; }
        if (position === 'left')   { top = r.top + r.height / 2 - tr.height / 2; left = r.left - tr.width - 8; }
        if (position === 'right')  { top = r.top + r.height / 2 - tr.height / 2; left = r.right + 8; }
        top  = Math.max(4, Math.min(top, window.innerHeight - tr.height - 4));
        left = Math.max(4, Math.min(left, window.innerWidth - tr.width - 4));
        tip.style.cssText = `top:${top + window.scrollY}px;left:${left + window.scrollX}px`;
        tip.classList.add('dui-tooltip--visible');
        BridgeUITooltip._active = tip;
      }, delay);
    };

    const hide = () => {
      clearTimeout(timer);
      tip.classList.remove('dui-tooltip--visible');
      tip.remove();
      BridgeUITooltip._active = null;
    };

    el.addEventListener('mouseenter', show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focusin', () => show());
    el.addEventListener('focusout', hide);
    el._duiTooltipHide = hide;

    return { destroy: () => { hide(); el.removeEventListener('mouseenter', show); el.removeEventListener('mouseleave', hide); } };
  },

  // data-tooltip attribute'larını otomatik işle
  initAutoTooltips() {
    document.querySelectorAll('[data-tooltip]').forEach(el => {
      if (el._duiTooltipAttached) return;
      el._duiTooltipAttached = true;
      BridgeUITooltip.attach(el, {
        text: el.dataset.tooltip,
        position: el.dataset.tooltipPos || 'top',
      });
    });
  },
};

/* ══════════════════════════════════════════════════════════════
   DİVİDER BİLEŞENİ
══════════════════════════════════════════════════════════════ */
const BridgeUIDivider = {
  create({ label = '', spacing = 'md' } = {}) {
    const div = document.createElement('div');
    div.className = `dui-divider dui-divider--${spacing}`;
    if (label) {
      const span = document.createElement('span');
      span.className = 'dui-divider__label';
      span.textContent = label;
      div.appendChild(span);
    }
    return div;
  },
};

/* ══════════════════════════════════════════════════════════════
   SWITCH BİLEŞENİ
══════════════════════════════════════════════════════════════ */
const BridgeUISwitch = {
  create({ checked = false, onChange = null, id = '', label = '', disabled = false } = {}) {
    const wrap = document.createElement('label');
    wrap.className = `dui-switch${disabled ? ' dui-switch--disabled' : ''}`;
    if (id) wrap.htmlFor = `${id}-input`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'dui-switch__input';
    input.checked = checked;
    input.disabled = disabled;
    if (id) input.id = `${id}-input`;

    const track = document.createElement('span');
    track.className = 'dui-switch__track';
    const thumb = document.createElement('span');
    thumb.className = 'dui-switch__thumb';
    track.appendChild(thumb);

    function sync() {
      track.style.background = input.checked ? 'var(--green, #43b581)' : 'var(--bg-3, #2f3136)';
      thumb.style.transform = input.checked ? 'translateX(20px)' : 'translateX(0)';
    }
    sync();

    input.addEventListener('change', () => { sync(); onChange?.(input.checked); });

    if (label) {
      const lbl = document.createElement('span');
      lbl.className = 'dui-switch__label';
      lbl.textContent = label;
      wrap.appendChild(input);
      wrap.appendChild(track);
      wrap.appendChild(lbl);
    } else {
      wrap.appendChild(input);
      wrap.appendChild(track);
    }

    wrap.getValue = () => input.checked;
    wrap.setValue = (v) => { input.checked = v; sync(); };
    return wrap;
  },
};

/* ══════════════════════════════════════════════════════════════
   ACTION ROW (Discord Mesaj Bileşenleri - Buton Satırı)
══════════════════════════════════════════════════════════════ */
const BridgeUIActionRow = {
  create(buttons = []) {
    const row = document.createElement('div');
    row.className = 'dui-action-row';
    buttons.forEach(btnDef => row.appendChild(BridgeUIButton.create(btnDef)));
    return row;
  },
};

/* ══════════════════════════════════════════════════════════════
   MODAL AKSIYONLARI
══════════════════════════════════════════════════════════════ */
const BridgeUIModal = {
  confirm({ title = 'Emin misiniz?', description = '', confirmLabel = 'Onayla', cancelLabel = 'İptal', danger = false, onConfirm, onCancel } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay dui-confirm-overlay';

    overlay.innerHTML = `
      <div class="dui-confirm-card modal-card" style="max-width:440px;width:95%;">
        <div class="dui-confirm-header">
          <h2 class="dui-confirm-title">${title}</h2>
        </div>
        ${description ? `<p class="dui-confirm-desc">${description}</p>` : ''}
        <div class="dui-confirm-actions"></div>
      </div>`;

    const actions = overlay.querySelector('.dui-confirm-actions');

    const cancelBtn = BridgeUIButton.create({
      label: cancelLabel, style: 'secondary',
      onClick: () => { overlay.remove(); onCancel?.(); },
    });
    const confirmBtn = BridgeUIButton.create({
      label: confirmLabel, style: danger ? 'danger' : 'primary',
      onClick: () => { overlay.remove(); onConfirm?.(); },
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); onCancel?.(); } });
    document.body.appendChild(overlay);

    confirmBtn.focus();
    return overlay;
  },
};

/* ══════════════════════════════════════════════════════════════
   CSS ENJEKSİYONU
══════════════════════════════════════════════════════════════ */
(function injectDUIStyles() {
  if (document.getElementById('dui-styles')) return;
  const style = document.createElement('style');
  style.id = 'dui-styles';
  style.textContent = `
    /* ─── BUTON ─────────────────────────────────────── */
    .dui-btn {
      display: inline-flex; align-items: center; justify-content: center;
      border: none; border-radius: 4px; cursor: pointer; font-family: inherit;
      font-weight: 500; line-height: 1; position: relative; overflow: hidden;
      transition: background .15s, opacity .15s, transform .1s;
      user-select: none; white-space: nowrap; text-decoration: none;
    }
    .dui-btn:active:not(:disabled) { transform: scale(0.97); }
    .dui-btn:disabled { opacity: .4; cursor: not-allowed; }
    .dui-btn__inner { display: flex; align-items: center; gap: 6px; }
    .dui-btn__emoji { font-size: 1.1em; line-height: 1; }

    /* Boyutlar */
    .dui-btn--sm  { padding: 4px 12px; font-size: 12px; height: 28px; }
    .dui-btn--md  { padding: 8px 16px; font-size: 14px; height: 38px; }
    .dui-btn--lg  { padding: 10px 20px; font-size: 15px; height: 44px; }

    /* Stiller */
    .dui-btn--primary   { background: var(--brand, #5865f2); color: #fff; }
    .dui-btn--primary:hover:not(:disabled)   { background: hsl(235, 85%, 64%); }
    .dui-btn--secondary { background: var(--bg-3, #4f545c); color: var(--text-primary, #fff); }
    .dui-btn--secondary:hover:not(:disabled) { background: var(--bg-4, #5d6269); }
    .dui-btn--danger    { background: var(--red, #ed4245); color: #fff; }
    .dui-btn--danger:hover:not(:disabled)    { background: #c0282a; }
    .dui-btn--success   { background: var(--green, #43b581); color: #fff; }
    .dui-btn--success:hover:not(:disabled)   { background: #3aa06f; }
    .dui-btn--link      { background: none; color: var(--brand, #5865f2); padding-left: 4px; padding-right: 4px; }
    .dui-btn--link:hover:not(:disabled)      { text-decoration: underline; }
    .dui-btn--ghost     { background: none; color: var(--text-primary, #fff); border: 1.5px solid var(--border, #40444b); }
    .dui-btn--ghost:hover:not(:disabled)     { background: var(--bg-3, #4f545c); }

    /* Ripple */
    .dui-btn__ripple {
      position: absolute; border-radius: 50%;
      background: rgba(255,255,255,.25);
      transform: scale(0); animation: duiBtnRipple .5s linear;
      pointer-events: none;
    }
    @keyframes duiBtnRipple { to { transform: scale(4); opacity: 0; } }

    /* ─── ACTION ROW ────────────────────────────────── */
    .dui-action-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }

    /* ─── SELECT ─────────────────────────────────────── */
    .dui-select { position: relative; width: 100%; }
    .dui-select__trigger {
      width: 100%; display: flex; align-items: center; justify-content: space-between;
      background: var(--bg-3, #40444b); border: 1px solid var(--border, #202225);
      border-radius: 4px; color: var(--text-primary, #dcddde);
      cursor: pointer; font-family: inherit; font-size: 14px;
      padding: 8px 12px; transition: border-color .15s;
    }
    .dui-select__trigger:hover, .dui-select--open .dui-select__trigger {
      border-color: var(--brand, #5865f2);
    }
    .dui-select--disabled .dui-select__trigger { opacity: .4; cursor: not-allowed; }
    .dui-select__value { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dui-select__value:not(.dui-select__value--filled) { color: var(--text-muted, #72767d); }
    .dui-select__arrow { flex-shrink: 0; color: var(--text-muted, #72767d); transition: transform .2s; }
    .dui-select--open .dui-select__arrow { transform: rotate(180deg); }
    .dui-select__dropdown {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0;
      background: var(--bg-2, #2f3136); border: 1px solid var(--border, #202225);
      border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5);
      max-height: 280px; overflow-y: auto; z-index: 1000;
      animation: duiDropdownIn .12s ease;
    }
    .dui-select__dropdown--up { top: auto; bottom: calc(100% + 4px); animation: duiDropdownInUp .12s ease; }
    @keyframes duiDropdownIn   { from { opacity:0; transform: translateY(-6px); } }
    @keyframes duiDropdownInUp { from { opacity:0; transform: translateY(6px); } }
    .dui-select__option {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; cursor: pointer;
      transition: background .1s; border-radius: 4px; margin: 2px 4px;
    }
    .dui-select__option:hover, .dui-select__option--focused {
      background: var(--brand, #5865f2);
    }
    .dui-select__option:hover .dui-select__opt-desc,
    .dui-select__option--focused .dui-select__opt-desc { color: rgba(255,255,255,.7); }
    .dui-select__option--selected { background: rgba(88,101,242,.3); }
    .dui-select__option--selected:hover { background: var(--brand, #5865f2); }
    .dui-select__option--disabled { opacity: .4; cursor: not-allowed; }
    .dui-select__opt-emoji { font-size: 20px; flex-shrink: 0; }
    .dui-select__opt-text { flex: 1; min-width: 0; }
    .dui-select__opt-label { display: block; font-size: 14px; font-weight: 500; color: var(--text-primary, #dcddde); }
    .dui-select__opt-desc  { display: block; font-size: 11px; color: var(--text-muted, #72767d); margin-top: 2px; }
    .dui-select__opt-check { color: var(--green, #43b581); font-weight: 700; flex-shrink: 0; }
    .dui-select__divider {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px 4px; margin-top: 4px;
    }
    .dui-select__divider::before, .dui-select__divider::after {
      content: ''; flex: 1; height: 1px; background: var(--border, #40444b);
    }
    .dui-select__divider span { font-size: 10px; font-weight: 700; color: var(--text-muted, #72767d); text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }

    /* ─── BADGE ──────────────────────────────────────── */
    .dui-badge {
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 999px; font-weight: 700; white-space: nowrap; flex-shrink: 0;
    }
    .dui-badge--xs  { font-size: 9px; padding: 1px 5px; min-width: 14px; height: 14px; }
    .dui-badge--sm  { font-size: 10px; padding: 2px 6px; min-width: 16px; height: 16px; }
    .dui-badge--md  { font-size: 12px; padding: 3px 8px; min-width: 20px; height: 20px; }
    .dui-badge--blurple { background: var(--brand, #5865f2); color: #fff; }
    .dui-badge--green   { background: var(--green, #43b581); color: #fff; }
    .dui-badge--red     { background: var(--red, #ed4245); color: #fff; }
    .dui-badge--yellow  { background: var(--yellow, #faa61a); color: #000; }
    .dui-badge--gray    { background: var(--bg-3, #4f545c); color: var(--text-muted, #72767d); }
    .dui-badge--dot { width: 8px; height: 8px; min-width: 8px; padding: 0; border-radius: 50%; }

    /* ─── TOOLTIP ────────────────────────────────────── */
    .dui-tooltip {
      position: absolute; z-index: 9999; padding: 6px 10px;
      background: var(--bg-1, #18191c); color: var(--text-primary, #dcddde);
      border-radius: 6px; font-size: 13px; font-weight: 500;
      pointer-events: none; box-shadow: 0 4px 16px rgba(0,0,0,.5);
      opacity: 0; transform: scale(.95); transition: opacity .12s, transform .12s;
      max-width: 240px; text-align: center; white-space: nowrap;
    }
    .dui-tooltip--visible { opacity: 1; transform: scale(1); }

    /* ─── DİVİDER ────────────────────────────────────── */
    .dui-divider {
      display: flex; align-items: center; gap: 8px;
      color: var(--text-muted, #72767d);
    }
    .dui-divider::before, .dui-divider::after {
      content: ''; flex: 1; height: 1px; background: var(--border, #40444b);
    }
    .dui-divider--sm  { margin: 8px 0; }
    .dui-divider--md  { margin: 16px 0; }
    .dui-divider--lg  { margin: 24px 0; }
    .dui-divider__label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }

    /* ─── SWITCH ─────────────────────────────────────── */
    .dui-switch { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
    .dui-switch--disabled { opacity: .4; cursor: not-allowed; }
    .dui-switch__input { position: absolute; opacity: 0; width: 0; height: 0; }
    .dui-switch__track {
      position: relative; width: 44px; height: 24px;
      background: var(--bg-3, #4f545c); border-radius: 24px;
      transition: background .2s; flex-shrink: 0;
    }
    .dui-switch__thumb {
      position: absolute; width: 18px; height: 18px;
      background: #fff; border-radius: 50%; top: 3px; left: 3px;
      transition: transform .2s; box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
    .dui-switch__label { font-size: 14px; color: var(--text-primary, #dcddde); }

    /* ─── CONFIRM MODAL ──────────────────────────────── */
    .dui-confirm-overlay { animation: duiFadeIn .15s ease; }
    @keyframes duiFadeIn { from { opacity:0; } }
    .dui-confirm-card { animation: duiSlideUp .18s ease; }
    @keyframes duiSlideUp { from { opacity:0; transform: translateY(20px) scale(.97); } }
    .dui-confirm-header { margin-bottom: 12px; }
    .dui-confirm-title { font-size: 18px; font-weight: 700; margin: 0; }
    .dui-confirm-desc { color: var(--text-muted, #72767d); font-size: 14px; line-height: 1.6; margin: 0 0 20px; }
    .dui-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `;
  document.head.appendChild(style);
})();

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════ */
window.BridgeUI = {
  button:    (opts) => BridgeUIButton.create(opts),
  select:    (opts) => BridgeUISelect.create(opts),
  badge:     (opts) => BridgeUIBadge.create(opts),
  tooltip:   (el, opts) => BridgeUITooltip.attach(el, opts),
  divider:   (opts) => BridgeUIDivider.create(opts),
  switch:    (opts) => BridgeUISwitch.create(opts),
  actionRow: (btns) => BridgeUIActionRow.create(btns),
  confirm:   (opts) => BridgeUIModal.confirm(opts),

  // Mevcut DOM'daki data-tooltip attribute'larını işle
  initTooltips: () => BridgeUITooltip.initAutoTooltips(),
};

// DOM hazır olunca auto-tooltip'leri başlat
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => BridgeUITooltip.initAutoTooltips());
} else {
  BridgeUITooltip.initAutoTooltips();
}

// MutationObserver ile dinamik eklenen data-tooltip'leri de yakala
const _tooltipObserver = new MutationObserver(() => BridgeUITooltip.initAutoTooltips());
document.addEventListener('DOMContentLoaded', () => {
  _tooltipObserver.observe(document.body, { childList: true, subtree: true });
});

console.log('[BridgeUI] Discord UI Kit yüklendi ✓');

export const getBridgeUI = () => window.BridgeUI;
