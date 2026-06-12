// client/js/core/stickers-svelte.ts
// Sprint 116 — StickerPanel mount shim (ADR-0008 Faz 3)
// Sticker gönderme ve yönetim paneli
import { mount } from 'svelte';
import StickerPanel from './StickerPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('StickerPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountStickerPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('stickers-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'stickers-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(StickerPanel, { target: el, props: {} });
  log.info('StickerPanel mounted via shim');
}

export function unmountStickerPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountStickerPanel(), { once: true });
} else {
  mountStickerPanel();
}
document.addEventListener('bridge:socket-ready', () => mountStickerPanel(), { once: true });
