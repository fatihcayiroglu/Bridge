import { mount, unmount } from 'svelte';
import ServerEventsPanel from './ServerEventsPanel.svelte';
let instance: ReturnType<typeof mount> | null = null;
export function mountServerEvents(target?: HTMLElement): void {
  if (instance) return;
  const host = target ?? document.getElementById('server-events-root') ?? (() => { const el = document.createElement('div'); el.id = 'server-events-root'; document.body.appendChild(el); return el; })();
  instance = mount(ServerEventsPanel, { target: host });
}
export function unmountServerEvents(): void { if (!instance) return; void unmount(instance); instance = null; }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountServerEvents(), { once: true });
else mountServerEvents();
