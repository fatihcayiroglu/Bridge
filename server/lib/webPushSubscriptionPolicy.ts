import { assertUrlIsPublicSync } from './ssrfGuard';

export interface CanonicalWebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type WebPushSubscriptionValidation =
  | { ok: true; subscription: CanonicalWebPushSubscription }
  | { ok: false; error: string };

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

/**
 * Canonical storage-bound validation for every Web Push subscription API.
 * Sending performs a second async SSRF check to defend against DNS rebinding;
 * this synchronous boundary prevents obviously private endpoints and unbounded
 * attacker-controlled values from ever being persisted.
 */
export function validateWebPushSubscription(value: unknown): WebPushSubscriptionValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Invalid subscription' };
  }

  const raw = value as { endpoint?: unknown; keys?: unknown };
  if (typeof raw.endpoint !== 'string' || raw.endpoint.length === 0 || raw.endpoint.length > MAX_ENDPOINT_LENGTH) {
    return { ok: false, error: 'Invalid subscription endpoint' };
  }
  if (!raw.keys || typeof raw.keys !== 'object' || Array.isArray(raw.keys)) {
    return { ok: false, error: 'Invalid subscription keys' };
  }

  const keys = raw.keys as { p256dh?: unknown; auth?: unknown };
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length === 0 || keys.p256dh.length > MAX_KEY_LENGTH ||
      typeof keys.auth !== 'string' || keys.auth.length === 0 || keys.auth.length > MAX_KEY_LENGTH) {
    return { ok: false, error: 'Invalid subscription keys' };
  }

  try {
    const parsed = new URL(raw.endpoint);
    if (parsed.protocol !== 'https:') return { ok: false, error: 'Endpoint must be https' };
    assertUrlIsPublicSync(raw.endpoint);
  } catch {
    return { ok: false, error: 'Endpoint host is not allowed' };
  }

  return {
    ok: true,
    subscription: {
      endpoint: raw.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    },
  };
}
