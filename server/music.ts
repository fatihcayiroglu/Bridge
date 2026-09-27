// server/music.ts
import { cache } from './lib/redisAdapter';

// Müzik kuyruğu yönetimi — in-memory, channel bazlı.
// Sprint 99: server/routes/music.ts → server/music.ts taşındı (import yolları düzeltildi).
// Sprint 100: Tip güvenliği tam hale getirildi (implicit any'ler giderildi).

const QUEUE_MAX = 25;
const MUSIC_QUEUE_TTL_SECONDS = 6 * 60 * 60;
const MUSIC_QUEUE_KEY_PREFIX = 'music:queue:';

export interface MusicTrack {
  title:        string;
  duration:     number;
  url:          string;
  streamUrl?:   string;
  requestedBy?: string;
}

export interface MusicQueue {
  current: MusicTrack | null;
  queue:   MusicTrack[];
}

export type MusicCommandResult =
  | { nowPlaying: MusicTrack }
  | { queued: MusicTrack; position: number }
  | { stopped: true }
  | { current: MusicTrack | null; queue: MusicTrack[] }
  | { commands: string[] }
  | { error: string }
  | false;

const queues: Record<string, MusicQueue> = {};

export function getQueue(channelId: string): MusicQueue {
  if (!queues[channelId]) queues[channelId] = { current: null, queue: [] };
  return queues[channelId];
}

function validateChannelId(channelId: string): void {
  if (typeof channelId !== 'string' || channelId.length < 1 || channelId.length > 128) {
    throw new TypeError('music channelId must be a non-empty bounded string');
  }
}

function normalizeMusicTrack(value: unknown): MusicTrack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== 'string' || raw.title.length < 1 || raw.title.length > 512) return null;
  if (typeof raw.url !== 'string' || raw.url.length < 1 || raw.url.length > 4096) return null;
  if (typeof raw.duration !== 'number' || !Number.isFinite(raw.duration) || raw.duration < 0) return null;
  if (raw.streamUrl !== undefined && (typeof raw.streamUrl !== 'string' || raw.streamUrl.length > 8192)) return null;
  if (raw.requestedBy !== undefined && (typeof raw.requestedBy !== 'string' || raw.requestedBy.length > 256)) return null;
  return {
    title: raw.title,
    duration: raw.duration,
    url: raw.url,
    ...(typeof raw.streamUrl === 'string' ? { streamUrl: raw.streamUrl } : {}),
    ...(typeof raw.requestedBy === 'string' ? { requestedBy: raw.requestedBy } : {}),
  };
}

function decodeSharedQueue(value: unknown): MusicQueue {
  if (value === null || value === undefined) return { current: null, queue: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Corrupt shared music queue state');
  }
  const raw = value as Record<string, unknown>;
  const current = raw.current === null || raw.current === undefined ? null : normalizeMusicTrack(raw.current);
  if (raw.current !== null && raw.current !== undefined && !current) {
    throw new Error('Corrupt shared music current track');
  }
  if (!Array.isArray(raw.queue) || raw.queue.length > QUEUE_MAX) {
    throw new Error('Corrupt shared music queue');
  }
  const queue = raw.queue.map(normalizeMusicTrack);
  if (queue.some(track => !track)) throw new Error('Corrupt shared music queued track');
  return { current, queue: queue as MusicTrack[] };
}

function usesSharedMusicAuthority(): boolean {
  return Boolean(process.env.REDIS_URL);
}

function sharedQueueKey(channelId: string): string {
  return `${MUSIC_QUEUE_KEY_PREFIX}${channelId}`;
}

/**
 * Read the canonical queue state.  In an explicitly configured cluster Redis
 * is the authority; a Redis outage/corrupt shared value is therefore an error
 * rather than a silent per-worker downgrade.  Deliberate no-Redis deployments
 * retain the historical in-process queue.
 */
export async function readMusicQueue(channelId: string): Promise<MusicQueue> {
  validateChannelId(channelId);
  if (!usesSharedMusicAuthority()) {
    const local = getQueue(channelId);
    return { current: local.current, queue: [...local.queue] };
  }
  return cache.withKeyLock(`music-queue:${channelId}`, async () =>
    decodeSharedQueue(await cache.getAuthoritative(sharedQueueKey(channelId))),
    { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 },
  );
}

/** Serialize every authoritative queue mutation through one logical lock. */
export async function mutateMusicQueue<T>(
  channelId: string,
  fn: (queue: MusicQueue) => T | Promise<T>,
): Promise<T> {
  validateChannelId(channelId);
  if (typeof fn !== 'function') throw new TypeError('music queue mutation must be a function');

  if (!usesSharedMusicAuthority()) {
    return cache.withKeyLock(`music-queue:${channelId}`, () => Promise.resolve(fn(getQueue(channelId))),
      { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 });
  }

  return cache.withKeyLock(`music-queue:${channelId}`, async () => {
    const key = sharedQueueKey(channelId);
    const queue = decodeSharedQueue(await cache.getAuthoritative(key));
    const result = await fn(queue);
    if (!queue.current && queue.queue.length === 0) await cache.delAuthoritative(key);
    else await cache.setAuthoritative(key, queue, MUSIC_QUEUE_TTL_SECONDS);
    return result;
  }, { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 });
}

export async function skipSharedMusicQueue(channelId: string): Promise<MusicTrack | null> {
  return mutateMusicQueue(channelId, queue => {
    queue.current = queue.queue.shift() ?? null;
    return queue.current;
  });
}

export async function clearSharedMusicQueue(channelId: string): Promise<void> {
  await mutateMusicQueue(channelId, queue => {
    queue.current = null;
    queue.queue = [];
  });
}

export function isValidMusicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hostname = u.hostname.toLowerCase();
    const allowedHosts = ['youtube.com', 'youtu.be', 'soundcloud.com'];
    return allowedHosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '?:??';
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safeSeconds / 60);
  const s = safeSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export async function getVideoInfo(url: string): Promise<MusicTrack> {
  return { title: `Track from ${url}`, duration: 180, url };
}

export async function getStreamUrl(url: string): Promise<string> {
  return url;
}

/** Kuyruktaki bir sonraki parçayı current'a alır; döner ya da null. */
export function skipCurrent(channelId: string): MusicTrack | null {
  const q = getQueue(channelId);
  q.current = q.queue.shift() ?? null;
  return q.current;
}

export function clearQueue(channelId: string): void {
  queues[channelId] = { current: null, queue: [] };
}

export async function handleMusicCommand(
  command:   string,
  args:      string[],
  channelId: string,
  _io:       unknown,
): Promise<MusicCommandResult> {
  if (command === '!play') {
    const url = args[0];
    if (!url)                  return { error: 'URL required' };
    if (!isValidMusicUrl(url)) return { error: 'Invalid music URL' };
    const info = await getVideoInfo(url);
    return mutateMusicQueue(channelId, queue => {
      if (queue.queue.length >= QUEUE_MAX) return { error: `Queue full (max ${QUEUE_MAX})` } as MusicCommandResult;
      if (!queue.current) {
        queue.current = info;
        return { nowPlaying: info } as MusicCommandResult;
      }
      queue.queue.push(info);
      return { queued: info, position: queue.queue.length } as MusicCommandResult;
    });
  }
  if (command === '!skip') {
    const next = await skipSharedMusicQueue(channelId);
    return next ? { nowPlaying: next } : { stopped: true };
  }
  if (command === '!stop') {
    await clearSharedMusicQueue(channelId);
    return { stopped: true };
  }
  if (command === '!queue') {
    const queue = await readMusicQueue(channelId);
    return { current: queue.current, queue: queue.queue };
  }
  if (command === '!help') {
    return { commands: ['!play <url>', '!skip', '!stop', '!queue'] };
  }
  return false;
}

/** Test erişimi için alias — prod kodu kullanmamalı */
export { queues as voiceQueues };
