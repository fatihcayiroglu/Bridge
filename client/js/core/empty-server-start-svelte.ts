// client/js/core/empty-server-start-svelte.ts
import { mount } from 'svelte';
import EmptyServerStart from './EmptyServerStart.svelte';
import { createLogger } from './logger.ts';

const log = createLogger('EmptyServerStartShim');

let instance: ReturnType<typeof mount> | null = null;

export function mountEmptyServerStart(target?: HTMLElement): void {
  if (instance) return;

  const el = target ?? document.getElementById('empty-server-start-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'empty-server-start-root';
    document.body.appendChild(div);
    return div;
  })();

  instance = mount(EmptyServerStart, { target: el, props: {} });
  log.info('EmptyServerStart mounted');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountEmptyServerStart(), { once: true });
} else {
  mountEmptyServerStart();
}
