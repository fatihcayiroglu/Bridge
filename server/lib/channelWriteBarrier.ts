/**
 * P7 D2: application side of the PostgreSQL channel write barrier
 * (migration 085). The database decides; this module only recognises its
 * denial so callers answer "channel unavailable" instead of a generic error
 * or a retry. Never treat a denial as retryable: the channel will not come
 * back.
 */
export const CHANNEL_WRITE_DENIED_SQLSTATE = 'BX001';

export function isChannelWriteDenied(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    (err as { code?: unknown }).code === CHANNEL_WRITE_DENIED_SQLSTATE;
}
