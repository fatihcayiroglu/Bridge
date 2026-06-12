// client/js/core/ui/tooltip.ts
// Bridge Design System — Tooltip bileşeni
// position: 'top' | 'bottom' | 'left' | 'right'

'use strict';

export const BridgeUITooltip = {
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
