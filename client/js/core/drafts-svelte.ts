// client/js/core/drafts-svelte.ts
// Sprint 116 — DraftManager mount shim (ADR-0008 Faz 3)
// Kanal başına mesaj taslak yönetimi
import { mount } from 'svelte';
import DraftManager from './DraftManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('DraftManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountDraftManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('drafts-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'drafts-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(DraftManager, { target: el, props: {} });
  log.info('DraftManager mounted via shim');
}

export function unmountDraftManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDraftManager(), { once: true });
} else {
  mountDraftManager();
}
document.addEventListener('bridge:socket-ready', () => mountDraftManager(), { once: true });
