// client/js/core/image-viewer-svelte.ts
// Sprint 116 — ImageViewerPanel mount shim (ADR-0008 Faz 3)
// Resim büyütme ve gezinti overlay
import { mount } from 'svelte';
import ImageViewerPanel from './ImageViewerPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ImageViewerPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountImageViewerPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('image-viewer-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'image-viewer-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ImageViewerPanel, { target: el, props: {} });
  log.info('ImageViewerPanel mounted via shim');
}

export function unmountImageViewerPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountImageViewerPanel(), { once: true });
} else {
  mountImageViewerPanel();
}
document.addEventListener('bridge:socket-ready', () => mountImageViewerPanel(), { once: true });
