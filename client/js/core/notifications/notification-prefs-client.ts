import { t } from '../i18n/index.ts';
// client/js/core/notifications/notification-prefs-client.ts
//
// FAZ K/5 — BILDIRIM TERCIHLERININ ISTEMCI KATMANI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK BOSLUK
// ════════════════════════════════════════════════════════════════════════════
// Sunucu tarafi TAMDI (server/routes/notificationPrefs.ts):
//   GET    /api/notification-prefs?serverId=…   → kanal tercihleri + sunucu seviyesi
//   PUT    /api/notification-prefs              → kanal tercihi (level + muteUntil)
//   PUT    /api/notification-prefs/server       → sunucu seviyesi
//   DELETE /api/notification-prefs/:channelId   → varsayilana don
//
// Istemci tarafinda ise `NotificationPrefsPanel.svelte` 50 satirlik BOS bir
// kabuktu: hicbir API cagrisi, hicbir tercih kontrolu yoktu ve uretim giris
// noktasindan (app.ts) import EDILMIYORDU. Yani kullanici bir kanali
// susturamiyordu — ozellik "var" gorunup YOKTU.
//
// Bu modul yalnizca veri katmanidir; DOM'a dokunmaz ve boylece bilesen
// kurmadan test edilir.

/** Sunucunun kabul ettigi seviyeler (routes/notificationPrefs.ts:71). */
export type NotificationLevel = 'all' | 'mentions' | 'mute' | 'default';

export const LEVELS: readonly NotificationLevel[] = ['all', 'mentions', 'mute'];

export const LEVEL_LABEL_KEY: Record<NotificationLevel, string> = {
  all: 'notif_level_all', mentions: 'notif_level_mentions', mute: 'notif_level_mute', default: 'notif_level_default',
};

export const LEVEL_DESCRIPTION_KEY: Record<NotificationLevel, string> = {
  all: 'notif_desc_all', mentions: 'notif_desc_mentions', mute: 'notif_desc_mute', default: 'notif_desc_default',
};

/** Erteleme secenekleri. `null` = süresiz. */
export interface SnoozeOption { id: string; labelKey: string; ms: number | null }

export const SNOOZE_OPTIONS: readonly SnoozeOption[] = [
  { id: '15m',   labelKey: 'notif_snooze_15m',   ms: 15 * 60_000 },
  { id: '1h',    labelKey: 'notif_snooze_1h',    ms: 60 * 60_000 },
  { id: '8h',    labelKey: 'notif_snooze_8h',    ms: 8 * 60 * 60_000 },
  { id: '24h',   labelKey: 'notif_snooze_24h',   ms: 24 * 60 * 60_000 },
  { id: 'until', labelKey: 'notif_snooze_until', ms: null },
];

export interface ChannelPref {
  channelId: string;
  level: NotificationLevel;
  /** Epoch ms; `null` süresiz sessize alma. */
  muteUntil: number | null;
}

export interface PrefsSnapshot {
  serverLevel: NotificationLevel;
  serverMuteUntil: number | null;
  channels: ChannelPref[];
  /** Server-scoped literal attention words; message/result bodies are never stored here. */
  watchWords: string[];
}

export type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

const VALID = new Set<string>(['all', 'mentions', 'mute', 'default']);
const WATCH_WORD_RE = /^[\p{L}\p{N}_-]{2,32}$/u;
export const MAX_WATCH_WORDS = 10;

function toLevel(value: unknown): NotificationLevel {
  const s = String(value ?? '');
  return VALID.has(s) ? s as NotificationLevel : 'default';
}

function toMuteUntil(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeWatchWord(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  return WATCH_WORD_RE.test(normalized) ? normalized : null;
}

export function normalizeWatchWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_WATCH_WORDS)) {
    const word = normalizeWatchWord(raw);
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** Sunucunun ham satirini normalize eder; taninmayan satir ATILIR. */
export function normalizePref(raw: unknown): ChannelPref | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const channelId = String(row.channelId ?? '');
  // Sunucu, sunucu-seviyesi tercihi `server:<id>` ad alaninda saklar; bunlar
  // KANAL listesine karismamalidir.
  if (!channelId || channelId.startsWith('server:')) return null;
  return { channelId, level: toLevel(row.level), muteUntil: toMuteUntil(row.muteUntil) };
}

/**
 * Sessize alma SURESI DOLMUS mu?
 *
 * Sunucu `muteUntil`i saklar ama gecmis bir zamani kendiliginden temizlemez.
 * Kullaniciya "Sessize alındı" demek, aslinda bildirim aliyorken YANLIS
 * olurdu — suresi gecmis erteleme etkin sayilmaz.
 */
export function isMuteActive(pref: ChannelPref, now = Date.now()): boolean {
  if (pref.level !== 'mute') return false;
  return pref.muteUntil === null || pref.muteUntil > now;
}

/** Kalan erteleme suresini insan diliyle anlatir. */
export function describeMute(pref: ChannelPref, now = Date.now()): string {
  if (pref.level !== 'mute') return '';
  if (pref.muteUntil === null) return t('notif_muted_indefinitely');
  const remaining = pref.muteUntil - now;
  if (remaining <= 0) return t('surface_erteleme_suresi_doldu_121782');

  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return t('notif_muted_minutes', undefined, { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('notif_muted_hours', undefined, { count: hours });
  return t('notif_muted_days', undefined, { count: Math.round(hours / 24) });
}

/** Erteleme secimini mutlak zaman damgasina cevirir. */
export function snoozeUntil(option: SnoozeOption, now = Date.now()): number | null {
  return option.ms === null ? null : now + option.ms;
}

// ── HTTP ───────────────────────────────────────────────────────────────────
//
// Hepsi HATA FIRLATIR. Sessizce basarili gorunmek, kullaniciya kaydedilmemis
// bir ayari kaydedilmis gibi gostermek demektir — bildirim ayarlarinda bu,
// beklenmedik bildirim (ya da kacirilmis mesaj) olarak geri doner.

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function fetchPrefs(api: ApiFetch, serverId: string): Promise<PrefsSnapshot> {
  if (!serverId) return { serverLevel: 'default', serverMuteUntil: null, channels: [], watchWords: [] };

  const res = await expectOk(await api(`/api/notification-prefs?serverId=${encodeURIComponent(serverId)}`));
  const data = await res.json() as { channels?: unknown; serverLevel?: unknown; serverMuteUntil?: unknown; watchWords?: unknown };

  return {
    serverLevel: toLevel(data.serverLevel),
    serverMuteUntil: toMuteUntil(data.serverMuteUntil),
    channels: (Array.isArray(data.channels) ? data.channels : [])
      .map(normalizePref)
      .filter((p): p is ChannelPref => p !== null),
    watchWords: normalizeWatchWords(data.watchWords),
  };
}

export async function saveServerLevel(
  api: ApiFetch, serverId: string, level: NotificationLevel, muteUntil: number | null = null,
): Promise<void> {
  await expectOk(await api('/api/notification-prefs/server', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, level, muteUntil: level === 'mute' ? muteUntil : null }),
  }));
}

export async function saveChannelLevel(
  api: ApiFetch, channelId: string, level: NotificationLevel, muteUntil: number | null = null,
): Promise<void> {
  await expectOk(await api('/api/notification-prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // `muteUntil` yalnizca `mute` icin anlamlidir; sunucu digerlerinde
    // temizler, istemci de yanlis bir deger gondermez.
    body: JSON.stringify({ channelId, level, muteUntil: level === 'mute' ? muteUntil : null }),
  }));
}

export async function resetChannel(api: ApiFetch, channelId: string): Promise<void> {
  await expectOk(await api(`/api/notification-prefs/${encodeURIComponent(channelId)}`, { method: 'DELETE' }));
}


export async function saveWatchWords(
  api: ApiFetch, serverId: string, words: string[],
): Promise<string[]> {
  const normalized = normalizeWatchWords(words);
  if (normalized.length !== words.length || normalized.length > MAX_WATCH_WORDS) {
    throw new Error('Invalid watch words');
  }
  const res = await expectOk(await api('/api/notification-prefs/keywords', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, keywords: normalized }),
  }));
  const data = await res.json() as { watchWords?: unknown };
  return normalizeWatchWords(data.watchWords);
}
