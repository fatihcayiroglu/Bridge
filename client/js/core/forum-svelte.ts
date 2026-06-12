// client/js/core/forum-svelte.ts
// Sprint 116 — ForumPanel mount shim (ADR-0008 Faz 3)
// Forum kanal listesi ve thread paneli
import { mount } from 'svelte';
import ForumPanel from './ForumPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ForumPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountForumPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('forum-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'forum-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ForumPanel, { target: el, props: {} });
  log.info('ForumPanel mounted via shim');
}

export function unmountForumPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountForumPanel(), { once: true });
} else {
  mountForumPanel();
}
document.addEventListener('bridge:socket-ready', () => mountForumPanel(), { once: true });
