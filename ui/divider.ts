// client/js/core/ui/divider.ts
'use strict';

export const BridgeUIDivider = {
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
