// client/js/core/canvas-svelte.ts
// Sprint 116 — CanvasEditor mount shim (ADR-0008 Faz 3)
// Collaborative whiteboard canvas
import { mount } from 'svelte';
import CanvasEditor from './CanvasEditor.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('CanvasEditorShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountCanvasEditor(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('canvas-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'canvas-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(CanvasEditor, { target: el, props: {} });
  log.info('CanvasEditor mounted via shim');
}

export function unmountCanvasEditor(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountCanvasEditor(), { once: true });
} else {
  mountCanvasEditor();
}
document.addEventListener('bridge:socket-ready', () => mountCanvasEditor(), { once: true });
