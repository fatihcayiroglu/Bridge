// Extracted from electron/desktopSettings.ts; the default desktop policy is unchanged.
export type ServerUrlRejection = 'empty' | 'invalid' | 'insecure' | 'credentials';
export type ServerUrlResult = { ok: true; origin: string } | { ok: false; reason: ServerUrlRejection };

/** Platform adapter output, using established URL parsing primitives. */
export interface ServerOriginParts {
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly origin: string;
}

export interface ServerUrlOptions {
  /** Native runtimes can supply standards-complete URL/IDNA primitives. */
  parseUrl?: (input: string) => ServerOriginParts;
  /** Only a development native adapter may enable the Android emulator host. */
  allowAndroidEmulatorLoopback?: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Turns what a person types into a server origin.
 *
 * - A bare host ("chat.example.com") means HTTPS.
 * - Plain HTTP is accepted only for this machine (localhost/127.0.0.1/::1): the
 *   session token and every message would otherwise cross the network in clear.
 * - Credentials in the URL are rejected rather than silently dropped.
 * - Paths, queries and fragments are ignored; Bridge is served from the origin root.
 */
export function normalizeServerUrl(input: unknown, options: ServerUrlOptions = {}): ServerUrlResult {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, reason: 'empty' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: ServerOriginParts;
  try {
    url = options.parseUrl ? options.parseUrl(withScheme) : new URL(withScheme);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'invalid' };
  if (!url.hostname) return { ok: false, reason: 'invalid' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname) && !(options.allowAndroidEmulatorLoopback === true && url.hostname === '10.0.2.2')) return { ok: false, reason: 'insecure' };
  return { ok: true, origin: url.origin };
}

