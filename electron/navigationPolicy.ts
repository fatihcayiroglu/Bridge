/**
 * Canonical desktop navigation policy. Keep URL parsing in a side-effect-free
 * module so Electron handlers and regression tests share the exact same owner.
 *
 * Final21 Phase 12: the trusted origin is the Bridge server the user connected
 * to (see desktopSettings.ts). It used to be the constant `http://localhost:3001`
 * while the window loaded `http://127.0.0.1:3001` — a different origin — so the
 * app's own pages failed every trust check. Until a server is chosen, NOTHING is
 * a trusted app origin (fail closed).
 */
let appOrigin: string | null = null;

/** Sets the trusted Bridge server origin (`null` before the first connection). */
export function setAppOrigin(origin: string | null): void {
  appOrigin = origin === null ? null : new URL(origin).origin;
}

export function getAppOrigin(): string | null {
  return appOrigin;
}

export function isSameAppOrigin(value: string): boolean {
  if (!appOrigin) return false;
  try {
    return new URL(value).origin === appOrigin;
  } catch {
    return false;
  }
}

export function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
