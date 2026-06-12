// client/js/core/ai-svelte.ts
// Sprint 116 — AiPanel mount shim (ADR-0008 Faz 3)
// AI asistan ve öneriler paneli
import { mount } from 'svelte';
import AiPanel from './AiPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AiPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAiPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('ai-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'ai-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AiPanel, { target: el, props: {} });
  log.info('AiPanel mounted via shim');
}

export function unmountAiPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAiPanel(), { once: true });
} else {
  mountAiPanel();
}
document.addEventListener('bridge:socket-ready', () => mountAiPanel(), { once: true });
