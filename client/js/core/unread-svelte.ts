// client/js/core/unread-svelte.ts
//
// FAZ 8/2 — OKUNMAMIŞ SİSTEMİ BAĞLANDI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// Sunucu okunmamışları sayıyor, süzüyor ve sunuyordu; `UnreadBadge` de gerçek
// bir durum sahibiydi (başlık + favicon). Aradaki tel YOKTU: sözleşmeyi
// çağıran kimse olmadığı için kullanıcı nerede yeni mesaj olduğunu göremiyordu.
//
// ── VERİ AKIŞI ────────────────────────────────────────────────────────────
//   tohum   : GET /api/notification-prefs/unread   (VIEW_CHANNELS ile süzülmüş)
//   artış   : socket `message:new`  (AKTİF kanal hariç)
//   öncelik : socket `notification:mention`
//   temizlik: kanal seçimi — sunucu da `GET .../messages` sırasında temizler
//             (`routes/messages.ts:clearChannelAttention`), yani ikinci bir
//             "okundu" yolu AÇILMAZ.
//   yeniden bağlanma: tohum tekrar çekilir — sunucu anlık görüntüsü kazanır.
//
// ── YETKİ ─────────────────────────────────────────────────────────────────
// Sayaçlar `(userId, channelId)` ile tutulur ve kullanıcı bir kanalı GÖRME
// yetkisini sonradan kaybetmiş olabilir. Uç bunu zaten kanal başına
// VIEW_CHANNELS ile süzer (fail-closed). Bu modül o süzgeci ATLAMAZ: yalnızca
// ucun döndürdüğünü gösterir ve kendi listesini üretmez.

import { mount, unmount } from 'svelte';
import UnreadBadge from './UnreadBadge.svelte';
import { t } from './i18n/index.ts';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
import { UnreadStore, badgeLabel } from './unread/unread-store.ts';

const log = createLogger('Unread');

const store = new UnreadStore();
let instance: ReturnType<typeof mount> | null = null;
let boundSocket: { on: Function; off: Function } | null = null;
let domReadyPending = false;
const aggregateChannelIds = new Set<string>();

interface ChannelLike { _id?: string; serverId?: string }
interface ServerLike { _id?: string }
interface SocketLike { on: Function; off: Function; emit?: Function }

function activeChannelId(): string {
  return String(BridgeRegistry.call<ChannelLike | null>('getCurrentChannel')?._id ?? '');
}

/** Kanal → sunucu eşlemesi KANONİK kanal listesinden okunur. */
function lookupServerId(channelId: string): string | undefined {
  const channels = BridgeRegistry.has('getCurrentServerChannels')
    ? BridgeRegistry.call<ChannelLike[]>('getCurrentServerChannels')
    : [];
  const match = Array.isArray(channels) ? channels.find(c => c?._id === channelId) : undefined;
  return match?.serverId ?? undefined;
}

// ── Boyama ────────────────────────────────────────────────────────────────
//
// Rozetler MEVCUT çapalara yazılır. `ChannelItem.svelte` her kanal için zaten
// `#unread-<channelId>` üretiyordu ve bu eleman HİÇ doldurulmuyordu; ikinci
// bir kanal listesi sahibi kurmak yerine o çapa kullanılır.

function paintChannelBadges(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[id^="unread-"]')) {
    const channelId = node.id.slice('unread-'.length);
    const count = store.countFor(channelId);
    const label = badgeLabel(count);
    node.textContent = label;
    node.style.display = label ? '' : 'none';
    node.classList.toggle('has-mention', store.hasMention(channelId));
    if (label) {
      node.setAttribute('role', 'status');
      node.setAttribute('aria-label', store.hasMention(channelId)
        ? t('unread_with_mention_aria', '{count} okunmamış mesaj, bahsedilme var', { count })
        : t('unread_messages_aria', '{count} okunmamış mesaj', { count }));
    } else {
      node.removeAttribute('aria-label');
    }
  }
}

function paintServerBadges(): void {
  const servers = BridgeRegistry.has('getAvailableServers')
    ? BridgeRegistry.call<ServerLike[]>('getAvailableServers') ?? []
    : [];
  if (!Array.isArray(servers)) return;

  for (const server of servers) {
    const serverId = String(server?._id ?? '');
    if (!serverId) continue;
    const node = document.querySelector<HTMLElement>(`[data-server-unread="${CSS.escape(serverId)}"]`);
    if (!node) continue;
    const total = store.serverTotal(serverId);
    const label = badgeLabel(total);
    node.textContent = label;
    node.style.display = label ? '' : 'none';
    node.classList.toggle('has-mention', store.serverHasMention(serverId));
    if (label) node.setAttribute('aria-label', t('unread_messages_aria', '{count} okunmamış mesaj', { count: total }));
    else node.removeAttribute('aria-label');
  }
}

function repaint(): void {
  store.backfillServerIds(lookupServerId);
  paintChannelBadges();
  paintServerBadges();
  paintActivity();
  syncAggregate();
}

// ── Etkinlik: okunmamış mesajı olan kanal (Final21 Faz 15) ─────────────────
//
// Sayaçlar yalnızca bahsetme/yanıt için vardı; düz bir mesaj, bakılmayan kanalda
// HİÇBİR iz bırakmıyordu. Durum sunucudan gelir:
//   tohum : GET /api/notification-prefs/unread-channels (görünürlük + sessize alma
//           sunucuda uygulanır; sessize alınanlar canlı süzgeç için döner)
//   canlı : `channel:activity` — yalnızca bakılan sunucunun GÖRÜLEBİLİR kanalları
//           için (`channels:watch`), içerik taşımaz
//   okundu: açık kanalda canlı görülen mesaj → POST /api/channels/:id/read
//           (sekme görünürken, gecikmeli; kanal değişirken hemen)

const activity = new Map<string, string>();   // channelId → serverId
let mutedChannels = new Set<string>();
let mutedServers = new Set<string>();
let watchedServerId = '';
let watchedSocket: SocketLike | null = null;
let pendingRead: { channelId: string; messageId: string } | null = null;
let readTimer: ReturnType<typeof setTimeout> | null = null;
const READ_DEBOUNCE_MS = 1_200;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function currentServerId(): string {
  const channel = BridgeRegistry.has('getCurrentChannel') ? BridgeRegistry.call<ChannelLike | null>('getCurrentChannel') : null;
  if (channel?.serverId) return String(channel.serverId);
  const server = BridgeRegistry.has('currentServer') ? BridgeRegistry.call<ServerLike | null>('currentServer') : null;
  return String(server?._id ?? '');
}

function paintActivity(): void {
  const active = activeChannelId();
  for (const item of document.querySelectorAll<HTMLElement>('.ch-item[data-id]')) {
    const channelId = item.dataset.id ?? '';
    const unread = channelId !== '' && channelId !== active && activity.has(channelId);
    const open = item.querySelector<HTMLElement>('.ch-open');
    if (unread) {
      item.setAttribute('data-unread', 'true');
      open?.setAttribute('aria-description', t('channel_unread_aria', 'Okunmamış mesajlar var'));
    } else {
      item.removeAttribute('data-unread');
      open?.removeAttribute('aria-description');
    }
  }
  const servers = new Set<string>();
  for (const [channelId, serverId] of activity) if (serverId && channelId !== active) servers.add(serverId);
  for (const icon of document.querySelectorAll<HTMLElement>('.server-icon[data-id]')) {
    if (servers.has(icon.dataset.id ?? '')) icon.setAttribute('data-has-unread', 'true');
    else icon.removeAttribute('data-has-unread');
  }
}

async function seedActivity(): Promise<void> {
  const apiFetch = BridgeRegistry.get<(u: string) => Promise<Response>>('apiFetch');
  if (!apiFetch) return;
  try {
    const res = await apiFetch('/api/notification-prefs/unread-channels');
    if (!res.ok) return;
    const data = await res.json() as {
      channels?: Array<{ channelId?: unknown; serverId?: unknown }>;
      muted?: { channels?: unknown; servers?: unknown };
    };
    activity.clear();
    for (const row of Array.isArray(data.channels) ? data.channels : []) {
      if (typeof row?.channelId !== 'string' || !row.channelId) continue;
      activity.set(row.channelId, typeof row.serverId === 'string' && row.serverId ? row.serverId : lookupServerId(row.channelId) ?? '');
    }
    mutedChannels = new Set(strings(data.muted?.channels));
    mutedServers = new Set(strings(data.muted?.servers));
    activity.delete(activeChannelId());
    paintActivity();
  } catch (err) {
    // Tohum alınamazsa önceki durum korunur; UYDURMA etkinlik gösterilmez.
    log.warn('Kanal etkinliği tohumu alınamadı', err);
  }
}

async function flushRead(): Promise<void> {
  if (readTimer) { clearTimeout(readTimer); readTimer = null; }
  const target = pendingRead;
  pendingRead = null;
  if (!target) return;
  const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
  if (!apiFetch) return;
  try {
    await apiFetch(`/api/channels/${encodeURIComponent(target.channelId)}/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: target.messageId }),
    });
  } catch (err) {
    log.warn('Okundu imleci ilerletilemedi', err);
  }
}

function noteSeenLive(channelId: string, messageId: string): void {
  if (!messageId) return;
  pendingRead = { channelId, messageId };
  // Arka plandaki sekmede gelen mesaj GÖRÜLMEMİŞTİR; sekme görünür olunca işaretlenir.
  if (document.visibilityState !== 'visible') return;
  if (readTimer) clearTimeout(readTimer);
  readTimer = setTimeout(() => { void flushRead(); }, READ_DEBOUNCE_MS);
}

function onChannelActivity(payload: unknown): void {
  const data = payload as { channelId?: unknown; serverId?: unknown; messageId?: unknown; userId?: unknown } | null;
  const channelId = typeof data?.channelId === 'string' ? data.channelId : '';
  if (!channelId) return;
  const serverId = typeof data?.serverId === 'string' ? data.serverId : lookupServerId(channelId) ?? '';
  const me = BridgeRegistry.has('getMe') ? BridgeRegistry.call<{ _id?: string } | null>('getMe') : null;
  if (me?._id && data?.userId === me._id) return;
  if (channelId === activeChannelId()) {
    noteSeenLive(channelId, typeof data?.messageId === 'string' ? data.messageId : '');
    return;
  }
  if (mutedChannels.has(channelId) || (serverId && mutedServers.has(serverId))) return;
  activity.set(channelId, serverId);
  paintActivity();
}

function syncWatch(force = false): void {
  const socket = currentSocket();
  const serverId = currentServerId();
  if (!socket?.emit || !serverId) return;
  if (!force && serverId === watchedServerId && socket === watchedSocket) return;
  watchedServerId = serverId;
  watchedSocket = socket;
  socket.emit('channels:watch', { serverId });
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') return;
  if (pendingRead) noteSeenLive(pendingRead.channelId, pendingRead.messageId);
  void seedActivity();
}

function onServerSwitch(): void {
  // Kanal listesi henüz değişmemiş olabilir; izleme kanal seçimiyle de yeniden eşitlenir.
  queueMicrotask(() => syncWatch());
}

/** Başlık/favicon sahibi `UnreadBadge`tir; toplamlar oraya beslenir. */
function syncAggregate(): void {
  if (!BridgeRegistry.has('setChannelUnread')) return;
  const current = new Set<string>();
  for (const row of store.channels()) {
    current.add(row.channelId);
    BridgeRegistry.call('setChannelUnread', row.channelId, row.count, row.mention);
  }
  // A reconnect seed is an authoritative snapshot. Explicitly clear channels
  // that disappeared from it; otherwise the headless UnreadBadge retains its
  // old count and leaves the favicon/title permanently stale.
  for (const channelId of aggregateChannelIds) {
    if (!current.has(channelId)) BridgeRegistry.call('clearChannelUnread', channelId);
  }
  aggregateChannelIds.clear();
  for (const channelId of current) aggregateChannelIds.add(channelId);
}

// ── Veri ──────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  const apiFetch = BridgeRegistry.get<(u: string) => Promise<Response>>('apiFetch');
  if (!apiFetch) return;
  try {
    const res = await apiFetch('/api/notification-prefs/unread');
    if (!res.ok) return;
    const data = await res.json() as { channels?: Array<{ channelId: string; count: number }> };
    store.replaceAll(Array.isArray(data.channels) ? data.channels : [], lookupServerId);
    repaint();
  } catch (err) {
    // Tohum alınamadıysa sayaçlar boş kalır — UYDURMA sayı gösterilmez.
    log.warn('Okunmamış tohumu alınamadı', err);
  }
}

function onMessageNew(payload: unknown): void {
  const msg = payload as { channelId?: string; serverId?: string; userId?: string } | null;
  const channelId = String(msg?.channelId ?? '');
  if (!channelId) return;

  // AÇIK kanal okunmuş sayılır; sunucu da o kanalı okurken temizliyor.
  if (channelId === activeChannelId()) return;

  // Kendi mesajımız okunmamış üretmez.
  const me = BridgeRegistry.has('getMe') ? BridgeRegistry.call<{ _id?: string } | null>('getMe') : null;
  if (me?._id && msg?.userId === me._id) return;

  store.increment(channelId, String(msg?.serverId ?? '') || lookupServerId(channelId) || '');
  repaint();
}

function onMention(payload: unknown): void {
  const data = payload as { channelId?: string; serverId?: string } | null;
  const channelId = String(data?.channelId ?? '');
  if (!channelId || channelId === activeChannelId()) return;
  store.increment(channelId, String(data?.serverId ?? '') || lookupServerId(channelId) || '', { mention: true });
  repaint();
}

function onChannelSelected(): void {
  const channelId = activeChannelId();
  // Önceki kanalda canlı görülen son mesaj hemen işaretlenir; aksi halde kanal
  // geçmiş yüklemesinden SONRA gelen mesajlar yüzünden okunmamış görünürdü.
  if (pendingRead && pendingRead.channelId !== channelId) void flushRead();
  activity.delete(channelId);
  syncWatch();
  if (channelId) {
    store.clear(channelId);
    if (BridgeRegistry.has('clearChannelUnread')) BridgeRegistry.call('clearChannelUnread', channelId);
  }
  // Kanal listesi yeni çizilmiş olabilir; çapalar yeniden doldurulur.
  queueMicrotask(repaint);
}

function currentSocket(): SocketLike | null {
  return BridgeRegistry.get<SocketLike>('socket') ?? null;
}

const SOCKET_EVENTS: Array<[string, (p: unknown) => void]> = [
  ['message:new', onMessageNew],
  ['notification:mention', onMention],
  ['channel:activity', onChannelActivity],
];

function syncSocketBinding(): void {
  const socket = currentSocket();
  if (socket === boundSocket) return;
  for (const [event, handler] of SOCKET_EVENTS) boundSocket?.off?.(event, handler);
  boundSocket = socket;
  for (const [event, handler] of SOCKET_EVENTS) boundSocket?.on?.(event, handler);
}

function onReconnect(): void {
  syncSocketBinding();
  // Yeni soket izleme odalarında DEĞİLDİR; yeniden istenir.
  syncWatch(true);
  // Çevrimdışıyken kaçırılan mesajlar yerel sayaçta YOKTUR; sunucu anlık
  // görüntüsü tek doğrudur.
  void seed();
  void seedActivity();
}

function onAuthSuccess(): void { void seed(); void seedActivity(); }

// ── Yaşam döngüsü ─────────────────────────────────────────────────────────

function cancelPendingDomReadyMount(): void {
  if (!domReadyPending) return;
  document.removeEventListener('DOMContentLoaded', onDomReady);
  domReadyPending = false;
}

function onDomReady(): void {
  domReadyPending = false;
  mountUnread();
}

export function mountUnread(target?: HTMLElement): void {
  cancelPendingDomReadyMount();
  if (instance) return;
  const el = target ?? document.getElementById('unread-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'unread-root';
    div.hidden = true;   // toplam rozet görsel değil; başlık/favicon sahibi
    document.body.appendChild(div);
    return div;
  })();
  instance = mount(UnreadBadge, { target: el, props: {} });

  syncSocketBinding();
  document.addEventListener('bridge:channel-selected', onChannelSelected);
  // `bridge:channels-updated` hiçbir yerde yayınlanmıyordu (ölü dinleyici); sunucu
  // değişimi `bridge:load-channels` ile gelir.
  document.addEventListener('bridge:load-channels', onServerSwitch);
  document.addEventListener('bridge:socket-ready', onReconnect);
  document.addEventListener('bridge:socket-reconnected', onReconnect);
  document.addEventListener('bridge:auth-success', onAuthSuccess);
  document.addEventListener('visibilitychange', onVisibilityChange);

  queueMicrotask(() => { void seed(); void seedActivity(); });
  log.info('Okunmamış sistemi hazır');
}

export function unmountUnread(): void {
  cancelPendingDomReadyMount();
  if (!instance) return;
  for (const [event, handler] of SOCKET_EVENTS) boundSocket?.off?.(event, handler);
  boundSocket = null;
  document.removeEventListener('bridge:channel-selected', onChannelSelected);
  document.removeEventListener('bridge:load-channels', onServerSwitch);
  document.removeEventListener('bridge:socket-ready', onReconnect);
  document.removeEventListener('bridge:socket-reconnected', onReconnect);
  document.removeEventListener('bridge:auth-success', onAuthSuccess);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (readTimer) { clearTimeout(readTimer); readTimer = null; }
  pendingRead = null;
  activity.clear();
  watchedServerId = '';
  watchedSocket = null;
  aggregateChannelIds.clear();
  void unmount(instance);
  instance = null;
}

/** Test ve teşhis için salt-okunur erişim. */
export const _unreadStore = store;
export const _channelActivity = activity;

if (document.readyState === 'loading') {
  domReadyPending = true;
  document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
} else {
  mountUnread();
}
