// client/js/core/members-svelte.ts
// Sprint 116 — MemberListPanel mount shim (ADR-0008 Faz 3)
// Üye listesi ve rol filtreleme
import { mount, unmount } from 'svelte';
import MemberListPanel from './MemberListPanel.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('MemberListPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMemberListPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('member-list-content') ?? (() => {
    const div = document.createElement('div');
    div.id = 'members-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MemberListPanel, { target: el, props: {} });
  log.info('MemberListPanel mounted via shim');
}

export async function unmountMemberListPanel(): Promise<void> {
  const instance = _instance;
  // Release ownership before awaiting Svelte cleanup. A second close/unmount
  // in the same turn must not dispose the same component twice.
  _instance = null;
  if (instance) await unmount(instance);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMemberListPanel(), { once: true });
} else {
  mountMemberListPanel();
}
document.addEventListener('bridge:socket-ready', () => mountMemberListPanel(), { once: true });
