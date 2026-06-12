// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/DiscordUiKitPanel.svelte
//              client/js/core/discord-ui-kit-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/discord-ui-kit.ts
// Bridge Design System — UI bileşen registry hub
// Sprint 105: Refactor — bileşenler ayrı dosyalara taşındı.
//
// Bileşen dosyaları:
//   bridge-ui-button.ts  — Button (primary/secondary/danger/success/link/ghost)
//   bridge-ui-select.ts  — Select Menu (single/multi select, searchable)
//   bridge-ui-misc.ts    — Badge, Tooltip, Divider, Switch, ActionRow, Modal
//
// Tüm bileşenler Bridge CSS token'larını kullanır (tokens.css) — temayı destekler.
// BridgeRegistry üzerinden erişim: BridgeRegistry.get('BridgeUI')

'use strict';

import { createLogger } from './logger.js';
import { BridgeRegistry } from './bridge-registry.js';
import { BridgeUIButton }                                  from './bridge-ui-button.js';
import { BridgeUISelect }                                  from './bridge-ui-select.js';
import { BridgeUIBadge, BridgeUITooltip, BridgeUIDivider,
         BridgeUISwitch, BridgeUIActionRow, BridgeUIModal } from './bridge-ui-misc.js';

const log = createLogger('DiscordUI');

/* ── Registry kaydı ─────────────────────────────────────────── */
BridgeRegistry.register('BridgeUI', {
  button:    (opts: Parameters<typeof BridgeUIButton.create>[0])    => BridgeUIButton.create(opts),
  select:    (opts: Parameters<typeof BridgeUISelect.create>[0])    => BridgeUISelect.create(opts),
  badge:     (opts: Parameters<typeof BridgeUIBadge.create>[0])     => BridgeUIBadge.create(opts),
  tooltip:   (el: HTMLElement, opts: Parameters<typeof BridgeUITooltip.attach>[1]) => BridgeUITooltip.attach(el, opts),
  divider:   (opts: Parameters<typeof BridgeUIDivider.create>[0])   => BridgeUIDivider.create(opts),
  switch:    (opts: Parameters<typeof BridgeUISwitch.create>[0])    => BridgeUISwitch.create(opts),
  actionRow: (btns: Parameters<typeof BridgeUIActionRow.create>[0]) => BridgeUIActionRow.create(btns),
  confirm:   (opts: Parameters<typeof BridgeUIModal.confirm>[0])    => BridgeUIModal.confirm(opts),
  initTooltips: () => BridgeUITooltip.initAutoTooltips(),
});

/* ── Auto-tooltip başlatma ──────────────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => BridgeUITooltip.initAutoTooltips());
} else {
  BridgeUITooltip.initAutoTooltips();
}

const _tooltipObserver = new MutationObserver(() => BridgeUITooltip.initAutoTooltips());
document.addEventListener('DOMContentLoaded', () => {
  _tooltipObserver.observe(document.body, { childList: true, subtree: true });
});

log.log('[BridgeUI] Bridge Design System yüklendi ✓');
