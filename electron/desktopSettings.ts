// electron/desktopSettings.ts
//
// The desktop app is a CLIENT of a Bridge server (Final21 Phase 12). It used to
// spawn a bundled copy of the server, but that copy shipped without its
// node_modules, database or secrets: the installed app crashed on
// `Cannot find module 'dotenv/config'` and showed an empty window.
//
// This module owns the one piece of state the client needs — which server to
// open — and is side-effect free apart from the two explicit file functions,
// so the validation rules are unit-tested directly.

import fs from 'fs';
import path from 'path';

export interface DesktopSettings {
  /** Origin of the Bridge server (scheme://host[:port]), or null before first connection. */
  serverOrigin: string | null;
}

export const DEFAULT_SETTINGS: DesktopSettings = { serverOrigin: null };

export type ServerUrlRejection = 'empty' | 'invalid' | 'insecure' | 'credentials';
export type ServerUrlResult = { ok: true; origin: string } | { ok: false; reason: ServerUrlRejection };

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
export function normalizeServerUrl(input: unknown): ServerUrlResult {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, reason: 'empty' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'invalid' };
  if (!url.hostname) return { ok: false, reason: 'invalid' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, reason: 'insecure' };
  return { ok: true, origin: url.origin };
}

/** Reads settings; a missing, unreadable or malformed file yields the defaults. */
export function readDesktopSettings(file: string): DesktopSettings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const origin = (parsed as { serverOrigin?: unknown } | null)?.serverOrigin;
    const normalized = normalizeServerUrl(origin);
    return { serverOrigin: normalized.ok ? normalized.origin : null };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Writes settings atomically (temp file + rename) so a crash never leaves half a file. */
export function writeDesktopSettings(file: string, settings: DesktopSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
