// client/js/core/voice-recorder-svelte.ts
// Sprint 116 — VoiceRecorderPanel mount shim (ADR-0008 Faz 3)
// Ses kaydı, waveform görselleştirme, upload
import { mount } from 'svelte';
import VoiceRecorderPanel from './VoiceRecorderPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('VoiceRecorderPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountVoiceRecorderPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('voice-recorder-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'voice-recorder-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(VoiceRecorderPanel, { target: el, props: {} });
  log.info('VoiceRecorderPanel mounted via shim');
}

export function unmountVoiceRecorderPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountVoiceRecorderPanel(), { once: true });
} else {
  mountVoiceRecorderPanel();
}
document.addEventListener('bridge:socket-ready', () => mountVoiceRecorderPanel(), { once: true });
