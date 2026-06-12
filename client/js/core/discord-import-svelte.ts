// client/js/core/discord-import-svelte.ts
// Sprint 116 — DiscordImportPanel mount shim (ADR-0008 Faz 3)
// Discord veri içe aktarma sihirbazı
import { mount } from 'svelte';
import DiscordImportPanel from './DiscordImportPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('DiscordImportPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountDiscordImportPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('discord-import-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'discord-import-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(DiscordImportPanel, { target: el, props: {} });
  log.info('DiscordImportPanel mounted via shim');
}

export function unmountDiscordImportPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDiscordImportPanel(), { once: true });
} else {
  mountDiscordImportPanel();
}
document.addEventListener('bridge:socket-ready', () => mountDiscordImportPanel(), { once: true });
