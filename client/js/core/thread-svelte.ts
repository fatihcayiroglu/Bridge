import { mount, unmount } from 'svelte';
import ThreadPanel from './ThreadPanel.svelte';
let instance: ReturnType<typeof mount> | null = null;
export function mountThreadPanel(target?: HTMLElement): void {
  if (instance) return;
  const host = target ?? document.getElementById('thread-root') ?? (() => {
    const el = document.createElement('div'); el.id = 'thread-root'; document.body.appendChild(el); return el;
  })();
  instance = mount(ThreadPanel, { target: host });
}
export function unmountThreadPanel(): void { if (!instance) return; void unmount(instance); instance = null; }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountThreadPanel(), { once: true });
else mountThreadPanel();
