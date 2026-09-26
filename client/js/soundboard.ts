import { BridgeRegistry } from './core/bridge-registry.ts';
import { t } from './core/i18n/index';
import { resolveLocalAssetUrl } from './core/local-asset-url.ts';
import { getAPI } from './core/globals.ts';
import { createLogger } from './core/logger.ts';
import { confirmProductAction } from './core/product-dialog.ts';
import { safeApiErrorMessage } from './core/api-error.ts';

const log = createLogger('Soundboard');

// ── KANONİK HTTP İSTEMCİSİ ──────────────────────────────────────────────────
// CANLI ÜRÜNDE YAKALANDI (v1.124.1, gerçek tarayıcı): Soundboard paneli her
// açılışta gövdesinde ham `apiFetch is not defined` gösteriyordu. Sebep: bu
// modül HTTP istemcisine SERBEST BİR DEĞİŞKEN olarak `apiFetch(...)` diye
// erişiyordu — ne import, ne yerel tanım, ne de bir global atama vardı.
//
// Neden testte görünmedi: testler `vi.stubGlobal('apiFetch', …)` ile onu bir
// GLOBAL olarak enjekte ediyordu; üretimde böyle bir global YOK. Bu, bu kod
// tabanında belgelenen "testte yeşil, üründe kırık" sınıfının bir örneğidir
// (CSRF ve registry-apiFetch ilk ikisiydi — bkz. `core/api-fetch.ts`).
//
// Kanonik çözüm: HTTP istemcisi `core/api-fetch.ts` içinde
// `BridgeRegistry.register('apiFetch', …)` ile KAYITLIDIR. On küsur bileşen
// (ör. `GroupDmPanel`) ona bu registry sarmalayıcısıyla ulaşır. Soundboard da
// artık aynı kanonik yolu kullanır — böylece test ve üretim AYNI yoldan geçer
// ve sınıf kapanır. İkinci bir HTTP istemcisi ÜRETİLMEZ.
function apiFetch(url: string, opts?: RequestInit): Promise<Response> {
  const fn = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
  if (!fn) return Promise.reject(new Error(t('snd_client_unavailable', 'Bağlantı hazır değil')));
  // GET çağrılarında ARİTE korunur: `fn(url)` — böylece gerçek istemcinin
  // `apiFetch(url)` sözleşmesi (ve onu doğrulayan testler) aynen geçerli kalır;
  // gereksiz bir `undefined` ikinci argüman iletilmez.
  return opts === undefined ? fn(url) : fn(url, opts);
}

// ── KANONİK API TABANI ──────────────────────────────────────────────────────
// AYNI SINIF (v1.124.1, gerçek tarayıcı): `apiFetch` düzeltildikten sonra panel
// bu kez gövdesinde ham `API is not defined` gösterdi. Sebep: bu modül API
// tabanına da SERBEST BİR GLOBAL `API` olarak erişiyordu (`${API}/api/...`) —
// üretimde böyle bir global YOK. Kanonik çözücü `core/globals.ts` içindeki
// `getAPI()`'dir (globalThis.BRIDGE_API varsa onu, yoksa location.origin).
// Önce (testlerin enjekte ettiği) global'i, sonra kanonik çözücüyü kullanırız;
// böylece üretim çalışır ve mevcut testler aynen yeşil kalır.
function apiBase(): string {
  const g = (globalThis as { API?: unknown }).API;
  if (typeof g === 'string' && g.length > 0) return g;
  return getAPI();
}

// ── KANONİK BİLDİRİM (TOAST) ─────────────────────────────────────────────────
// AYNI SINIF: serbest `toast(...)` çağrıları üretimde `toast is not defined`
// riskindeydi. Alıcı `ApiErrorToast.svelte`'tir ve kendini registry'ye 'toast'
// olarak kaydeder (bkz. `core/utils.ts`). 2-argümanlı çağrı sözleşmesini
// koruyarak önce (test) global'i, sonra registry alıcısını kullanırız.
function toast(message: string, type = 'info'): void {
  const g = (globalThis as { toast?: (m: string, t?: string) => void }).toast;
  if (typeof g === 'function') { g(message, type); return; }
  const fn = BridgeRegistry.get<(m: string, t?: string) => void>('toast');
  if (fn) fn(message, type);
}

// ── SEÇİLİ SUNUCU GERİ DÜŞÜŞÜ ────────────────────────────────────────────────
// `getCurrentServer` registry'de kayıtlıdır (AppState). Onun boş döndüğü ender
// durumda kod serbest `currentServer` global'ine düşüyordu — üretimde tanımsız
// olduğundan `toast('sunucu seç')` yerine ham ReferenceError üretirdi. Geri
// düşüşü de kanonik registry (veya test global'i) üzerinden güvenli çözeriz.
function currentServerFallback(): { _id?: string } | null {
  const g = (globalThis as { currentServer?: unknown }).currentServer;
  if (g && typeof g === 'object') return g as { _id?: string };
  const reg = BridgeRegistry.get<unknown>('currentServer');
  return reg && typeof reg === 'object' ? (reg as { _id?: string }) : null;
}

// Metadata is cursor-paged and each response is clamped again on the client,
// so a faulty server cannot make the browser render an unbounded library.
export const SOUNDBOARD_PAGE_SIZE = 48;
// Infinite scrolling may accumulate metadata for the portion of the library the
// user has actually visited, but the live DOM remains a small virtual window.
// This is a rendering bound, not a library-size limit.
export const SOUNDBOARD_DOM_WINDOW_SIZE = 72;
export const SOUNDBOARD_MAX_REMOTE_PLAYBACKS = 4;
const MAX_SOUND_FILE_BYTES = 5 * 1024 * 1024;
const SEARCH_DEBOUNCE_MS = 250;
const REPEAT_GUARD_MS = 250;
const DESKTOP_GRID_ROW_HEIGHT = 100;
const COMPACT_GRID_ROW_HEIGHT = 88;

// ── SOĞUMA (COOLDOWN) ───────────────────────────────────────────────────────
// Sunucu `soundboard:play` için varsayılan olarak 5 saniyede 6 olay kabul eder
// (`server/socket/socketRateLimit.ts`). Sınır aşıldığında olay SESSİZCE düşer ve
// yalnızca `error:ratelimit` yayılır. İstemci bunu göstermezse kullanıcı,
// çalmadığını fark etmeden düğmeye basmaya devam eder.
//
// Bu yüzden iki katman vardır:
//   1. Yerel bütçe — aynı pencere sayılır; sınır YEREL olarak aşıldığında
//      soğuma başlar ve olay hiç gönderilmez (gereksiz throttle üretilmez).
//   2. Sunucu `error:ratelimit` — otorite budur; geldiğinde soğuma yenilenir.
// Yerel bütçe bir yetkilendirme değildir; yalnızca dürüst bir arayüz durumudur.
export const SOUNDBOARD_PLAY_BUDGET = 6;
export const SOUNDBOARD_PLAY_WINDOW_MS = 5_000;
const COOLDOWN_TICK_MS = 250;
const SETTINGS_KEY = 'bridge.soundboard.settings.v1';
const USAGE_KEY_PREFIX = 'bridge.soundboard.usage.v1.';

const BUILTIN_TONES: Readonly<Record<string, readonly number[]>> = Object.freeze({
  chime: [523, 659, 784], pop: [740, 420], drum: [150, 90], notify: [660, 880],
});

type SoundboardCategory = 'all' | 'favorites' | 'recent' | 'frequent' | 'server' | 'global';
interface SoundboardSound {
  _id: string; name: string; emoji: string; url: string; scope: 'server' | 'global';
  category: string; favorite: boolean; playCount: number; lastPlayedAt: number | null; locked: boolean;
}
interface SoundboardPage { items: SoundboardSound[]; nextCursor: string | null; canManage: boolean }
interface UsageEntry { count: number; lastPlayedAt: number }
interface SoundboardSettings { volume: number; muted: boolean; suppressedUserIds: string[] }
interface SocketLike {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off?(event: string, handler: (...args: unknown[]) => void): unknown;
  emit(event: string, payload: unknown): unknown;
}
interface ActivePlayback { audio: HTMLAudioElement; soundId: string; cleanup(): void }

let _soundboardServerId: string | null = null;
let _soundboardSounds: SoundboardSound[] = [];
let _soundboardAudio: ActivePlayback | null = null;
let _soundPreviewUrl: string | null = null;
let _soundboardCategory: SoundboardCategory = 'all';
let _soundboardQuery = '';
let _soundboardCursor: string | null = null;
let _soundboardNextCursor: string | null = null;
let _soundboardCursorHistory: Array<string | null> = [];
let _soundboardCanManage = false;
let _soundboardRequestGeneration = 0;
let _soundboardPlayGeneration = 0;
let _searchTimer: ReturnType<typeof setTimeout> | null = null;
let _panelReturnFocus: HTMLElement | null = null;
let _uploadReturnFocus: HTMLElement | null = null;
let _manageReturnFocus: HTMLElement | null = null;
let _uploadInFlight = false;
let _manageInFlight = false;
let _soundboardAppendInFlight = false;
let _managedSoundId: string | null = null;
let _cooldownUntil = 0;
let _cooldownTimer: ReturnType<typeof setInterval> | null = null;
const _remotePlaybacks: ActivePlayback[] = [];
const _recentRemotePlays = new Map<string, number>();
const _localPlayTimestamps: number[] = [];
let _soundboardRenderedWindowStart = 0;

function clampVolume(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.8;
}

function loadSettings(): SoundboardSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') as Partial<SoundboardSettings> | null;
    return {
      volume: clampVolume(parsed?.volume ?? 0.8), muted: parsed?.muted === true,
      suppressedUserIds: Array.isArray(parsed?.suppressedUserIds)
        ? parsed.suppressedUserIds.filter((id): id is string => typeof id === 'string').slice(0, 100) : [],
    };
  } catch { return { volume: 0.8, muted: false, suppressedUserIds: [] }; }
}
let _settings = loadSettings();
function saveSettings(): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings)); } catch { /* storage may be disabled */ }
}
export function setSoundboardVolume(value: number): void {
  _settings = { ..._settings, volume: clampVolume(value) }; saveSettings();
  if (_soundboardAudio) _soundboardAudio.audio.volume = _settings.muted ? 0 : _settings.volume;
  for (const playback of _remotePlaybacks) playback.audio.volume = _settings.muted ? 0 : _settings.volume;
  syncSettingsControls();
}
export function setSoundboardMuted(muted: boolean): void {
  _settings = { ..._settings, muted: Boolean(muted) }; saveSettings();
  const volume = _settings.muted ? 0 : _settings.volume;
  if (_soundboardAudio) _soundboardAudio.audio.volume = volume;
  for (const playback of _remotePlaybacks) playback.audio.volume = volume;
  syncSettingsControls();
}
export function setSoundboardUserSuppressed(userId: string, suppressed: boolean): void {
  if (!userId) return;
  const ids = new Set(_settings.suppressedUserIds);
  if (suppressed) ids.add(userId); else ids.delete(userId);
  _settings = { ..._settings, suppressedUserIds: [...ids].slice(-100) }; saveSettings();
}
export function isSoundboardUserSuppressed(userId: string): boolean {
  return Boolean(userId) && _settings.suppressedUserIds.includes(userId);
}
function syncSettingsControls(): void {
  const mute = document.querySelector<HTMLButtonElement>('[data-soundboard-action="mute"]');
  if (mute) {
    mute.setAttribute('aria-pressed', String(_settings.muted)); mute.classList.toggle('active', _settings.muted);
    mute.textContent = _settings.muted ? '🔇' : '🔊';
    mute.title = _settings.muted ? t('snd_unmute', 'Soundboard sesini aç') : t('snd_mute', 'Soundboard sesini kapat');
    mute.setAttribute('aria-label', mute.title);
  }
  const volume = document.getElementById('soundboard-volume') as HTMLInputElement | null;
  if (volume) { volume.value = String(Math.round(_settings.volume * 100)); volume.setAttribute('aria-valuetext', `${Math.round(_settings.volume * 100)}%`); }
}

function loadUsage(serverId: string): Record<string, UsageEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${USAGE_KEY_PREFIX}${serverId}`) || '{}') as Record<string, UsageEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function recordLocalUsage(soundId: string): void {
  if (!_soundboardServerId) return;
  try {
    const usage = loadUsage(_soundboardServerId); const previous = usage[soundId];
    usage[soundId] = { count: Math.max(0, Number(previous?.count) || 0) + 1, lastPlayedAt: Date.now() };
    const bounded = Object.fromEntries(Object.entries(usage).sort(([, a], [, b]) => Number(b.lastPlayedAt) - Number(a.lastPlayedAt)).slice(0, 500));
    localStorage.setItem(`${USAGE_KEY_PREFIX}${_soundboardServerId}`, JSON.stringify(bounded));
    const sound = _soundboardSounds.find(item => item._id === soundId);
    if (sound) { sound.playCount = Math.max(sound.playCount, usage[soundId].count); sound.lastPlayedAt = usage[soundId].lastPlayedAt; }
  } catch { /* usage history is a non-authoritative enhancement */ }
}

function revokeSoundPreviewUrl(): void {
  if (!_soundPreviewUrl) return;
  try { URL.revokeObjectURL(_soundPreviewUrl); } catch { /* best effort */ }
  _soundPreviewUrl = null;
}
function restoreFocus(target: HTMLElement | null): void { if (target?.isConnected) queueMicrotask(() => target.focus()); }
function closeSoundUploadModal(): void {
  revokeSoundPreviewUrl(); document.getElementById('sound-upload-modal')?.remove();
  restoreFocus(_uploadReturnFocus); _uploadReturnFocus = null;
}
function closeManageModal(): void {
  document.getElementById('sound-manage-modal')?.remove(); _managedSoundId = null;
  restoreFocus(_manageReturnFocus); _manageReturnFocus = null;
}
export function closeSoundboardPanel(): void {
  _soundboardRequestGeneration += 1;
  _soundboardAppendInFlight = false;
  if (_searchTimer) clearTimeout(_searchTimer); _searchTimer = null;
  stopCooldownTicker();
  const panel = document.getElementById('soundboard-panel');
  panel?.removeEventListener('keydown', handlePanelKeydown); panel?.remove(); closeSoundUploadModal(); closeManageModal();
  window.removeEventListener('resize', handleSoundboardResize);
  // Panel kapandığında kütüphane sahipliği de biter. Aksi hâlde kapalı panel
  // üzerinden gelen geç bir `playSound` çağrısı, kullanıcının artık bakmadığı
  // (ve ayrılmış olabileceği) sunucunun ses kimliğini yayınlayabilirdi.
  _soundboardServerId = null; _soundboardSounds = []; _soundboardCanManage = false;
  _soundboardCursor = null; _soundboardNextCursor = null; _soundboardCursorHistory = [];
  _soundboardRenderedWindowStart = 0;
  // Yerel bütçe yalnızca bir NEZAKET aynasıdır: paneli kapatmak etkileşim
  // oturumunu bitirir, bu yüzden pencere sıfırlanır. OTORİTE sunucudadır —
  // yeniden açıp hızlı basmaya devam eden kullanıcı `error:ratelimit` alır ve
  // aşağıdaki `_cooldownUntil` (sunucu kaynaklı soğuma) BİLİNÇLİ olarak
  // sıfırlanmaz; kapat-aç ile atlatılamaz.
  _localPlayTimestamps.length = 0;
  restoreFocus(_panelReturnFocus); _panelReturnFocus = null;
}
function safeSoundUrl(value: unknown): string { return resolveLocalAssetUrl(value, String(apiBase() || '/'), window.location.origin); }
function builtinToneName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('bridge-sound:')) return null;
  const name = value.slice('bridge-sound:'.length);
  return Object.prototype.hasOwnProperty.call(BUILTIN_TONES, name) ? name : null;
}
function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}
function createToneObjectUrl(name: string): string {
  const frequencies = BUILTIN_TONES[name]; if (!frequencies) throw new Error('Unknown built-in sound');
  const sampleRate = 8_000; const segmentSamples = 720; const sampleCount = frequencies.length * segmentSamples;
  const bytes = new ArrayBuffer(44 + sampleCount * 2); const view = new DataView(bytes);
  writeAscii(view, 0, 'RIFF'); view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeAscii(view, 36, 'data'); view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    const segment = Math.floor(index / segmentSamples); const within = index % segmentSamples;
    const envelope = Math.max(0, 1 - within / segmentSamples);
    const sample = Math.sin((2 * Math.PI * frequencies[segment] * index) / sampleRate) * envelope * 0.28;
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}
function createPlayback(sound: Pick<SoundboardSound, '_id' | 'url'>): ActivePlayback | null {
  let objectUrl: string | null = null; let source = ''; const tone = builtinToneName(sound.url);
  try { if (tone) { objectUrl = createToneObjectUrl(tone); source = objectUrl; } else source = safeSoundUrl(sound.url); } catch { return null; }
  if (!source) return null;
  const audio = new Audio(source); let cleaned = false;
  return { audio, soundId: sound._id, cleanup() {
    if (cleaned) return; cleaned = true;
    if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch { /* best effort */ } }
  } };
}
export function soundboardCooldownRemainingMs(now = Date.now()): number {
  return Math.max(0, _cooldownUntil - now);
}
function stopCooldownTicker(): void {
  if (!_cooldownTimer) return;
  clearInterval(_cooldownTimer); _cooldownTimer = null;
}
function syncCooldownControls(): void {
  const remaining = soundboardCooldownRemainingMs();
  const notice = document.getElementById('soundboard-cooldown');
  if (notice) {
    notice.hidden = remaining <= 0;
    notice.textContent = remaining > 0
      ? t('snd_cooldown', 'Çok hızlı — bekle') + ` ${Math.ceil(remaining / 1000)}s`
      : '';
  }
  document.querySelectorAll<HTMLButtonElement>('.sound-btn').forEach(button => {
    const locked = button.dataset.soundLocked === 'true';
    button.classList.toggle('cooldown', remaining > 0 && !locked);
    button.disabled = locked || remaining > 0;
  });
}
function beginCooldown(durationMs: number): void {
  const until = Date.now() + Math.max(0, durationMs);
  if (until <= _cooldownUntil) return;
  _cooldownUntil = until; syncCooldownControls(); stopCooldownTicker();
  _cooldownTimer = setInterval(() => {
    syncCooldownControls();
    if (soundboardCooldownRemainingMs() <= 0) stopCooldownTicker();
  }, COOLDOWN_TICK_MS);
  // Sekme arka plandayken zamanlayıcı gereksiz iş yapmasın.
  (_cooldownTimer as unknown as { unref?: () => void }).unref?.();
}
/** Yerel bütçe: pencere içindeki çalma sayısı sunucu bütçesine ulaştı mı? */
function consumeLocalPlayBudget(now = Date.now()): boolean {
  while (_localPlayTimestamps.length && now - _localPlayTimestamps[0] >= SOUNDBOARD_PLAY_WINDOW_MS) {
    _localPlayTimestamps.shift();
  }
  if (_localPlayTimestamps.length >= SOUNDBOARD_PLAY_BUDGET) {
    beginCooldown(SOUNDBOARD_PLAY_WINDOW_MS - (now - _localPlayTimestamps[0]));
    return false;
  }
  _localPlayTimestamps.push(now);
  return true;
}
function handleRateLimitNotice(payloadValue: unknown): void {
  if (!payloadValue || typeof payloadValue !== 'object') return;
  if ((payloadValue as Record<string, unknown>).event !== 'soundboard:play') return;
  beginCooldown(SOUNDBOARD_PLAY_WINDOW_MS);
  toast(t('snd_cooldown_toast', 'Soundboard çok hızlı kullanıldı. Kısa bir süre bekle.'), 'error');
}
function stopLocalPlayback(): void {
  _soundboardPlayGeneration += 1;
  if (_soundboardAudio) { _soundboardAudio.audio.pause(); _soundboardAudio.cleanup(); _soundboardAudio = null; }
  document.querySelectorAll('.sound-btn.playing').forEach(button => { button.classList.remove('playing'); button.setAttribute('aria-pressed', 'false'); });
}

function soundboardApiPath(suffix = ''): string {
  if (!_soundboardServerId) return '';
  return `${apiBase()}/api/servers/${encodeURIComponent(_soundboardServerId)}/soundboard${suffix}`;
}
function normalizeSound(value: unknown, usage: Record<string, UsageEntry>): SoundboardSound | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>; const id = typeof raw._id === 'string' ? raw._id : '';
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 64) : ''; const url = typeof raw.url === 'string' ? raw.url : '';
  if (!id || !name || !url) return null; const local = usage[id];
  return {
    _id: id, name, emoji: typeof raw.emoji === 'string' && raw.emoji ? raw.emoji.slice(0, 16) : '🔊', url,
    scope: raw.scope === 'global' ? 'global' : 'server',
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim().slice(0, 32) : raw.scope === 'global' ? 'Bridge' : 'Server',
    favorite: raw.favorite === true,
    playCount: Math.max(0, Number(raw.playCount) || Number(local?.count) || 0),
    lastPlayedAt: Number(raw.lastPlayedAt) || Number(local?.lastPlayedAt) || null,
    locked: raw.locked === true || raw.canPlay === false,
  };
}
function normalizePage(value: unknown): SoundboardPage {
  const rawItems = Array.isArray(value) ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items)
      ? (value as Record<string, unknown>).items as unknown[] : [];
  const usage = _soundboardServerId ? loadUsage(_soundboardServerId) : {};
  const items = rawItems.slice(0, SOUNDBOARD_PAGE_SIZE).map(item => normalizeSound(item, usage)).filter((item): item is SoundboardSound => item !== null);
  const object = !Array.isArray(value) && value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return { items, nextCursor: typeof object?.nextCursor === 'string' && object.nextCursor ? object.nextCursor : null, canManage: object?.canManage === true };
}
async function errorMessage(response: Response, fallback: string): Promise<string> {
  // Never trust an arbitrary backend body as display copy. Status/network
  // classification yields stable product language; diagnostics stay in logs.
  return safeApiErrorMessage(response, fallback, { report: true });
}

// ── KULLANICIYA GÖSTERİLEBİLİR HATA / İÇ İSTİSNA AYRIMI ──────────────────────
// `apiFetch is not defined` gibi ham JS istisnalarının doğrudan panele
// yansıması (v1.124.1'de gerçek tarayıcıda gözlendi) kabul edilemez. Ama
// sunucunun döndürdüğü HAM mesajlar da kullanıcıya aktarılmamalıdır. HTTP
// durumundan türetilen sabit/yerelleştirilmiş ürün metnini işaretle:
//   · `userError(msg)`  — güvenli API sınıflandırmasından gelen ürün mesajı
//   · diğer her Error   — beklenmeyen iç istisna: KULLANICIYA genel metin,
//                          ham ayrıntı yalnızca konsola (teşhis için)
interface UserFacingError extends Error { userFacing?: true }
function userError(message: string): UserFacingError {
  const e = new Error(message) as UserFacingError; e.userFacing = true; return e;
}
function presentError(error: unknown, fallback: string): string {
  if (error instanceof Error && (error as UserFacingError).userFacing && error.message) return error.message;
  // Ham istisna kullanıcıya GÖSTERİLMEZ; yalnızca teşhis için loglanır.
  try { log.error('Sunum sırasında istisna', error); } catch { /* logger yoksa yok say */ }
  return fallback;
}
function setSoundboardStatus(kind: 'loading' | 'error' | 'empty' | 'search-empty', message: string): void {
  const grid = document.getElementById('soundboard-grid'); const status = document.getElementById('soundboard-status');
  if (!grid || !status) return;
  grid.replaceChildren(); grid.style.removeProperty('padding-top'); grid.style.removeProperty('padding-bottom');
  _soundboardRenderedWindowStart = 0;
  status.hidden = false; status.className = `soundboard-state soundboard-state-${kind}`; status.textContent = message;
  if (kind === 'error') {
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-secondary'; retry.dataset.soundboardAction = 'retry'; retry.textContent = t('retry', 'Tekrar dene');
    status.append(document.createElement('br'), retry);
  }
}
function categoryEmptyMessage(): string {
  if (_soundboardQuery) return t('snd_search_empty', 'Aramanla eşleşen ses yok.');
  if (_soundboardCategory === 'favorites') return t('snd_favorites_empty', 'Henüz favori sesin yok.');
  if (_soundboardCategory === 'recent') return t('snd_recent_empty', 'Henüz yakın zamanda çaldığın ses yok.');
  if (_soundboardCategory === 'frequent') return t('snd_frequent_empty', 'Sık kullanılan sesler burada görünecek.');
  if (_soundboardCategory === 'global') return t('snd_global_empty', 'Bridge varsayılan sesleri kullanılamıyor.');
  return t('snd_empty', 'Bu sunucuda henüz ses yok.');
}
function createIconButton(action: string, label: string, text: string): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'sound-icon-btn';
  button.dataset.soundboardAction = action; button.setAttribute('aria-label', label); button.title = label; button.textContent = text; return button;
}

function soundboardGridLayout(): { columns: number; rowHeight: number; edgePadding: number } {
  const compact = window.matchMedia?.('(max-width: 360px)').matches === true;
  const narrow = window.matchMedia?.('(max-width: 600px)').matches === true;
  return {
    columns: narrow ? 3 : 4,
    rowHeight: compact ? COMPACT_GRID_ROW_HEIGHT : DESKTOP_GRID_ROW_HEIGHT,
    edgePadding: compact ? 8 : 12,
  };
}

function virtualSoundWindow(grid: HTMLElement): { items: SoundboardSound[]; start: number } {
  const { columns, rowHeight, edgePadding } = soundboardGridLayout();
  if (_soundboardSounds.length <= SOUNDBOARD_DOM_WINDOW_SIZE) {
    grid.style.removeProperty('padding-top'); grid.style.removeProperty('padding-bottom');
    _soundboardRenderedWindowStart = 0;
    return { items: _soundboardSounds, start: 0 };
  }

  const totalRows = Math.ceil(_soundboardSounds.length / columns);
  const windowRows = Math.max(1, Math.floor(SOUNDBOARD_DOM_WINDOW_SIZE / columns));
  const firstVisibleRow = Math.max(0, Math.floor(grid.scrollTop / rowHeight));
  const startRow = Math.min(Math.max(0, totalRows - windowRows), Math.max(0, firstVisibleRow - 2));
  const start = startRow * columns;
  const end = Math.min(_soundboardSounds.length, start + windowRows * columns);
  const renderedRows = Math.ceil((end - start) / columns);
  const rowsAfter = Math.max(0, totalRows - startRow - renderedRows);
  grid.style.paddingTop = `${edgePadding + startRow * rowHeight}px`;
  grid.style.paddingBottom = `${edgePadding + rowsAfter * rowHeight}px`;
  _soundboardRenderedWindowStart = start;
  return { items: _soundboardSounds.slice(start, end), start };
}

function syncSearchClearControl(): void {
  const clear = document.querySelector<HTMLButtonElement>('[data-soundboard-action="clear-search"]');
  if (clear) clear.hidden = !(document.getElementById('soundboard-search') as HTMLInputElement | null)?.value;
}

function syncPaginationControls(): void {
  const previous = document.querySelector<HTMLButtonElement>('[data-soundboard-action="previous"]');
  const next = document.querySelector<HTMLButtonElement>('[data-soundboard-action="next"]');
  if (previous) previous.disabled = _soundboardCursorHistory.length === 0 || _soundboardAppendInFlight;
  if (next) next.disabled = !_soundboardNextCursor || _soundboardAppendInFlight;
  const page = document.getElementById('soundboard-page-label');
  if (page) page.textContent = _soundboardSounds.length > SOUNDBOARD_PAGE_SIZE
    ? t('snd_loaded_count', '{count} ses yüklendi', { count: _soundboardSounds.length })
    : t('snd_page_number', '{page}. sayfa', { page: _soundboardCursorHistory.length + 1 });
  const more = document.getElementById('soundboard-load-more');
  if (more) { more.hidden = !_soundboardAppendInFlight; more.textContent = _soundboardAppendInFlight ? t('snd_loading_more', 'Daha fazla ses yükleniyor…') : ''; }
}

function renderSoundboard(): void {
  const grid = document.getElementById('soundboard-grid'); const status = document.getElementById('soundboard-status'); if (!grid || !status) return;
  const scrollTop = grid.scrollTop;
  const visible = virtualSoundWindow(grid);
  grid.replaceChildren(); status.hidden = true; status.textContent = '';
  const upload = document.querySelector<HTMLButtonElement>('[data-soundboard-action="open-upload"]'); if (upload) upload.hidden = !_soundboardCanManage;
  document.querySelectorAll<HTMLButtonElement>('[data-soundboard-category]').forEach(button => {
    const active = button.dataset.soundboardCategory === _soundboardCategory; button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
  });
  document.getElementById('soundboard-library')?.setAttribute('aria-labelledby', `soundboard-tab-${_soundboardCategory}`);
  if (!_soundboardSounds.length) setSoundboardStatus(_soundboardQuery ? 'search-empty' : 'empty', categoryEmptyMessage());
  else visible.items.forEach((sound, offset) => {
    const cell = document.createElement('div'); cell.className = 'sound-cell'; cell.setAttribute('role', 'gridcell'); cell.dataset.soundId = sound._id;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sound-btn'; button.dataset.soundboardAction = 'play'; button.dataset.soundId = sound._id;
    button.dataset.soundIndex = String(visible.start + offset);
    button.dataset.soundLocked = String(sound.locked);
    button.disabled = sound.locked; button.classList.toggle('locked', sound.locked); button.classList.toggle('playing', _soundboardAudio?.soundId === sound._id);
    button.setAttribute('aria-pressed', String(_soundboardAudio?.soundId === sound._id));
    button.setAttribute('aria-label', sound.locked
      ? t('snd_sound_locked_aria', '{name} — kilitli', { name: sound.name })
      : t('snd_play_sound_aria', '{name} sesini çal', { name: sound.name }));
    button.title = sound.locked ? t('snd_locked', 'Bu sesi çalma iznin yok') : t('snd_play', 'Sesi çal');
    const emoji = document.createElement('span'); emoji.className = 'sound-emoji'; emoji.setAttribute('aria-hidden', 'true'); emoji.textContent = sound.emoji;
    const name = document.createElement('span'); name.className = 'sound-name'; name.textContent = sound.name;
    const meta = document.createElement('span'); meta.className = 'sound-meta';
    meta.textContent = sound.playCount > 0 ? `${sound.category} · ${sound.playCount}×` : sound.category;
    button.append(emoji, name, meta);
    if (sound.locked) { const lock = document.createElement('span'); lock.className = 'sound-lock'; lock.setAttribute('aria-hidden', 'true'); lock.textContent = '🔒'; button.append(lock); }
    const actions = document.createElement('div'); actions.className = 'sound-cell-actions';
    const favorite = createIconButton('favorite', sound.favorite
      ? t('snd_remove_favorite', 'Favorilerden çıkar')
      : t('snd_add_favorite', 'Favorilere ekle'), sound.favorite ? '★' : '☆');
    favorite.dataset.soundId = sound._id; favorite.classList.toggle('active', sound.favorite); favorite.setAttribute('aria-pressed', String(sound.favorite)); actions.append(favorite);
    if (_soundboardCanManage && sound.scope === 'server') { const manage = createIconButton('manage', t('snd_manage_sound_aria', '{name} sesini yönet', { name: sound.name }), '•••'); manage.dataset.soundId = sound._id; actions.append(manage); }
    cell.append(button, actions); grid.append(cell);
  });
  grid.scrollTop = scrollTop;
  syncPaginationControls(); syncSearchClearControl(); syncCooldownControls();
}
function buildPageUrl(cursor: string | null): string {
  const params = new URLSearchParams({ limit: String(SOUNDBOARD_PAGE_SIZE) }); if (cursor) params.set('cursor', cursor);
  if (_soundboardQuery) params.set('q', _soundboardQuery); if (_soundboardCategory !== 'all') params.set('scope', _soundboardCategory);
  const rtcApi = BridgeRegistry.get<{ isInVoice(): boolean; currentChannelId?: string | null }>('rtc');
  if (rtcApi?.isInVoice() && typeof rtcApi.currentChannelId === 'string' && rtcApi.currentChannelId) params.set('channelId', rtcApi.currentChannelId);
  return `${soundboardApiPath()}?${params.toString()}`;
}
export async function refreshSoundboard(cursor: string | null = _soundboardCursor): Promise<boolean> {
  const panel = document.getElementById('soundboard-panel'); if (!panel || !_soundboardServerId) return false;
  const generation = ++_soundboardRequestGeneration; _soundboardAppendInFlight = false;
  panel.setAttribute('aria-busy', 'true'); setSoundboardStatus('loading', t('snd_loading', 'Sesler yükleniyor…'));
  try {
    const response = await apiFetch(buildPageUrl(cursor)); if (!response.ok) throw userError(await errorMessage(response, t('snd_load_failed', 'Sesler yüklenemedi')));
    const page = normalizePage(await response.json()); if (generation !== _soundboardRequestGeneration || !document.getElementById('soundboard-panel')) return false;
    _soundboardSounds = page.items; _soundboardNextCursor = page.nextCursor; _soundboardCursor = cursor; _soundboardCanManage = page.canManage;
    const grid = document.getElementById('soundboard-grid'); if (grid) grid.scrollTop = 0; _soundboardRenderedWindowStart = 0;
    renderSoundboard(); return true;
  } catch (error) {
    if (generation !== _soundboardRequestGeneration || !document.getElementById('soundboard-panel')) return false;
    setSoundboardStatus('error', presentError(error, t('snd_load_failed', 'Sesler yüklenemedi'))); return false;
  } finally { if (generation === _soundboardRequestGeneration) panel.removeAttribute('aria-busy'); }
}

/**
 * Cursor-driven infinite-scroll continuation. Metadata is fetched only when
 * the user approaches the end; audio remains lazy and renderSoundboard keeps
 * the number of live cells bounded independently of the library size.
 */
export async function loadMoreSoundboard(): Promise<boolean> {
  const panel = document.getElementById('soundboard-panel');
  const grid = document.getElementById('soundboard-grid');
  const cursor = _soundboardNextCursor;
  if (!panel || !grid || !_soundboardServerId || !cursor || _soundboardAppendInFlight) return false;

  const generation = _soundboardRequestGeneration;
  _soundboardAppendInFlight = true; grid.setAttribute('aria-busy', 'true'); syncPaginationControls();
  try {
    const response = await apiFetch(buildPageUrl(cursor));
    if (!response.ok) throw userError(await errorMessage(response, t('snd_load_failed', 'Sesler yüklenemedi')));
    const page = normalizePage(await response.json());
    if (generation !== _soundboardRequestGeneration || !document.getElementById('soundboard-panel')) return false;

    const known = new Map(_soundboardSounds.map((sound, index) => [sound._id, index]));
    const appended: SoundboardSound[] = [];
    for (const sound of page.items) {
      const existing = known.get(sound._id);
      if (existing === undefined) { known.set(sound._id, _soundboardSounds.length + appended.length); appended.push(sound); }
      else _soundboardSounds[existing] = sound;
    }
    if (appended.length) _soundboardSounds = [..._soundboardSounds, ...appended];
    // A repeated cursor from a faulty backend must not create an automatic
    // request loop. The user can still search/change collection and recover.
    _soundboardNextCursor = page.nextCursor && page.nextCursor !== cursor ? page.nextCursor : null;
    _soundboardCanManage = page.canManage;
    renderSoundboard();
    return true;
  } catch (error) {
    if (generation === _soundboardRequestGeneration && document.getElementById('soundboard-panel')) {
      toast(presentError(error, t('snd_load_failed', 'Sesler yüklenemedi')), 'error');
    }
    return false;
  } finally {
    if (generation === _soundboardRequestGeneration) {
      _soundboardAppendInFlight = false; grid.removeAttribute('aria-busy'); syncPaginationControls();
    }
  }
}

function handleSoundboardGridScroll(event: Event): void {
  const grid = event.currentTarget;
  if (!(grid instanceof HTMLElement) || grid.id !== 'soundboard-grid') return;
  if (_soundboardSounds.length > SOUNDBOARD_DOM_WINDOW_SIZE) {
    const { columns, rowHeight } = soundboardGridLayout();
    const start = Math.max(0, Math.floor(grid.scrollTop / rowHeight) - 2) * columns;
    if (start !== _soundboardRenderedWindowStart) renderSoundboard();
  }
  const { rowHeight } = soundboardGridLayout();
  const remaining = Math.max(0, grid.scrollHeight - grid.scrollTop - grid.clientHeight);
  if (_soundboardNextCursor && remaining <= rowHeight * 2) void loadMoreSoundboard();
}

function handleSoundboardResize(): void {
  if (_soundboardSounds.length > SOUNDBOARD_DOM_WINDOW_SIZE && document.getElementById('soundboard-panel')) renderSoundboard();
}

async function changeCategory(category: SoundboardCategory): Promise<void> {
  if (_soundboardCategory === category) return; _soundboardCategory = category; _soundboardCursor = null; _soundboardCursorHistory = []; _soundboardRenderedWindowStart = 0; renderSoundboard(); await refreshSoundboard(null);
}
export async function runSoundboardSearch(query: string): Promise<void> {
  const normalized = query.trim().slice(0, 64); if (_soundboardQuery === normalized) return;
  _soundboardQuery = normalized; _soundboardCursor = null; _soundboardCursorHistory = []; _soundboardRenderedWindowStart = 0; await refreshSoundboard(null);
}
async function goToNextPage(): Promise<void> {
  if (!_soundboardNextCursor) return; const previousCursor = _soundboardCursor; const nextCursor = _soundboardNextCursor;
  if (await refreshSoundboard(nextCursor)) _soundboardCursorHistory.push(previousCursor); renderSoundboard();
}
async function goToPreviousPage(): Promise<void> {
  if (!_soundboardCursorHistory.length) return; const history = [..._soundboardCursorHistory]; const cursor = history.pop() ?? null;
  if (await refreshSoundboard(cursor)) _soundboardCursorHistory = history; renderSoundboard();
}
async function toggleFavorite(soundId: string): Promise<void> {
  const sound = _soundboardSounds.find(item => item._id === soundId); if (!sound) return;
  const previous = sound.favorite; sound.favorite = !previous; renderSoundboard();
  try {
    const response = await apiFetch(soundboardApiPath(`/${encodeURIComponent(soundId)}/favorite`), { method: previous ? 'DELETE' : 'PUT' });
    if (!response.ok) throw userError(await errorMessage(response, t('snd_favorite_failed', 'Favori güncellenemedi')));
  } catch (error) { sound.favorite = previous; renderSoundboard(); toast(presentError(error, t('snd_favorite_failed', 'Favori güncellenemedi')), 'error'); }
}
function handleSoundboardPanelAction(event: Event): void {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-soundboard-action], [data-soundboard-category]') : null; if (!target) return;
  const category = target.dataset.soundboardCategory as SoundboardCategory | undefined; if (category) { void changeCategory(category); return; }
  switch (target.dataset.soundboardAction) {
    case 'open-upload': openSoundUpload(); break; case 'close': closeSoundboardPanel(); break; case 'retry': void refreshSoundboard(_soundboardCursor); break;
    case 'previous': void goToPreviousPage(); break; case 'next': void goToNextPage(); break; case 'mute': setSoundboardMuted(!_settings.muted); break;
    case 'clear-search': {
      if (_searchTimer) clearTimeout(_searchTimer); _searchTimer = null;
      const search = document.getElementById('soundboard-search') as HTMLInputElement | null;
      if (search) { search.value = ''; syncSearchClearControl(); search.focus(); }
      void runSoundboardSearch('');
      break;
    }
    case 'favorite': { const soundId = target.dataset.soundId; if (soundId) void toggleFavorite(soundId); break; }
    case 'manage': { const soundId = target.dataset.soundId; if (soundId) openSoundManager(soundId); break; }
    case 'play': { const soundId = target.dataset.soundId; if (soundId) playSound(soundId); break; }
  }
}
function handleSoundboardInput(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === 'soundboard-search') {
    syncSearchClearControl();
    if (_searchTimer) clearTimeout(_searchTimer); _searchTimer = setTimeout(() => { void runSoundboardSearch(target.value); }, SEARCH_DEBOUNCE_MS);
  } else if (target instanceof HTMLInputElement && target.id === 'soundboard-volume') setSoundboardVolume(Number(target.value) / 100);
}
function handlePanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); closeSoundboardPanel(); return; }
  const target = event.target as HTMLElement | null;
  if (target?.id === 'soundboard-search' && event.key === 'Enter') {
    if (_searchTimer) clearTimeout(_searchTimer); _searchTimer = null; void runSoundboardSearch((target as HTMLInputElement).value); return;
  }
  if (target?.classList.contains('soundboard-category')) {
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.soundboard-category'));
    const index = tabs.indexOf(target as HTMLButtonElement); if (index < 0) return;
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0; else if (event.key === 'End') nextIndex = tabs.length - 1; else return;
    event.preventDefault(); tabs[nextIndex]?.focus(); return;
  }
  if (!target?.classList.contains('sound-btn')) return;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sound-btn:not(:disabled)')); const index = buttons.indexOf(target as HTMLButtonElement); if (index < 0) return;
  const columns = soundboardGridLayout().columns; let nextIndex = index;
  if (event.key === 'ArrowRight') nextIndex = Math.min(buttons.length - 1, index + 1); else if (event.key === 'ArrowLeft') nextIndex = Math.max(0, index - 1);
  else if (event.key === 'ArrowDown') nextIndex = Math.min(buttons.length - 1, index + columns); else if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - columns);
  else if (event.key === 'Home') nextIndex = 0; else if (event.key === 'End') nextIndex = buttons.length - 1; else return;
  event.preventDefault(); buttons[nextIndex]?.focus();
}
function categoryButton(category: SoundboardCategory, icon: string, label: string): string {
  return `<button type="button" class="soundboard-category" id="soundboard-tab-${category}" role="tab" aria-controls="soundboard-library" aria-selected="${category === 'all'}" data-soundboard-category="${category}" title="${label}"><span aria-hidden="true">${icon}</span><span>${label}</span></button>`;
}
export async function openSoundboard(): Promise<void> {
  const selected = BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer') ?? currentServerFallback();
  if (!selected?._id) { toast(t('snd_pick_server', 'Önce bir sunucu seç'), 'error'); return; }
  if (document.getElementById('soundboard-panel')) { closeSoundboardPanel(); return; }
  _soundboardServerId = String(selected._id); _soundboardSounds = []; _soundboardCategory = 'all'; _soundboardQuery = '';
  _soundboardCursor = null; _soundboardNextCursor = null; _soundboardCursorHistory = []; _soundboardCanManage = false;
  _soundboardAppendInFlight = false; _soundboardRenderedWindowStart = 0;
  _panelReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const panel = document.createElement('section'); panel.id = 'soundboard-panel'; panel.className = 'soundboard-panel';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false'); panel.setAttribute('aria-labelledby', 'soundboard-title');
  panel.innerHTML = `
    <header class="soundboard-header"><div><span class="soundboard-kicker">BRIDGE AUDIO</span><h2 id="soundboard-title">🎵 Soundboard</h2></div>
      <div class="soundboard-header-actions"><button type="button" class="btn btn-secondary soundboard-upload" data-soundboard-action="open-upload" hidden>+ ${t('snd_add_sound', 'Ses ekle')}</button>
      <button type="button" class="icon-btn" data-soundboard-action="close" aria-label="${t('close', 'Kapat')}" title="${t('close', 'Kapat')}">✕</button></div></header>
    <div class="soundboard-toolbar"><div class="soundboard-search-wrap"><span aria-hidden="true">⌕</span><label class="sr-only" for="soundboard-search">${t('snd_search', 'Ses ara')}</label>
      <input id="soundboard-search" type="search" maxlength="64" autocomplete="off" placeholder="${t('snd_search', 'Ses ara')}" />
      <button type="button" class="soundboard-search-clear" data-soundboard-action="clear-search" aria-label="${t('snd_clear_search', 'Aramayı temizle')}" title="${t('snd_clear_search', 'Aramayı temizle')}" hidden>✕</button></div>
      <p id="soundboard-cooldown" class="soundboard-cooldown" role="status" aria-live="polite" hidden></p>
      <button type="button" class="soundboard-mute" data-soundboard-action="mute" aria-pressed="false"></button>
      <label class="soundboard-volume" for="soundboard-volume"><span class="sr-only">${t('snd_volume', 'Soundboard ses düzeyi')}</span><input id="soundboard-volume" type="range" min="0" max="100" step="5" /></label></div>
    <div class="soundboard-body"><nav class="soundboard-categories" role="tablist" aria-label="${t('snd_collections', 'Ses koleksiyonları')}">
      ${categoryButton('all', '✦', t('all', 'Tümü'))}${categoryButton('favorites', '★', t('snd_favorites', 'Favoriler'))}${categoryButton('recent', '◷', t('snd_recent', 'Son'))}
      ${categoryButton('frequent', '↻', t('snd_frequent', 'Sık'))}${categoryButton('server', '◉', t('snd_server', 'Sunucu'))}${categoryButton('global', 'B', 'Bridge')}</nav>
      <div class="soundboard-library" id="soundboard-library" role="tabpanel" aria-labelledby="soundboard-tab-all"><div id="soundboard-status" class="soundboard-state" role="status" aria-live="polite"></div>
      <div id="soundboard-grid" class="soundboard-grid" role="grid" aria-label="${t('snd_sounds', 'Soundboard sesleri')}"></div>
      <footer class="soundboard-pagination" aria-label="${t('snd_pages', 'Ses sayfaları')}"><button type="button" class="btn btn-secondary" data-soundboard-action="previous" disabled>‹ ${t('disc_prev', 'Önceki')}</button>
      <span id="soundboard-page-label" aria-live="polite">${t('snd_page_number', '{page}. sayfa', { page: 1 })}</span><span id="soundboard-load-more" role="status" aria-live="polite" hidden></span>
      <button type="button" class="btn btn-secondary" data-soundboard-action="next" disabled>${t('markup_sonraki_59807ab', 'Sonraki ›')}</button></footer></div></div>`;
  panel.addEventListener('click', handleSoundboardPanelAction); panel.addEventListener('input', handleSoundboardInput); panel.addEventListener('keydown', handlePanelKeydown);
  panel.querySelector('#soundboard-grid')?.addEventListener('scroll', handleSoundboardGridScroll);
  window.addEventListener('resize', handleSoundboardResize);
  document.querySelector('.chat-area')?.appendChild(panel) || document.body.appendChild(panel); syncSettingsControls();
  queueMicrotask(() => document.getElementById('soundboard-search')?.focus()); await refreshSoundboard(null);
}

export function playSound(soundId: string): void {
  const sound = _soundboardSounds.find(item => item._id === soundId); if (!sound || sound.locked) return;
  if (soundboardCooldownRemainingMs() > 0) return;
  if (!consumeLocalPlayBudget()) {
    toast(t('snd_cooldown_toast', 'Soundboard çok hızlı kullanıldı. Kısa bir süre bekle.'), 'error');
    return;
  }
  stopLocalPlayback(); const playback = createPlayback(sound);
  if (!playback) { toast(t('snd_play_failed', 'Ses oynatılamadı'), 'error'); return; }
  const generation = ++_soundboardPlayGeneration; _soundboardAudio = playback; playback.audio.volume = _settings.muted ? 0 : _settings.volume;
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.sound-btn')).find(candidate => candidate.dataset.soundId === soundId);
  const finishLocal = () => { playback.cleanup(); if (_soundboardAudio !== playback) return; _soundboardAudio = null; button?.classList.remove('playing'); button?.setAttribute('aria-pressed', 'false'); };
  playback.audio.onended = finishLocal;
  playback.audio.onerror = () => finishLocal();
  playback.audio.play().then(() => {
    if (generation !== _soundboardPlayGeneration || _soundboardAudio !== playback) { playback.audio.pause(); playback.cleanup(); return; }
    button?.classList.add('playing'); button?.setAttribute('aria-pressed', 'true'); recordLocalUsage(soundId);
    const rtcApi = BridgeRegistry.get<{ isInVoice(): boolean; currentChannelId?: string | null }>('rtc'); const socketApi = BridgeRegistry.get<SocketLike>('socket');
    if (rtcApi?.isInVoice() && rtcApi.currentChannelId && socketApi) socketApi.emit('soundboard:play', { channelId: rtcApi.currentChannelId, soundId: sound._id });
  }).catch(() => { if (_soundboardAudio === playback) _soundboardAudio = null; playback.cleanup(); button?.classList.remove('playing'); button?.setAttribute('aria-pressed', 'false'); toast(t('snd_play_failed', 'Ses oynatılamadı'), 'error'); });
}
export function stopSoundboard(): void {
  stopLocalPlayback(); while (_remotePlaybacks.length) { const playback = _remotePlaybacks.pop(); playback?.audio.pause(); playback?.cleanup(); }
}

function handleSoundUploadAction(event: Event): void {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-sound-upload-action]') : null; if (!target) return;
  if (target.dataset.soundUploadAction === 'close') closeSoundUploadModal(); else if (target.dataset.soundUploadAction === 'upload') void uploadSound();
}
function handleSoundUploadChange(event: Event): void { const target = event.target; if (target instanceof HTMLInputElement && target.id === 'sound-file-input') previewSoundFile(target); }
function handleModalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Tab' && event.currentTarget instanceof HTMLElement) {
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), audio[controls]'))
      .filter(control => !control.closest('[hidden]'));
    if (controls.length) {
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0]?.focus(); }
    }
    return;
  }
  if (event.key !== 'Escape' || _uploadInFlight || _manageInFlight) return; event.preventDefault();
  if (document.getElementById('sound-manage-modal')) closeManageModal(); else closeSoundUploadModal();
}
export function openSoundUpload(): void {
  if (!_soundboardCanManage) { toast(t('snd_manage_denied', 'Soundboard yönetme iznin yok'), 'error'); return; }
  if (_uploadInFlight) return;
  if (document.getElementById('sound-upload-modal')) closeSoundUploadModal(); _uploadReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const modal = document.createElement('div'); modal.id = 'sound-upload-modal'; modal.className = 'modal-overlay'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'sound-upload-title');
  modal.innerHTML = `<div class="modal-card soundboard-form-card"><h2 id="sound-upload-title">🎵 ${t('snd_add_sound', 'Ses ekle')}</h2>
    <label class="settings-label" for="sound-file-input">${t('snd_sound_file', 'Ses dosyası')} <span class="form-hint">${t('snd_file_hint', 'MP3, OGG, WAV, WebM, AAC veya FLAC · en fazla 5 saniye / 5 MB')}</span></label>
    <input type="file" id="sound-file-input" accept="audio/mpeg,audio/ogg,audio/wav,audio/x-wav,audio/webm,audio/aac,audio/flac,.mp3,.ogg,.wav,.webm,.aac,.flac" class="input" />
    <label class="settings-label" for="sound-name-input">${t('snd_name', 'İsim')}</label><input id="sound-name-input" class="input" placeholder="${t('snd_name_placeholder', 'Sesin adı')}" maxlength="32" />
    <label class="settings-label" for="sound-emoji-input">${t('emoji', 'Emoji')}</label><input id="sound-emoji-input" class="input sound-emoji-input" placeholder="🔊" maxlength="8" value="🔊" />
    <label class="settings-label" for="sound-category-input">${t('snd_category', 'Kategori')}</label><input id="sound-category-input" class="input" placeholder="Server" maxlength="32" value="Server" />
    <div id="sound-preview" hidden><audio id="sound-preview-player" controls preload="metadata"></audio></div>
    <div id="sound-upload-progress" class="soundboard-upload-progress" role="progressbar" aria-label="${t('snd_uploading_sound', 'Ses yükleniyor')}" hidden><span></span></div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-sound-upload-action="close">${t('cancel', 'İptal')}</button><button type="button" class="btn" data-sound-upload-action="upload">${t('upload', 'Yükle')}</button></div></div>`;
  modal.addEventListener('click', event => { if (event.target === modal && !_uploadInFlight) { closeSoundUploadModal(); return; } handleSoundUploadAction(event); });
  modal.addEventListener('change', handleSoundUploadChange); modal.addEventListener('keydown', handleModalKeydown); document.body.appendChild(modal);
  queueMicrotask(() => document.getElementById('sound-file-input')?.focus());
}
export function previewSoundFile(input: HTMLInputElement): void {
  const file = input.files?.[0]; if (!file) return; const nameInput = document.getElementById('sound-name-input') as HTMLInputElement | null;
  if (nameInput && !nameInput.value) nameInput.value = file.name.replace(/\.[^/.]+$/, '').slice(0, 32);
  const preview = document.getElementById('sound-preview'); const player = document.getElementById('sound-preview-player') as HTMLAudioElement | null;
  if (preview && player) { revokeSoundPreviewUrl(); _soundPreviewUrl = URL.createObjectURL(file); player.src = _soundPreviewUrl; preview.hidden = false; }
}
function validClientAudioFile(file: File): boolean {
  const allowedMime = new Set(['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/aac', 'audio/flac']);
  return file.size > 0 && file.size <= MAX_SOUND_FILE_BYTES && allowedMime.has(file.type.toLowerCase());
}
export async function uploadSound(): Promise<void> {
  if (_uploadInFlight || !_soundboardCanManage) return; const fileInput = document.getElementById('sound-file-input') as HTMLInputElement | null; const file = fileInput?.files?.[0];
  if (!file) { toast(t('snd_pick_file', 'Dosya seç'), 'error'); return; }
  if (!validClientAudioFile(file)) { toast(t('snd_invalid_file', 'Desteklenen, boş olmayan ve en fazla 5 MB bir ses dosyası seç'), 'error'); return; }
  const nameInput = document.getElementById('sound-name-input') as HTMLInputElement | null; const emojiInput = document.getElementById('sound-emoji-input') as HTMLInputElement | null;
  const categoryInput = document.getElementById('sound-category-input') as HTMLInputElement | null;
  const name = nameInput?.value.trim().slice(0, 32) ?? ''; const emoji = emojiInput?.value.trim().slice(0, 8) || '🔊'; const category = categoryInput?.value.trim().slice(0, 32) || 'Server';
  if (!name) { toast(t('snd_name_req', 'İsim gerekli'), 'error'); return; }
  const formData = new FormData(); formData.append('sound', file); formData.append('name', name); formData.append('emoji', emoji); formData.append('category', category);
  const submit = document.querySelector<HTMLButtonElement>('[data-sound-upload-action="upload"]'); _uploadInFlight = true; if (submit) submit.disabled = true;
  // `apiFetch` gövde ilerlemesi bildirmez; bu yüzden BELİRSİZ (indeterminate)
  // bir ilerleme çubuğu gösterilir. Uydurma bir yüzde göstermek, yavaş bir
  // bağlantıda kullanıcıyı yanıltırdı — ARIA'da `aria-valuenow` bilinçli olarak
  // ATANMAZ; belirsiz ilerlemenin doğru gösterimi budur.
  const progress = document.getElementById('sound-upload-progress');
  if (progress) progress.hidden = false;
  if (submit) submit.textContent = t('snd_uploading', 'Yükleniyor…');
  try {
    const response = await apiFetch(soundboardApiPath(), { method: 'POST', body: formData }); if (!response.ok) throw userError(await errorMessage(response, t('snd_upload_failed', 'Yüklenemedi')));
    closeSoundUploadModal(); toast(t('snd_added', 'Ses eklendi! 🎵'), 'success'); _soundboardCursor = null; _soundboardCursorHistory = []; await refreshSoundboard(null);
  } catch (error) { toast(presentError(error, t('snd_upload_failed', 'Yüklenemedi')), 'error'); }
  finally {
    _uploadInFlight = false;
    const liveProgress = document.getElementById('sound-upload-progress');
    if (liveProgress) liveProgress.hidden = true;
    if (submit?.isConnected) { submit.disabled = false; submit.textContent = t('snd_upload', 'Yükle'); }
  }
}

function openSoundManager(soundId: string): void {
  const sound = _soundboardSounds.find(item => item._id === soundId); if (!sound || !_soundboardCanManage || sound.scope !== 'server') return;
  closeManageModal(); _managedSoundId = soundId; _manageReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const modal = document.createElement('div'); modal.id = 'sound-manage-modal'; modal.className = 'modal-overlay'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'sound-manage-title');
  const card = document.createElement('div'); card.className = 'modal-card soundboard-form-card'; card.innerHTML = `<h2 id="sound-manage-title">${t('snd_manage_sound', 'Sesi yönet')}</h2>
    <label class="settings-label" for="sound-rename-input">${t('snd_name', 'İsim')}</label><input id="sound-rename-input" class="input" maxlength="32" />
    <label class="settings-label" for="sound-rename-emoji">${t('emoji', 'Emoji')}</label><input id="sound-rename-emoji" class="input sound-emoji-input" maxlength="8" />
    <label class="settings-label" for="sound-rename-category">${t('snd_category', 'Kategori')}</label><input id="sound-rename-category" class="input" maxlength="32" />
    <div class="modal-footer"><button type="button" class="btn btn-danger" data-sound-manage-action="delete">${t('delete', 'Sil')}</button><button type="button" class="btn btn-secondary" data-sound-manage-action="close">${t('cancel', 'İptal')}</button><button type="button" class="btn" data-sound-manage-action="save">${t('save', 'Kaydet')}</button></div>`;
  (card.querySelector('#sound-rename-input') as HTMLInputElement).value = sound.name; (card.querySelector('#sound-rename-emoji') as HTMLInputElement).value = sound.emoji;
  (card.querySelector('#sound-rename-category') as HTMLInputElement).value = sound.category; modal.append(card);
  modal.addEventListener('click', event => {
    if (event.target === modal && !_manageInFlight) { closeManageModal(); return; }
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-sound-manage-action]') : null; if (!target) return;
    if (target.dataset.soundManageAction === 'close') closeManageModal(); else if (target.dataset.soundManageAction === 'save') void saveSoundChanges(); else if (target.dataset.soundManageAction === 'delete') void deleteManagedSound();
  });
  modal.addEventListener('keydown', handleModalKeydown); document.body.append(modal); queueMicrotask(() => (document.getElementById('sound-rename-input') as HTMLInputElement | null)?.select());
}
async function saveSoundChanges(): Promise<void> {
  if (_manageInFlight || !_managedSoundId) return; const name = (document.getElementById('sound-rename-input') as HTMLInputElement | null)?.value.trim().slice(0, 32) ?? '';
  const emoji = (document.getElementById('sound-rename-emoji') as HTMLInputElement | null)?.value.trim().slice(0, 8) || '🔊';
  const category = (document.getElementById('sound-rename-category') as HTMLInputElement | null)?.value.trim().slice(0, 32) || 'Server';
  if (!name) { toast(t('snd_name_req', 'İsim gerekli'), 'error'); return; }
  _manageInFlight = true;
  try {
    const response = await apiFetch(soundboardApiPath(`/${encodeURIComponent(_managedSoundId)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, emoji, category }) });
    if (!response.ok) throw userError(await errorMessage(response, t('snd_update_failed', 'Ses güncellenemedi')));
    closeManageModal(); toast(t('snd_updated', 'Ses güncellendi'), 'success'); await refreshSoundboard(_soundboardCursor);
  } catch (error) { toast(presentError(error, t('snd_update_failed', 'Ses güncellenemedi')), 'error'); }
  finally { _manageInFlight = false; }
}
async function deleteManagedSound(): Promise<void> {
  if (_manageInFlight || !_managedSoundId) return;
  if (!await confirmProductAction({ title: t('snd_delete_title', 'Sesi sil'), message: t('snd_delete_confirm', 'Bu sesi kalıcı olarak silmek istiyor musun?'), confirmLabel: t('delete', 'Sil'), tone: 'danger' })) return;
  _manageInFlight = true;
  try {
    const response = await apiFetch(soundboardApiPath(`/${encodeURIComponent(_managedSoundId)}`), { method: 'DELETE' });
    if (!response.ok) throw userError(await errorMessage(response, t('snd_delete_failed', 'Ses silinemedi')));
    closeManageModal(); toast(t('snd_deleted', 'Ses silindi'), 'success'); await refreshSoundboard(_soundboardCursor);
  } catch (error) { toast(presentError(error, t('snd_delete_failed', 'Ses silinemedi')), 'error'); }
  finally { _manageInFlight = false; }
}

let _soundboardSocket: SocketLike | null = null;
let _soundboardSocketHandlers = new Map<string, (...args: unknown[]) => void>();
function finishRemotePlayback(playback: ActivePlayback): void { const index = _remotePlaybacks.indexOf(playback); if (index >= 0) _remotePlaybacks.splice(index, 1); playback.cleanup(); }
function handleRemotePlay(payloadValue: unknown): void {
  if (!payloadValue || typeof payloadValue !== 'object') return; const payload = payloadValue as Record<string, unknown>;
  const rtcApi = BridgeRegistry.get<{ isInVoice(): boolean; currentChannelId?: string | null }>('rtc');
  if (!rtcApi?.isInVoice() || rtcApi.currentChannelId !== payload.channelId || _settings.muted) return;
  const playedBy = payload.playedBy && typeof payload.playedBy === 'object' ? payload.playedBy as Record<string, unknown> : null;
  const userId = typeof playedBy?._id === 'string' ? playedBy._id : typeof playedBy?.id === 'string' ? playedBy.id : typeof payload.playedByUserId === 'string' ? payload.playedByUserId : '';
  if (userId && _settings.suppressedUserIds.includes(userId)) return;
  const soundId = typeof payload.soundId === 'string' ? payload.soundId : ''; const repeatKey = `${userId}:${soundId}`; const now = Date.now();
  if (repeatKey !== ':' && now - (_recentRemotePlays.get(repeatKey) ?? 0) < REPEAT_GUARD_MS) return;
  if (repeatKey !== ':') { _recentRemotePlays.set(repeatKey, now); if (_recentRemotePlays.size > 100) _recentRemotePlays.delete(_recentRemotePlays.keys().next().value as string); }
  const soundUrl = typeof payload.soundUrl === 'string' ? payload.soundUrl : ''; const playback = createPlayback({ _id: soundId || 'remote', url: soundUrl }); if (!playback) return;
  while (_remotePlaybacks.length >= SOUNDBOARD_MAX_REMOTE_PLAYBACKS) { const oldest = _remotePlaybacks.shift(); oldest?.audio.pause(); oldest?.cleanup(); }
  _remotePlaybacks.push(playback); playback.audio.volume = _settings.volume; playback.audio.onended = () => finishRemotePlayback(playback); playback.audio.onerror = () => finishRemotePlayback(playback);
  const soundName = typeof payload.soundName === 'string' ? payload.soundName : t('soundboard', 'Ses Panosu'); const emoji = typeof payload.emoji === 'string' && payload.emoji ? payload.emoji : '🔊';
  const displayName = typeof playedBy?.displayName === 'string' ? playedBy.displayName : typeof payload.playedByName === 'string' ? payload.playedByName : '';
  toast(displayName ? `${emoji} ${soundName} · ${displayName}` : `${emoji} ${soundName}`, 'info'); playback.audio.play().catch(() => finishRemotePlayback(playback));
}
function relevantRealtimeChange(payloadValue: unknown): boolean {
  if (!payloadValue || typeof payloadValue !== 'object') return false; const payload = payloadValue as Record<string, unknown>;
  if (payload.serverId && payload.serverId !== _soundboardServerId) return false;
  if (typeof payload.channelId === 'string') {
    const rtcApi = BridgeRegistry.get<{ currentChannelId?: string | null }>('rtc');
    if (rtcApi?.currentChannelId && payload.channelId !== rtcApi.currentChannelId) return false;
  }
  return true;
}
function resyncOpenSoundboard(payload?: unknown): void {
  if (!document.getElementById('soundboard-panel')) return; if (payload !== undefined && !relevantRealtimeChange(payload)) return; void refreshSoundboard(_soundboardCursor);
}
function unbindSoundboardSocket(): void {
  if (_soundboardSocket) for (const [event, handler] of _soundboardSocketHandlers) _soundboardSocket.off?.(event, handler);
  _soundboardSocket = null; _soundboardSocketHandlers = new Map();
}
export function initSoundboardSocket(socket: SocketLike): () => void {
  if (_soundboardSocket === socket && _soundboardSocketHandlers.size) return unbindSoundboardSocket; unbindSoundboardSocket();
  const handlers = new Map<string, (...args: unknown[]) => void>([
    ['soundboard:play', handleRemotePlay], ['soundboard:created', resyncOpenSoundboard], ['soundboard:updated', resyncOpenSoundboard],
    ['soundboard:deleted', resyncOpenSoundboard], ['connect', () => resyncOpenSoundboard()],
    // Permission and role changes can turn every visible sound into a locked or
    // playable control. Re-read the authoritative annotation instead of trying
    // to reconstruct server permission precedence in the browser.
    ['permissions:updated', resyncOpenSoundboard], ['role:granted', resyncOpenSoundboard], ['role:revoked', resyncOpenSoundboard],
    ['error:ratelimit', handleRateLimitNotice],
  ]);
  _soundboardSocket = socket; _soundboardSocketHandlers = handlers; for (const [event, handler] of handlers) socket.on(event, handler); return unbindSoundboardSocket;
}
function syncSoundboardSocket(): void { const socket = BridgeRegistry.get<SocketLike>('socket'); if (socket) initSoundboardSocket(socket); resyncOpenSoundboard(); }
BridgeRegistry.register('openSoundboard', openSoundboard);
BridgeRegistry.register('setSoundboardUserSuppressed', setSoundboardUserSuppressed);
BridgeRegistry.register('isSoundboardUserSuppressed', isSoundboardUserSuppressed);
document.addEventListener('bridge:socket-ready', syncSoundboardSocket);
document.addEventListener('bridge:socket-reconnected', syncSoundboardSocket);
