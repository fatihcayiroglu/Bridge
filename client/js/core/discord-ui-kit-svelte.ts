// client/js/core/discord-ui-kit-svelte.ts
// Sprint 116 — DiscordUIKit mount shim (ADR-0008 Faz 3)
// Discord uyumluluk UI bileşenleri
import { mount } from 'svelte';
import DiscordUIKit from './DiscordUIKit.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('DiscordUIKitShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountDiscordUIKit(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('discord-ui-kit-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'discord-ui-kit-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(DiscordUIKit, { target: el, props: {} });
  log.info('DiscordUIKit mounted via shim');
}

export function unmountDiscordUIKit(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDiscordUIKit(), { once: true });
} else {
  mountDiscordUIKit();
}
document.addEventListener('bridge:socket-ready', () => mountDiscordUIKit(), { once: true });
