// client/js/core/socket-svelte.ts
// Sprint 116 — SocketManager mount shim (ADR-0008 Faz 3)
// WebSocket bağlantı yöneticisi
import { mount } from 'svelte';
import SocketManager from './SocketManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SocketManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSocketManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('socket-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'socket-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SocketManager, { target: el, props: {} });
  log.info('SocketManager mounted via shim');
}

export function unmountSocketManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSocketManager(), { once: true });
} else {
  mountSocketManager();
}
document.addEventListener('bridge:socket-ready', () => mountSocketManager(), { once: true });

// Legacy compatibility export used by app.ts.
export const socket = new Proxy({} as { on?: (...args: unknown[]) => void; emit?: (...args: unknown[]) => void; off?: (...args: unknown[]) => void }, {
  get(_target, prop) {
    const current = BridgeRegistry.get<unknown>('socket');
    if (current && typeof current === 'object') {
      const value = (current as Record<PropertyKey, unknown>)[prop];
      return typeof value === 'function' ? value.bind(current) : value;
    }
    return undefined;
  },
});
