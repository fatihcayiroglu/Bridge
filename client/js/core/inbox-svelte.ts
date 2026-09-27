import { mount, unmount } from 'svelte';
import InboxPanel from './InboxPanel.svelte';

let instance: ReturnType<typeof mount> | null = null;

export function mountInboxPanel(target?: HTMLElement): void {
  if (instance) return;
  const host = target ?? document.getElementById('inbox-root') ?? (() => {
    const element = document.createElement('div');
    element.id = 'inbox-root';
    document.body.appendChild(element);
    return element;
  })();
  instance = mount(InboxPanel, { target: host });
}

export function unmountInboxPanel(): void {
  if (!instance) return;
  void unmount(instance);
  instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountInboxPanel(), { once: true });
} else {
  mountInboxPanel();
}

