// client/js/core/members-svelte.ts
// Sprint 116 — MemberListPanel mount shim (ADR-0008 Faz 3)
// Üye listesi ve rol filtreleme
import { mount } from 'svelte';
import MemberListPanel from './MemberListPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('MemberListPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMemberListPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('members-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'members-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MemberListPanel, { target: el, props: {} });
  log.info('MemberListPanel mounted via shim');
}

export function unmountMemberListPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMemberListPanel(), { once: true });
} else {
  mountMemberListPanel();
}
document.addEventListener('bridge:socket-ready', () => mountMemberListPanel(), { once: true });
