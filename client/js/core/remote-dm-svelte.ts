// P6 — RemoteDmPanel mount shim.
// Mounted once, hidden by default; BridgeRegistry owns open/close actions.
import { mount, unmount } from 'svelte';
import RemoteDmPanel from './RemoteDmPanel.svelte';

let instance: ReturnType<typeof mount> | null = null;

export function mountRemoteDmPanel(target?: HTMLElement): void {
  if (instance) return;
  const el = target ?? document.getElementById('remote-dm-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'remote-dm-root';
    document.body.appendChild(div);
    return div;
  })();
  instance = mount(RemoteDmPanel, { target: el, props: {} });
}

export function unmountRemoteDmPanel(): void {
  if (!instance) return;
  void unmount(instance);
  instance = null;
}
