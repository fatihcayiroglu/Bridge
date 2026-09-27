// client/js/core/servers-svelte.ts
// Sprint 116 — ServerSwitcher mount shim (ADR-0008 Faz 3)
// Sunucu değiştirici ve liste paneli
import { mount, unmount } from 'svelte';
import ServerSwitcher from './ServerSwitcher.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('ServerSwitcherShim');

let _instance: ReturnType<typeof mount> | null = null;

/**
 * Rail mount noktası: index.html:144 içindeki #server-list korunur.
 * Sunucu ikonları statik `.server-separator` + `.server-add` düğmesinin ÖNÜNE
 * girmelidir (legacy servers.ts:221-229 sırası), bu yüzden mount noktası ilk
 * çocuk olarak eklenir. `display:contents` ile sarmalayıcı flex akışından çıkar,
 * böylece .server-list'in gap/align kuralları değişmez.
 */
function resolveRailMountPoint(): HTMLElement {
  const list = document.getElementById('server-list');
  if (!list) {
    // Rail yoksa (test/parçalı sayfa) eski davranışa düş.
    return document.getElementById('servers-root') ?? (() => {
      const div = document.createElement('div');
      div.id = 'servers-root';
      document.body.appendChild(div);
      return div;
    })();
  }

  const existing = document.getElementById('servers-root');
  if (existing) return existing;

  const holder = document.createElement('div');
  holder.id = 'servers-root';
  holder.style.display = 'contents';
  list.insertBefore(holder, list.firstChild);
  return holder;
}

export function mountServerSwitcher(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? resolveRailMountPoint();
  _instance = mount(ServerSwitcher, { target: el, props: {} });
  log.info('ServerSwitcher mounted via shim');
}

export function unmountServerSwitcher(): void {
  if (!_instance) return;
  const mounted = _instance;
  _instance = null;
  void unmount(mounted);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountServerSwitcher(), { once: true });
} else {
  mountServerSwitcher();
}
document.addEventListener('bridge:socket-ready', () => mountServerSwitcher(), { once: true });
