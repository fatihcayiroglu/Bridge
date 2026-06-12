// client/js/core/channel-stage-svelte.ts
// Sprint 116 — ChannelStagePanel mount shim (ADR-0008 Faz 3)
// Stage kanal kontrol paneli
import { mount } from 'svelte';
import ChannelStagePanel from './ChannelStagePanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ChannelStagePanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountChannelStagePanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('channel-stage-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'channel-stage-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ChannelStagePanel, { target: el, props: {} });
  log.info('ChannelStagePanel mounted via shim');
}

export function unmountChannelStagePanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountChannelStagePanel(), { once: true });
} else {
  mountChannelStagePanel();
}
document.addEventListener('bridge:socket-ready', () => mountChannelStagePanel(), { once: true });
