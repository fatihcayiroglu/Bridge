
import { createLogger } from '../logger.ts';
const log = createLogger('ChanPermsSvelte');

// client/js/core/channel-perms/channel-perms-svelte.ts
// Sprint 63: Svelte shell artık içerik panellerini de yönetiyor.
// Props reaktif olarak güncellenebilir — modal-core.ts updateProps() ile çağırır.

let _unmount: (() => void) | null = null;
let _updateProps: ((patch: Record<string, unknown>) => void) | null = null;

export interface ChannelPermsShellHandle {
  /** @deprecated artık kullanılmıyor — Svelte içerik hostuna gerek kalmadı */
  contentHost: HTMLElement | null;
  setActiveTab: (tab: string) => void;
  /** Svelte prop'larını reaktif olarak güncelle */
  updateProps: (patch: Record<string, unknown>) => void;
  unmount: () => void;
}

export interface ChannelPermsShellOptions {
  channelId:   string;
  channelName: string;
  onClose:     () => void;
  /** Başlangıç prop'ları — mount anında geçirilir */
  initialProps?: Record<string, unknown>;
}

export async function mountChannelPermsShell(
  channelId: string,
  channelName: string,
  onClose: () => void,
  initialProps: Record<string, unknown> = {},
): Promise<ChannelPermsShellHandle | null> {
  if (_unmount) _unmount();

  const target = document.createElement('div');
  target.id = 'ch-perms-svelte-mount';
  document.body.appendChild(target);

  try {
    const { mount, unmount } = await import('svelte');
    const { default: ChannelPermsModal } = await import('./ChannelPermsModal.svelte');

    // Reactive state — $state() benzeri, Svelte 5 rune ile
    let activeTab = (initialProps.activeTab as string) ?? 'matrix';

    // Tüm prop'ları bir objede tut — updateProps patch uygular
    const props: Record<string, unknown> = {
      channelId,
      channelName,
      activeTab,
      onClose: () => {
        onClose();
      },
      onTab: (tab: string) => {
        activeTab = tab;
        _updateProps?.({ activeTab: tab });
      },
      onEscapeRequest: onClose,
      ...initialProps,
    };

    const ChannelPermsComponent = ChannelPermsModal as unknown as Parameters<typeof mount>[0];
    const instance = mount(ChannelPermsComponent, { target, props });

    const handle: ChannelPermsShellHandle = {
      contentHost: null, // artık kullanılmıyor
      setActiveTab: (t: string) => { _updateProps?.({ activeTab: t }); },
      updateProps: (patch: Record<string, unknown>) => {
        // Svelte 5: mount'tan dönen instance üzerinden $set benzeri güncelleme
        (instance as unknown as { $set?: (patch: Record<string, unknown>) => void }).$set?.(patch);
        // Svelte 5 rune tabanlı build'de props reaktif zaten; fallback olarak
        // unmount + remount yerine patch tercih edilir.
        Object.assign(props, patch);
      },
      unmount: () => {
        unmount(instance);
        target.remove();
        _unmount = null;
        _updateProps = null;
      },
    };

    _unmount = handle.unmount;
    _updateProps = handle.updateProps;
    return handle;
  } catch (err) {
    log.error('[channel-perms] Svelte shell yuklenemedi:', err);
    target.remove();
    return null;
  }
}

export function unmountChannelPermsShell(): void {
  _unmount?.();
  _unmount = null;
  _updateProps = null;
}
