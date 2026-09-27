import { mount, unmount } from 'svelte';
import SavedPanel from './SavedPanel.svelte';

let instance: ReturnType<typeof mount> | null = null;

export function mountSavedPanel(target?: HTMLElement): void {
  if (instance) return;
  const host = target ?? document.getElementById('saved-root') ?? (() => {
    const element = document.createElement('div');
    element.id = 'saved-root';
    document.body.appendChild(element);
    return element;
  })();
  instance = mount(SavedPanel, { target: host });
}

export function unmountSavedPanel(): void {
  if (!instance) return;
  void unmount(instance);
  instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSavedPanel(), { once: true });
} else {
  mountSavedPanel();
}
