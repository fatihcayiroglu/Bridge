// client/js/core/desktop-voice-bar-svelte.ts
// Sprint 116 — DesktopVoiceBar mount shim (ADR-0008 Faz 3)
// Masaüstü ses durum çubuğu
import { mount } from 'svelte';
import DesktopVoiceBar from './DesktopVoiceBar.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('DesktopVoiceBarShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountDesktopVoiceBar(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('desktop-voice-bar-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'desktop-voice-bar-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(DesktopVoiceBar, { target: el, props: {} });
  log.info('DesktopVoiceBar mounted via shim');
}

export function unmountDesktopVoiceBar(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDesktopVoiceBar(), { once: true });
} else {
  mountDesktopVoiceBar();
}
document.addEventListener('bridge:socket-ready', () => mountDesktopVoiceBar(), { once: true });
