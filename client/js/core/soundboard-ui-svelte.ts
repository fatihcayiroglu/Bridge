// client/js/core/soundboard-ui-svelte.ts
// Sprint 116 — SoundboardPanel mount shim (ADR-0008 Faz 3)
// Soundboard sesi tetikleme paneli
import { mount } from 'svelte';
import SoundboardPanel from './SoundboardPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SoundboardPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSoundboardPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('soundboard-ui-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'soundboard-ui-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SoundboardPanel, { target: el, props: {} });
  log.info('SoundboardPanel mounted via shim');
}

export function unmountSoundboardPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSoundboardPanel(), { once: true });
} else {
  mountSoundboardPanel();
}
document.addEventListener('bridge:socket-ready', () => mountSoundboardPanel(), { once: true });
