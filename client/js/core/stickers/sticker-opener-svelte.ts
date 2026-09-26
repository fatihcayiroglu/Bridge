// client/js/core/stickers/sticker-opener-svelte.ts
// FAZ C3 — Sticker açıcısının mount köprüsü.
//
// Açıcı, kanal başlığındaki mevcut araç çubuğuna (#channel-header içindeki
// .channel-header-actions) yerleşir — ServerSettingsOpener ile aynı yüzey.
// İkinci bir başlık/aksiyon sistemi KURULMAZ.

import { mount, unmount } from 'svelte';
import StickerOpener from './StickerOpener.svelte';
import { createLogger } from '../logger.ts';

const log = createLogger('StickerOpenerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountStickerOpener(): void {
  if (_instance) return;   // tek sahip

  const host = document.querySelector<HTMLElement>('#channel-header .channel-header-actions');
  if (!host) return;       // kabuk henüz hazır değil

  _instance = mount(StickerOpener, { target: host });
  log.info('Sticker açıcısı mount edildi');
}

export function unmountStickerOpener(): void {
  if (!_instance) return;
  void unmount(_instance);
  _instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountStickerOpener, { once: true });
} else {
  mountStickerOpener();
}
document.addEventListener('bridge:socket-ready', mountStickerOpener, { once: true });
