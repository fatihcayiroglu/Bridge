// client/js/core/upload-svelte.ts
// Sprint 116 — UploadManager mount shim (ADR-0008 Faz 3)
// Dosya yükleme ilerleme yöneticisi
import { mount } from 'svelte';
import UploadManager from './UploadManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('UploadManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountUploadManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('upload-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'upload-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(UploadManager, { target: el, props: {} });
  log.info('UploadManager mounted via shim');
}

export function unmountUploadManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountUploadManager(), { once: true });
} else {
  mountUploadManager();
}
document.addEventListener('bridge:socket-ready', () => mountUploadManager(), { once: true });
