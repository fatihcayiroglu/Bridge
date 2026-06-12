// client/js/core/spotify-widget-svelte.ts
// Sprint 116 — SpotifyWidget mount shim (ADR-0008 Faz 3)
// Spotify dinleme aktivitesi widget
import { mount } from 'svelte';
import SpotifyWidget from './SpotifyWidget.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SpotifyWidgetShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSpotifyWidget(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('spotify-widget-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'spotify-widget-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SpotifyWidget, { target: el, props: {} });
  log.info('SpotifyWidget mounted via shim');
}

export function unmountSpotifyWidget(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSpotifyWidget(), { once: true });
} else {
  mountSpotifyWidget();
}
document.addEventListener('bridge:socket-ready', () => mountSpotifyWidget(), { once: true });
