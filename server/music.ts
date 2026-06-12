// server/music.ts
// Müzik kuyruğu yönetimi — in-memory, channel bazlı.
// Sprint 99: server/routes/music.ts → server/music.ts taşındı (import yolları düzeltildi).
// Sprint 100: Tip güvenliği tam hale getirildi (implicit any'ler giderildi).

const QUEUE_MAX = 25;

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

export function isValidMusicUrl(url: string): boolean {
  try {
    const u = new URL(url);
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
  const q = getQueue(channelId);

  if (command === '!play') {
    const url = args[0];
    if (!url)                          return { error: 'URL required' };
    if (!isValidMusicUrl(url))         return { error: 'Invalid music URL' };
    if (q.queue.length >= QUEUE_MAX)   return { error: `Queue full (max ${QUEUE_MAX})` };
    const info = await getVideoInfo(url);
    if (!q.current) { q.current = info; return { nowPlaying: info }; }
    q.queue.push(info);
    return { queued: info, position: q.queue.length };
  }
  if (command === '!skip') {
    const next = skipCurrent(channelId);
    return next ? { nowPlaying: next } : { stopped: true };
  }
  if (command === '!stop') {
    clearQueue(channelId);
    return { stopped: true };
  }
  if (command === '!queue') {
    return { current: q.current, queue: q.queue };
  }
  if (command === '!help') {
    return { commands: ['!play <url>', '!skip', '!stop', '!queue'] };
  }
  return false;
}

/** Test erişimi için alias — prod kodu kullanmamalı */
export { queues as voiceQueues };
