// client/js/core/music-player-svelte.ts
// Sprint 116 — MusicPlayerPanel mount shim (ADR-0008 Faz 3)
// Sunucu müzik çalar paneli
import { mount } from 'svelte';
import MusicPlayerPanel from './MusicPlayerPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('MusicPlayerPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMusicPlayerPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('music-player-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'music-player-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MusicPlayerPanel, { target: el, props: {} });
  log.info('MusicPlayerPanel mounted via shim');
}

export function unmountMusicPlayerPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMusicPlayerPanel(), { once: true });
} else {
  mountMusicPlayerPanel();
}
document.addEventListener('bridge:socket-ready', () => mountMusicPlayerPanel(), { once: true });
