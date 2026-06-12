// client/js/core/video-quality-svelte.ts
// Sprint 116 — VideoQualitySelector mount shim (ADR-0008 Faz 3)
// Video kalite ayar paneli
import { mount } from 'svelte';
import VideoQualitySelector from './VideoQualitySelector.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('VideoQualitySelectorShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountVideoQualitySelector(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('video-quality-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'video-quality-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(VideoQualitySelector, { target: el, props: {} });
  log.info('VideoQualitySelector mounted via shim');
}

export function unmountVideoQualitySelector(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountVideoQualitySelector(), { once: true });
} else {
  mountVideoQualitySelector();
}
document.addEventListener('bridge:socket-ready', () => mountVideoQualitySelector(), { once: true });
