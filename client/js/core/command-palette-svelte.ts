// client/js/core/command-palette-svelte.ts
// Sprint 115 — CommandPalettePanel mount shim (ADR-0008 Faz 2)
import { mount } from 'svelte';
import CommandPalettePanel from './CommandPalettePanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';

let _instance: ReturnType<typeof mount> | null = null;

function mountCommandPalette() {
  if (_instance) return;
  const el = document.getElementById('command-palette-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'command-palette-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(CommandPalettePanel, { target: el, props: {} });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountCommandPalette, { once: true });
} else {
  mountCommandPalette();
}
document.addEventListener('bridge:socket-ready', mountCommandPalette, { once: true });
