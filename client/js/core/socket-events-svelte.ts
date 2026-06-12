// client/js/core/socket-events-svelte.ts
// Sprint 116 — SocketEventBus mount shim (ADR-0008 Faz 3)
// Socket event bus ve yönlendirici
import { mount } from 'svelte';
import SocketEventBus from './SocketEventBus.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SocketEventBusShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSocketEventBus(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('socket-events-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'socket-events-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SocketEventBus, { target: el, props: {} });
  log.info('SocketEventBus mounted via shim');
}

export function unmountSocketEventBus(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSocketEventBus(), { once: true });
} else {
  mountSocketEventBus();
}
document.addEventListener('bridge:socket-ready', () => mountSocketEventBus(), { once: true });
