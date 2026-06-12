// client/js/core/group-dm-core-svelte.ts
// Sprint 116 — GroupDmCore mount shim (ADR-0008 Faz 3)
// Grup DM çekirdek mantığı ve socket
import { mount } from 'svelte';
import GroupDmCore from './GroupDmCore.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('GroupDmCoreShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountGroupDmCore(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('group-dm-core-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'group-dm-core-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(GroupDmCore, { target: el, props: {} });
  log.info('GroupDmCore mounted via shim');
}

export function unmountGroupDmCore(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountGroupDmCore(), { once: true });
} else {
  mountGroupDmCore();
}
document.addEventListener('bridge:socket-ready', () => mountGroupDmCore(), { once: true });

// Legacy compatibility export used by app.ts.
export function bindGroupDmSocketEvents(socket?: unknown): void {
  const binder = BridgeRegistry.get<unknown>('bindGroupDmSocketEvents');
  if (typeof binder === 'function') {
    binder(socket);
  }
}
