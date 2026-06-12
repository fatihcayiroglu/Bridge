// client/js/core/voice-volume-svelte.ts
// Sprint 116 — VoiceVolumeControl mount shim (ADR-0008 Faz 3)
// Bireysel ses seviyesi ayarı
import { mount } from 'svelte';
import VoiceVolumeControl from './VoiceVolumeControl.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('VoiceVolumeControlShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountVoiceVolumeControl(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('voice-volume-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'voice-volume-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(VoiceVolumeControl, { target: el, props: {} });
  log.info('VoiceVolumeControl mounted via shim');
}

export function unmountVoiceVolumeControl(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountVoiceVolumeControl(), { once: true });
} else {
  mountVoiceVolumeControl();
}
document.addEventListener('bridge:socket-ready', () => mountVoiceVolumeControl(), { once: true });
