// client/js/core/server-templates-admin-svelte.ts
// Sprint 116 — ServerTemplatesAdmin mount shim (ADR-0008 Faz 3)
// Sunucu şablon yönetici paneli
import { mount } from 'svelte';
import ServerTemplatesAdmin from './ServerTemplatesAdmin.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ServerTemplatesAdminShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountServerTemplatesAdmin(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('server-templates-admin-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'server-templates-admin-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ServerTemplatesAdmin, { target: el, props: {} });
  log.info('ServerTemplatesAdmin mounted via shim');
}

export function unmountServerTemplatesAdmin(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountServerTemplatesAdmin(), { once: true });
} else {
  mountServerTemplatesAdmin();
}
document.addEventListener('bridge:socket-ready', () => mountServerTemplatesAdmin(), { once: true });
