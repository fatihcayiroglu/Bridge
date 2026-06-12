// client/js/core/e2e-voice-svelte.ts
// Sprint 116 — E2EVoicePanel mount shim (ADR-0008 Faz 3)
// E2EE sesli arama paneli
import { mount } from 'svelte';
import E2EVoicePanel from './E2EVoicePanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('E2EVoicePanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountE2EVoicePanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('e2e-voice-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'e2e-voice-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(E2EVoicePanel, { target: el, props: {} });
  log.info('E2EVoicePanel mounted via shim');
}

export function unmountE2EVoicePanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountE2EVoicePanel(), { once: true });
} else {
  mountE2EVoicePanel();
}
document.addEventListener('bridge:socket-ready', () => mountE2EVoicePanel(), { once: true });
