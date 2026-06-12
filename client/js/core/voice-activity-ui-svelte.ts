// client/js/core/voice-activity-ui-svelte.ts
// Sprint 116 — VoiceActivityIndicator mount shim (ADR-0008 Faz 3)
// Konuşma aktivite göstergesi
import { mount } from 'svelte';
import VoiceActivityIndicator from './VoiceActivityIndicator.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('VoiceActivityIndicatorShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountVoiceActivityIndicator(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('voice-activity-ui-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'voice-activity-ui-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(VoiceActivityIndicator, { target: el, props: {} });
  log.info('VoiceActivityIndicator mounted via shim');
}

export function unmountVoiceActivityIndicator(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountVoiceActivityIndicator(), { once: true });
} else {
  mountVoiceActivityIndicator();
}
document.addEventListener('bridge:socket-ready', () => mountVoiceActivityIndicator(), { once: true });
