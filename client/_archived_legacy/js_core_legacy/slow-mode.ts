// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SlowModePanel.svelte
//              client/js/core/slow-mode-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { apiFetch } from './api-fetch.js';
import { getAPI } from './globals.js';
// core/slow-mode.ts
// Slow Mode UI — Kanal yöneticisi cooldown ayarı

import { BridgeRegistry }    from './bridge-registry.js';
import { getCurrentChannel } from './globals.js';

const BridgeSlowMode = (() => {

  function renderSlowModeBadge(channel: { slowMode?: number; _id?: string }): void {
    document.getElementById('slow-mode-badge')?.remove();
    if (!channel?.slowmode || channel.slowmode < 1) return;

    const secs  = channel.slowmode as number;
    const label = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}dk` : `${Math.floor(secs / 3600)}sa`;
    const badge = document.createElement('span');
    badge.id        = 'slow-mode-badge';
    badge.className = 'slow-mode-badge';
    badge.title     = `Yavaş mod: ${label} bekleme`;
    badge.textContent = `🐢 ${label}`;
    document.getElementById('channel-topic')?.after(badge);
  }

  let _cooldownTimer: ReturnType<typeof setInterval> | null = null;

  function startCooldown(seconds: number): void {
    if (_cooldownTimer) return;
    const input = document.getElementById('msg-input') as HTMLTextAreaElement | null;
    const btn   = document.getElementById('send-btn')  as HTMLButtonElement  | null;
    if (!input || !btn) return;
    input.disabled = true;
    btn.disabled   = true;

    let left        = seconds;
    const badge     = document.getElementById('slow-mode-badge');
    const origText  = badge?.textContent ?? '';

    const tick = () => {
      if (badge) badge.textContent = `🐢 ${left}s bekleniyor...`;
      left--;
      if (left < 0) {
        input.disabled = false;
        btn.disabled   = false;
        if (badge) badge.textContent = origText;
        if (_cooldownTimer) { clearInterval(_cooldownTimer); _cooldownTimer = null; }
      }
    };
    tick();
    _cooldownTimer = setInterval(tick, 1000);
  }

  async function saveSlowMode(channelId: string, serverId: string, seconds: number): Promise<void> {
    await apiFetch(`${getAPI()}/api/servers/${serverId}/channels/${channelId}`, {
      method: 'PATCH',
      body:   JSON.stringify({ slowmode: parseInt(String(seconds)) || 0 }),
    });
    toast(
      seconds > 0
        ? `🐢 Yavaş mod ${seconds}s olarak ayarlandı`
        : '✅ Yavaş mod kapatıldı',
      'success'
    );
  }

  return { renderSlowModeBadge, startCooldown, saveSlowMode };
})();

// Wrap switchChannel
const _origSwitchChannel: Function | undefined = BridgeRegistry.get('switchChannel');
if (typeof _origSwitchChannel === 'function') {
  BridgeRegistry.register('switchChannel', async function (...args: unknown[]) {
    const result = await _origSwitchChannel.apply(this, args);
    const ch = getCurrentChannel() as { _id: string; serverId?: string; slowMode?: number } | null;
    if (ch) BridgeSlowMode.renderSlowModeBadge(ch);
    return result;
  });
}

// Wrap sendMessage
const _origSendMsg: Function | undefined = BridgeRegistry.get('sendMessage');
if (typeof _origSendMsg === 'function') {
  BridgeRegistry.register('sendMessage', async function (...args: unknown[]) {
    const result = await _origSendMsg.apply(this, args);
    const ch = getCurrentChannel() as { _id: string; serverId?: string; slowMode?: number } | null;
    if (ch?.slowmode > 0) BridgeSlowMode.startCooldown(ch.slowmode);
    return result;
  });
}

export { BridgeSlowMode };
