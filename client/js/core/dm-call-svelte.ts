// client/js/core/dm-call-svelte.ts
// Sprint 115 — DmCallPanel mount shim (ADR-0008 Faz 2)
// dm-call.ts (898 satır) → DmCallPanel.svelte geçişinin mount köprüsü.

import { mount } from 'svelte';
import DmCallPanel from './DmCallPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';

let _dmCallInstance: ReturnType<typeof mount> | null = null;

function mountDmCallPanel() {
  if (_dmCallInstance) return;

  const el = document.getElementById('dm-call-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'dm-call-root';
    document.body.appendChild(div);
    return div;
  })();

  _dmCallInstance = mount(DmCallPanel, { target: el, props: {} });

  // Geriye dönük uyumluluk — vanilla kod bu kayıtları kullanır
  // BridgeRegistry kayıtları DmCallPanel.svelte'in onMount'unda yapılır
}

// DOMContentLoaded + bridge:socket-ready dual-listener (voice-svelte.ts pattern)
function init() { mountDmCallPanel(); }

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
document.addEventListener('bridge:socket-ready', init, { once: true });
