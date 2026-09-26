// client/js/core/server-settings/server-settings-svelte.ts
// Svelte ServerSettingsModal mount bridge.
// Owns exactly one modal instance and rejects stale async mounts/close callbacks.

import { createLogger } from '../logger.ts';

const log = createLogger('ServerSettingsSvelte');

type TabId = 'general' | 'roles' | 'media' | 'emoji' | 'webhooks' | 'audit' | 'health' | 'sso' | 'plugins' | 'onboarding';

type Disposer = () => void;

let _disposeCurrent: Disposer | null = null;
let _mountGeneration = 0;

export async function mountServerSettingsModal(initialTab: TabId = 'general'): Promise<void> {
  const generation = ++_mountGeneration;
  _disposeCurrent?.();
  _disposeCurrent = null;

  let target = document.getElementById('server-settings-svelte-mount');
  if (!target) {
    target = document.createElement('div');
    target.id = 'server-settings-svelte-mount';
    document.body.appendChild(target);
  }

  // Coalesce same-turn tab switches before loading/mounting the modal.
  await Promise.resolve();
  if (generation !== _mountGeneration) return;

  try {
    const [{ mount, unmount }, { default: ServerSettingsModal }] = await Promise.all([
      import('svelte'),
      import('./ServerSettingsModal.svelte'),
    ]);

    // A newer request won while dynamic imports were pending.  The newer
    // request owns the shared mount host; this stale request must not mount or
    // remove it.
    if (generation !== _mountGeneration) return;

    let disposed = false;
    // `dispose` KENDİ gövdesinden (ve onClose'dan) referans alınır; bu yüzden
    // bildirimi kullanımından ÖNCE gelir ve tek kez atanır.
    // eslint-disable-next-line prefer-const
    let dispose: Disposer;
    const instance = mount(ServerSettingsModal, {
      target,
      props: {
        initialTab,
        onClose: () => {
          // Close only the instance whose callback fired.  An old component
          // must never tear down a newer modal that replaced it.
          dispose();
        },
      },
    });

    dispose = () => {
      if (disposed) return;
      disposed = true;
      unmount(instance);
      if (target?.isConnected) target.remove();
      if (_disposeCurrent === dispose) _disposeCurrent = null;
    };
    _disposeCurrent = dispose;
  } catch (err) {
    log.error('[server-settings] Svelte modal yüklenemedi:', err);
    if (generation === _mountGeneration && target.isConnected) target.remove();
  }
}

export function unmountServerSettingsModal(): void {
  ++_mountGeneration; // invalidate any dynamic import still in flight
  _disposeCurrent?.();
  _disposeCurrent = null;
}
