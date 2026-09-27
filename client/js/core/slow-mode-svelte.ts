// client/js/core/slow-mode-svelte.ts
//
// FAZ 8/6 — YAVAŞ MOD: ARKA UÇ UYGULUYORDU, KULLANICI GÖRMÜYORDU.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// `socket/handlers/messages-send.ts` yavaş modu uyguluyor ve ihlalde
// `error:slowmode { remaining, channelId }` yayıyordu. İstemcide bu olayı
// DİNLEYEN kimse yoktu: kullanıcının mesajı gitmiyor ve NEDENİ söylenmiyordu.
// Sessizce başarısız olan bir gönderim, kullanıcı için bozuk bir uygulamadır.
//
// `SlowModeIndicator.svelte` gerçek bir uygulamaydı ama hiçbir giriş
// noktasından import edilmiyor, `setSlowMode`/`startSlowModeCooldown`
// sözleşmesini de kimse çağırmıyordu. Burada YENİDEN YAZILMAZ — bağlanır.
//
// ── ARKA UÇ DAVRANIŞI DEĞİŞMEZ ────────────────────────────────────────────
// Bu modül yalnızca OKUR ve GÖSTERİR. Hiçbir gönderimi engellemez, hiçbir
// zamanlayıcıyı sunucunun yerine geçirmez; kısıtlamanın tek sahibi sunucudur.

import { mount, unmount } from 'svelte';
import SlowModeIndicator from './SlowModeIndicator.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';

const log = createLogger('SlowMode');

let instance: ReturnType<typeof mount> | null = null;
let boundSocket: { on: Function; off: Function } | null = null;

interface ChannelLike { _id?: string; slowmode?: number; slowMode?: number }

/** Sunucu alanı `slowmode`; eski/alternatif yazım da kabul edilir. */
function secondsOf(channel: ChannelLike | null | undefined): number {
  const raw = Number(channel?.slowmode ?? channel?.slowMode ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function applyCurrentChannel(): void {
  if (!BridgeRegistry.has('setSlowMode')) return;
  const channel = BridgeRegistry.call<ChannelLike | null>('getCurrentChannel');
  BridgeRegistry.call('setSlowMode', secondsOf(channel));
}

function onSlowmodeError(payload: unknown): void {
  const data = payload as { remaining?: unknown; channelId?: unknown } | null;
  const remaining = Number(data?.remaining);
  if (!Number.isFinite(remaining) || remaining <= 0) return;

  // Yalnızca AÇIK kanalın uyarısı gösterilir; başka kanaldan gelen bir
  // ihlal uyarısı kullanıcıyı yanlış yere bakmaya iter.
  const current = BridgeRegistry.call<ChannelLike | null>('getCurrentChannel');
  if (data?.channelId && current?._id && String(data.channelId) !== String(current._id)) return;

  if (BridgeRegistry.has('startSlowModeCooldown')) {
    BridgeRegistry.call('startSlowModeCooldown', Math.ceil(remaining));
  }
}

function currentSocket(): { on: Function; off: Function } | null {
  return BridgeRegistry.get<{ on: Function; off: Function }>('socket') ?? null;
}

/**
 * Socket yeniden bağlanmada BAŞKA bir nesne olabilir; her yaşam döngüsü
 * olayında yeniden bağlanılır, eskisinden çözülür.
 */
function syncSocketBinding(): void {
  const socket = currentSocket();
  if (socket === boundSocket) return;
  boundSocket?.off?.('error:slowmode', onSlowmodeError);
  boundSocket = socket;
  boundSocket?.on?.('error:slowmode', onSlowmodeError);
}

export function mountSlowMode(target?: HTMLElement): void {
  if (instance) return;

  // Göstergenin yeri KOMPOZİTÖRÜN yanıdır: kısıtlama orada hissedilir.
  const el = target ?? document.getElementById('slow-mode-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'slow-mode-root';
    const anchor = document.getElementById('msg-input-wrap');
    if (anchor?.parentElement) anchor.parentElement.insertBefore(div, anchor);
    else document.body.appendChild(div);
    return div;
  })();

  instance = mount(SlowModeIndicator, { target: el, props: {} });

  syncSocketBinding();
  document.addEventListener('bridge:channel-selected', applyCurrentChannel);
  document.addEventListener('bridge:socket-ready', syncSocketBinding);
  document.addEventListener('bridge:socket-reconnected', syncSocketBinding);
  // `mount()` senkron döner ama bileşenin `onMount` kayıtları HENÜZ
  // yapılmamış olabilir; hemen çağırmak `setSlowMode` kaydını ıskalar ve
  // gösterge açılışta BOŞ kalırdı (kanal yavaş modda olsa bile).
  queueMicrotask(applyCurrentChannel);
  log.info('Yavaş mod göstergesi hazır');
}

export function unmountSlowMode(): void {
  if (!instance) return;
  boundSocket?.off?.('error:slowmode', onSlowmodeError);
  boundSocket = null;
  document.removeEventListener('bridge:channel-selected', applyCurrentChannel);
  document.removeEventListener('bridge:socket-ready', syncSocketBinding);
  document.removeEventListener('bridge:socket-reconnected', syncSocketBinding);
  void unmount(instance);
  instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSlowMode(), { once: true });
} else {
  mountSlowMode();
}
