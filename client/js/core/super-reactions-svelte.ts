// client/js/core/super-reactions-svelte.ts
// Sprint 116 — SuperReactionPanel mount shim (ADR-0008 Faz 3)
// Animasyonlu süper reaksiyon paneli
import { mount } from 'svelte';
import SuperReactionPanel from './SuperReactionPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SuperReactionPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSuperReactionPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('super-reactions-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'super-reactions-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SuperReactionPanel, { target: el, props: {} });
  log.info('SuperReactionPanel mounted via shim');
}

export function unmountSuperReactionPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSuperReactionPanel(), { once: true });
} else {
  mountSuperReactionPanel();
}
document.addEventListener('bridge:socket-ready', () => mountSuperReactionPanel(), { once: true });
