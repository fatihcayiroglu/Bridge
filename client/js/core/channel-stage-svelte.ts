// client/js/core/channel-stage-svelte.ts
// Sprint 116 — ChannelStagePanel mount shim (ADR-0008 Faz 3)
// Stage kanal kontrol paneli
import { mount, unmount } from 'svelte';
import ChannelStagePanel from './ChannelStagePanel.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('ChannelStagePanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountChannelStagePanel(target?: HTMLElement): void {
  if (_instance) return;
  // Faz 8.3: sahne durumu ANA İÇERİK alanında görünmeli. Mevcut kabuk
  // `#voice-view` kullanılır (index.html); yeni kapsayıcı üretilmez.
  // Kabuk yoksa gövdeye düşülür — bileşen yine de kayıtlarını yapar.
  const el = target ?? document.getElementById('voice-view') ?? document.getElementById('channel-stage-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'channel-stage-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ChannelStagePanel, { target: el, props: {} });
  log.info('ChannelStagePanel mounted via shim');
}

export function unmountChannelStagePanel(): void {
  if (!_instance) return;
  const inst = _instance;
  _instance = null;
  void unmount(inst);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountChannelStagePanel(), { once: true });
} else {
  mountChannelStagePanel();
}
document.addEventListener('bridge:socket-ready', () => mountChannelStagePanel(), { once: true });
