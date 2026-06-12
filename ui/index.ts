// client/js/core/ui/index.ts
// Bridge Design System — barrel export + BridgeRegistry kaydı
// Bu dosya eski discord-ui-kit.ts'in yerini alır.
// İçe aktarmak için: import { BridgeUI } from './ui/index.js'
// Ya da BridgeRegistry üzerinden: BridgeRegistry.get('BridgeUI')

'use strict';

import { BridgeRegistry } from '../bridge-registry.js';

import { BridgeUIButton }    from './button.js';
import { BridgeUISelect }    from './select.js';
import { BridgeUIBadge }     from './badge.js';
import { BridgeUITooltip }   from './tooltip.js';
import { BridgeUIDivider }   from './divider.js';
import { BridgeUISwitch }    from './switch.js';
import { BridgeUIActionRow } from './action-row.js';
import { BridgeUIModal }     from './modal.js';
import { injectDUIStyles }   from './styles.js';

// Named re-exports (tree-shaking dostu)
export {
  BridgeUIButton,
  BridgeUISelect,
  BridgeUIBadge,
  BridgeUITooltip,
  BridgeUIDivider,
  BridgeUISwitch,
  BridgeUIActionRow,
  BridgeUIModal,
  injectDUIStyles,
};

// CSS'i inject et
injectDUIStyles();

// BridgeRegistry kaydı — eski API'yı koru
BridgeRegistry.register('BridgeUI', {
  button:    (opts) => BridgeUIButton.create(opts),
  select:    (opts) => BridgeUISelect.create(opts),
  badge:     (opts) => BridgeUIBadge.create(opts),
  tooltip:   (el, opts) => BridgeUITooltip.attach(el, opts),
  divider:   (opts) => BridgeUIDivider.create(opts),
  switch:    (opts) => BridgeUISwitch.create(opts),
  actionRow: (btns) => BridgeUIActionRow.create(btns),
  confirm:   (opts) => BridgeUIModal.confirm(opts),
  initTooltips: () => BridgeUITooltip.initAutoTooltips(),
});

// Auto-tooltip başlatma
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => BridgeUITooltip.initAutoTooltips());
} else {
  BridgeUITooltip.initAutoTooltips();
}

// Dinamik eklenen data-tooltip'leri yakala
const _tooltipObserver = new MutationObserver(() => BridgeUITooltip.initAutoTooltips());
document.addEventListener('DOMContentLoaded', () => {
  _tooltipObserver.observe(document.body, { childList: true, subtree: true });
});

console.log('[BridgeUI] Discord UI Kit yüklendi ✓');
