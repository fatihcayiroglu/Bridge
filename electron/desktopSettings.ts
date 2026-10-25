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

export { normalizeServerUrl, type ServerUrlResult, type ServerUrlRejection } from '@bridge/core';
import { normalizeServerUrl } from '@bridge/core';

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
