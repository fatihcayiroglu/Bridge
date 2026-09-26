// server/lib/webauthn-origin.ts
//
// WebAuthn origin and RP-ID policy has one owner. Startup validation and both
// ceremony completion handlers must make the same decision; keeping parsers in
// lib/env.ts and routes/webauthn.ts previously let the two paths drift apart.

export interface WebAuthnEnvironment {
  NODE_ENV?: string;
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_ORIGIN?: string;
  INSTANCE_URL?: string;
  DOMAIN?: string;
}

export interface ParsedWebAuthnOrigin {
  origin: string;
  hostname: string;
}

export interface WebAuthnOriginConfiguration {
  ok: boolean;
  rpId: string;
  origins: string[];
  source?: 'WEBAUTHN_ORIGIN' | 'INSTANCE_URL';
  field?: 'WEBAUTHN_RP_ID' | 'WEBAUTHN_ORIGIN' | 'INSTANCE_URL';
  message?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Resolve the RP ID exactly as the ceremony options and RP hash verifier do. */
export function resolveWebAuthnRpId(env: WebAuthnEnvironment = process.env): string {
  return (env.WEBAUTHN_RP_ID || env.DOMAIN || 'localhost').trim().toLowerCase();
}

/**
 * Return the canonical DNS/IP spelling of an RP ID, or null for values that
 * are URLs, contain ports/paths/wildcards, or are not valid host names.
 */
export function normalizeWebAuthnRpId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  if (!candidate || candidate.length > 253 || candidate.includes('*') || candidate.endsWith('.')) return null;

  // RP IDs are host names, never URLs or host:port values. IPv6 literals are
  // deliberately not accepted here: WebAuthn RP IDs use domain strings and
  // Bridge's explicitly supported loopback spellings are localhost/127.0.0.1.
  if (/[/:@?#[\]]/.test(candidate)) return null;

  let hostname: string;
  try {
    const parsed = new URL(`https://${candidate}`);
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }

  // Reject alternative numeric spellings (for example 127.1) and IDN input
  // that was not already provided in its canonical ASCII form.
  if (hostname !== candidate) return null;

  const labels = hostname.split('.');
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return hostname;
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

export function isExplicitWebAuthnLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(unbracketHostname(hostname));
}

/**
 * Parse a serialized WebAuthn origin. Only HTTP(S) tuple origins are valid;
 * non-loopback HTTP, credentials, paths, queries, fragments, opaque schemes,
 * and wildcard hosts are rejected rather than normalized away.
 */
export function parseWebAuthnOrigin(value: unknown): ParsedWebAuthnOrigin | null {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const hostname = unbracketHostname(parsed.hostname);
  if (!hostname || hostname.includes('*') || parsed.username || parsed.password) return null;
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.protocol === 'http:' && !isExplicitWebAuthnLoopback(hostname)) return null;
  if (parsed.origin === 'null') return null;

  return { origin: parsed.origin.toLowerCase(), hostname };
}

/** Exact host or dot-delimited subdomain match; suffix-only matching is unsafe. */
export function webAuthnHostMatchesRpId(hostname: string, rpId: string): boolean {
  const host = unbracketHostname(hostname);
  if (host === rpId) return true;
  // IP RP IDs can only match the exact IP. A string such as x.127.0.0.1 is a
  // DNS name, not a WebAuthn subdomain of the IP address.
  if (/^\d+(?:\.\d+){3}$/.test(rpId)) return false;
  return host.endsWith(`.${rpId}`);
}

function configuredOriginSource(env: WebAuthnEnvironment): {
  source?: 'WEBAUTHN_ORIGIN' | 'INSTANCE_URL'; raw?: string;
} {
  // Presence, not truthiness, determines ownership. An explicitly blank
  // WEBAUTHN_ORIGIN is invalid and must not silently fall through to another
  // variable with different operational meaning.
  if (env.WEBAUTHN_ORIGIN !== undefined) {
    return { source: 'WEBAUTHN_ORIGIN', raw: env.WEBAUTHN_ORIGIN };
  }
  if (env.INSTANCE_URL !== undefined) {
    return { source: 'INSTANCE_URL', raw: env.INSTANCE_URL };
  }
  return {};
}

/** Validate and normalize the complete startup/runtime WebAuthn policy. */
export function validateWebAuthnOriginConfiguration(
  env: WebAuthnEnvironment = process.env,
): WebAuthnOriginConfiguration {
  const rawRpId = resolveWebAuthnRpId(env);
  const rpId = normalizeWebAuthnRpId(rawRpId);
  if (!rpId) {
    return {
      ok: false, rpId: rawRpId, origins: [], field: 'WEBAUTHN_RP_ID',
      message: 'WEBAUTHN_RP_ID geçerli, portsuz ve jokersiz bir alan adı/IP olmalı',
    };
  }

  const { source, raw } = configuredOriginSource(env);
  if (!source) return { ok: true, rpId, origins: [] };

  const entries = (raw ?? '').split(',').map(entry => entry.trim());
  if (!entries.length || entries.some(entry => !entry)) {
    return {
      ok: false, rpId, origins: [], source, field: source,
      message: `${source} boş origin girdisi içeremez`,
    };
  }

  const origins: string[] = [];
  for (const entry of entries) {
    const parsed = parseWebAuthnOrigin(entry);
    if (!parsed) {
      return {
        ok: false, rpId, origins: [], source, field: source,
        message: `${source} geçerli bir WebAuthn origin değil: ${entry}`,
      };
    }
    if (!webAuthnHostMatchesRpId(parsed.hostname, rpId)) {
      return {
        ok: false, rpId, origins: [], source, field: source,
        message: `${source} hostname (${parsed.hostname}) WEBAUTHN_RP_ID (${rpId}) ile eşleşmiyor`,
      };
    }
    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }

  return { ok: true, rpId, origins, source };
}

/** Runtime ceremony check shared by registration and authentication. */
export function isAllowedWebAuthnOrigin(
  clientOrigin: unknown,
  env: WebAuthnEnvironment = process.env,
): boolean {
  const client = parseWebAuthnOrigin(clientOrigin);
  if (!client) return false;

  const configured = validateWebAuthnOriginConfiguration(env);
  if (!configured.ok) return false;
  if (configured.origins.length > 0) return configured.origins.includes(client.origin);

  // Missing production configuration is fail-closed. Development gets a
  // narrow convenience fallback, but only for the loopback host compatible
  // with the configured/default RP ID; localhost and 127.0.0.1 are not
  // interchangeable WebAuthn identities.
  if (env.NODE_ENV === 'production') return false;
  return isExplicitWebAuthnLoopback(client.hostname)
    && webAuthnHostMatchesRpId(client.hostname, configured.rpId);
}
