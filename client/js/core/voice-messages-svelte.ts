// client/js/core/voice-messages-svelte.ts
// Sprint 116 — VoiceMessagePlayer mount shim (ADR-0008 Faz 3)
// Sesli mesaj oynatıcı
import { mount } from 'svelte';
import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('VoiceMessagePlayerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountVoiceMessagePlayer(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('voice-messages-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'voice-messages-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(VoiceMessagePlayer, { target: el, props: {} });
  log.info('VoiceMessagePlayer mounted via shim');
}

export function unmountVoiceMessagePlayer(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountVoiceMessagePlayer(), { once: true });
} else {
  mountVoiceMessagePlayer();
}
document.addEventListener('bridge:socket-ready', () => mountVoiceMessagePlayer(), { once: true });
