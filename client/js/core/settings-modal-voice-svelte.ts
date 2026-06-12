// client/js/core/settings-modal-voice-svelte.ts
// Sprint 116 — VoiceSettingsTab mount shim (ADR-0008 Faz 3)
// Ses/Video ayarları sekmesi
import { mount } from 'svelte';
import VoiceSettingsTab from './VoiceSettingsTab.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('VoiceSettingsTabShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountVoiceSettingsTab(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('settings-modal-voice-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'settings-modal-voice-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(VoiceSettingsTab, { target: el, props: {} });
  log.info('VoiceSettingsTab mounted via shim');
}

export function unmountVoiceSettingsTab(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountVoiceSettingsTab(), { once: true });
} else {
  mountVoiceSettingsTab();
}
document.addEventListener('bridge:socket-ready', () => mountVoiceSettingsTab(), { once: true });
