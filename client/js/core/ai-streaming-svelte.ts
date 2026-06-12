// client/js/core/ai-streaming-svelte.ts
// Sprint 116 — AiStreamingPanel mount shim (ADR-0008 Faz 3)
// Streaming AI yanıt paneli
import { mount } from 'svelte';
import AiStreamingPanel from './AiStreamingPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AiStreamingPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAiStreamingPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('ai-streaming-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'ai-streaming-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AiStreamingPanel, { target: el, props: {} });
  log.info('AiStreamingPanel mounted via shim');
}

export function unmountAiStreamingPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAiStreamingPanel(), { once: true });
} else {
  mountAiStreamingPanel();
}
document.addEventListener('bridge:socket-ready', () => mountAiStreamingPanel(), { once: true });
