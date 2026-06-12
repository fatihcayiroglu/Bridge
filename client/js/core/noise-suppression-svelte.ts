// client/js/core/noise-suppression-svelte.ts
// Sprint 116 — NoiseSuppressionControl mount shim (ADR-0008 Faz 3)
// RNNoise gürültü bastırma kontrol paneli
import { mount } from 'svelte';
import NoiseSuppressionControl from './NoiseSuppressionControl.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('NoiseSuppressionControlShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountNoiseSuppressionControl(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('noise-suppression-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'noise-suppression-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(NoiseSuppressionControl, { target: el, props: {} });
  log.info('NoiseSuppressionControl mounted via shim');
}

export function unmountNoiseSuppressionControl(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountNoiseSuppressionControl(), { once: true });
} else {
  mountNoiseSuppressionControl();
}
document.addEventListener('bridge:socket-ready', () => mountNoiseSuppressionControl(), { once: true });
