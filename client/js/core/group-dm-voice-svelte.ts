// client/js/core/group-dm-voice-svelte.ts
// Sprint 116 — GroupDmVoicePanel mount shim (ADR-0008 Faz 3)
// Grup DM sesli arama paneli
import { mount } from 'svelte';
import GroupDmVoicePanel from './GroupDmVoicePanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('GroupDmVoicePanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountGroupDmVoicePanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('group-dm-voice-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'group-dm-voice-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(GroupDmVoicePanel, { target: el, props: {} });
  log.info('GroupDmVoicePanel mounted via shim');
}

export function unmountGroupDmVoicePanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountGroupDmVoicePanel(), { once: true });
} else {
  mountGroupDmVoicePanel();
}
document.addEventListener('bridge:socket-ready', () => mountGroupDmVoicePanel(), { once: true });
