// client/js/core/server-settings/server-settings-svelte.ts
// Svelte ServerSettingsModal mount köprüsü
// Sprint 114: initialTab parametresi eklendi (openEmojiManager gibi çağrılar için)

import { createLogger } from '../logger.ts';

const log = createLogger('ServerSettingsSvelte');

type TabId = 'general' | 'media' | 'emoji' | 'webhooks' | 'audit' | 'sso' | 'plugins' | 'onboarding';

let _unmount: (() => void) | null = null;

export async function mountServerSettingsModal(initialTab: TabId = 'general'): Promise<void> {
  if (_unmount) {
    _unmount();
    _unmount = null;
  }

  let target = document.getElementById('server-settings-svelte-mount');
  if (!target) {
    target = document.createElement('div');
    target.id = 'server-settings-svelte-mount';
    document.body.appendChild(target);
  }

  try {
    const { mount, unmount } = await import('svelte');
    const { default: ServerSettingsModal } = await import('./ServerSettingsModal.svelte');

    const instance = mount(ServerSettingsModal, {
      target,
      props: {
        initialTab,
        onClose: () => {
          if (_unmount) {
            _unmount();
            _unmount = null;
          }
        },
      },
    });

    _unmount = () => {
      unmount(instance);
      target?.remove();
    };
  } catch (err) {
    log.error('[server-settings] Svelte modal yüklenemedi:', err);
    target.remove();
  }
}

export function unmountServerSettingsModal(): void {
  _unmount?.();
  _unmount = null;
}
