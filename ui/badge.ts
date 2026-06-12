// client/js/core/ui/badge.ts
'use strict';

export const BridgeUIBadge = {
  create({ text = '', color = 'blurple', size = 'sm', dot = false } = {}) {
    const badge = document.createElement('span');
    badge.className = `dui-badge dui-badge--${color} dui-badge--${size}${dot ? ' dui-badge--dot' : ''}`;
    if (!dot) badge.textContent = text;
    return badge;
  },
};
