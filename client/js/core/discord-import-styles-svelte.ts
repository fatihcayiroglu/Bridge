// client/js/core/discord-import-styles-svelte.ts
// Sprint 116 — DiscordImportStyles mount shim (ADR-0008 Faz 3)
// Discord import stil tanımları
import { mount } from 'svelte';
import DiscordImportStyles from './DiscordImportStyles.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('DiscordImportStylesShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountDiscordImportStyles(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('discord-import-styles-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'discord-import-styles-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(DiscordImportStyles, { target: el, props: {} });
  log.info('DiscordImportStyles mounted via shim');
}

export function unmountDiscordImportStyles(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDiscordImportStyles(), { once: true });
} else {
  mountDiscordImportStyles();
}
document.addEventListener('bridge:socket-ready', () => mountDiscordImportStyles(), { once: true });
