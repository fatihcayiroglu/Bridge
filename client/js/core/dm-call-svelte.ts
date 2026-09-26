// client/js/core/dm-call-svelte.ts
// FAZ 8/1 — DmCallPanel mount shim.
//
// Panel gerçek bir uygulamaydı ama hiçbir giriş noktasından import
// edilmiyordu: DM araması üründe YOKTU. Kanonik biçim `global-search-svelte.ts`
// ile aynı — `unmount()` GERÇEKTEN çağrılır, yoksa `onDestroy` çalışmaz ve
// `startDmCall` kaydı ölü bir bileşene işaret etmeye devam eder.

import { mount, unmount } from 'svelte';
import DmCallPanel from './DmCallPanel.svelte';

let instance: ReturnType<typeof mount> | null = null;

export function mountDmCall(target?: HTMLElement): void {
  if (instance) return;
  const el = target ?? document.getElementById('dm-call-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'dm-call-root';
    document.body.appendChild(div);
    return div;
  })();
  instance = mount(DmCallPanel, { target: el, props: {} });
}

export function unmountDmCall(): void {
  if (!instance) return;
  void unmount(instance);
  instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDmCall(), { once: true });
} else {
  mountDmCall();
}
