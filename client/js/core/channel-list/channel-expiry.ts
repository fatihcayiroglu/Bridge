// client/js/core/channel-list/channel-expiry.ts
//
// P7 D2 (#321): ephemeral channels in the client. The server is authoritative: it stores
// `expiresAt` (epoch ms, database clock), enforces the 1 h – 30 d window, owner-only access and
// optimistic versioning. This module only reads what the server sent, formats it for people,
// and builds the request. It never decides that a channel is gone (the authorized list does).

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Mirrors the server bounds (server/lib/channelExpiry.ts). */
export const MIN_LIFETIME_MS = HOUR_MS;
export const MAX_LIFETIME_MS = 30 * DAY_MS;
/** Within this, the expiry is shown as a warning, not just information. */
export const EXPIRY_SOON_MS = DAY_MS;
/**
 * The client clock may differ from the database clock. Choices at the edges of the window are
 * pulled inwards by this much so "1 hour" and "30 days" are not refused for a few seconds of skew.
 */
export const CLOCK_SKEW_MARGIN_MS = 2 * 60 * 1000;

export type ExpiryChoiceKey = 'never' | '1h' | '24h' | '7d' | '30d';
export const EXPIRY_CHOICES: ReadonlyArray<{ key: ExpiryChoiceKey; lifetimeMs: number | null }> = Object.freeze([
  { key: 'never', lifetimeMs: null },
  { key: '1h', lifetimeMs: HOUR_MS },
  { key: '24h', lifetimeMs: DAY_MS },
  { key: '7d', lifetimeMs: 7 * DAY_MS },
  { key: '30d', lifetimeMs: 30 * DAY_MS },
]);

/** The channel's expiry as a positive epoch-ms number, or null (permanent or unreadable). */
export function channelExpiresAt(channel: unknown): number | null {
  if (!channel || typeof channel !== 'object') return null;
  const raw = (channel as { expiresAt?: unknown }).expiresAt;
  const value = typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : raw;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The stored optimistic-concurrency version (0 for a channel that never had an expiry). */
export function channelExpiryVersion(channel: unknown): number {
  if (!channel || typeof channel !== 'object') return 0;
  const raw = (channel as { expiryVersion?: unknown }).expiryVersion;
  const value = typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : raw;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export interface ExpiryDisplay {
  /** Absolute local date and time, e.g. "Thursday, 23 October 2026 at 14:05". */
  absolute: string;
  /** ISO timestamp for <time datetime>. */
  iso: string;
  /** Expires within EXPIRY_SOON_MS: show as a warning. */
  soon: boolean;
}

/** Human-readable, absolute (not "in 3 h", which goes stale on screen). Null when permanent. */
export function formatChannelExpiry(expiresAt: number | null, now: number, locale?: string): ExpiryDisplay | null {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return null;
  const date = new Date(expiresAt);
  let absolute: string;
  try {
    absolute = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }).format(date);
  } catch {
    absolute = date.toLocaleString();
  }
  return { absolute, iso: date.toISOString(), soon: expiresAt - now <= EXPIRY_SOON_MS };
}

/** The `expiresAt` to request for a choice, kept inside the server window despite clock skew. */
export function requestedExpiresAt(lifetimeMs: number | null, now: number): number | null {
  if (lifetimeMs === null) return null;
  const lifetime = Math.min(Math.max(lifetimeMs, MIN_LIFETIME_MS + CLOCK_SKEW_MARGIN_MS), MAX_LIFETIME_MS - CLOCK_SKEW_MARGIN_MS);
  return Math.floor(now + lifetime);
}

export type ExpiryFailure = 'last_permanent_channel' | 'version_conflict' | 'outside_window' | 'forbidden' | 'not_found' | 'failed';
export type ExpiryResult =
  | { ok: true; expiresAt: number | null; expiryVersion: number }
  | { ok: false; reason: ExpiryFailure };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const FAILURE_BY_CODE: Record<string, ExpiryFailure> = {
  LAST_PERMANENT_CHANNEL: 'last_permanent_channel',
  VERSION_CONFLICT: 'version_conflict',
  OUTSIDE_WINDOW: 'outside_window',
};

/** PUT /api/servers/:sid/channels/:cid/expiry with the version the user saw. */
export async function saveChannelExpiry(
  fetchFn: Fetch, apiBase: string, serverId: string, channelId: string,
  expiresAt: number | null, expectedVersion: number,
): Promise<ExpiryResult> {
  let res: Response;
  try {
    res = await fetchFn(
      `${apiBase}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/expiry`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresAt, expectedVersion }) },
    );
  } catch {
    return { ok: false, reason: 'failed' };
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (res.ok && body) {
    const saved = channelExpiresAt(body);
    if (expiresAt !== null && saved === null) return { ok: false, reason: 'failed' };
    return { ok: true, expiresAt: saved, expiryVersion: channelExpiryVersion(body) };
  }
  const code = typeof body?.code === 'string' ? body.code : '';
  if (FAILURE_BY_CODE[code]) return { ok: false, reason: FAILURE_BY_CODE[code]! };
  if (res.status === 403) return { ok: false, reason: 'forbidden' };
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (res.status === 422) return { ok: false, reason: 'outside_window' };
  return { ok: false, reason: 'failed' };
}
