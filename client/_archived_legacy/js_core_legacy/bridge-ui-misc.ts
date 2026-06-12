// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BridgeUiMiscPanel.svelte
//              client/js/core/bridge-ui-misc-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bridge-ui-misc.ts
// Sprint 105: discord-ui-kit.ts parçalandı — Badge, Tooltip, Divider, Switch, ActionRow, Modal
// Küçük yardımcı bileşenler tek dosyada tutuldu (her biri <40 satır)

'use strict';

const BridgeUIBadge = {
  create({ text = '', color = 'blurple', size = 'sm', dot = false } = {}) {
    const badge = document.createElement('span');
    badge.className = `dui-badge dui-badge--${color} dui-badge--${size}${dot ? ' dui-badge--dot' : ''}`;
    if (!dot) badge.textContent = text;
    return badge;
  },
};

/* ══════════════════════════════════════════════════════════════
   TOOLTIP BİLEÅENİ
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
   DİVİDER BİLEÅENİ
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
   SWITCH BİLEÅENİ
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
