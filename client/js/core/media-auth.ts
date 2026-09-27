// Private attachment credential recovery.
//
// `<img>`, `<video>` and `<audio>` requests cannot carry Bridge's bearer
// header. They use the httpOnly, path-scoped `bridge_media` cookie instead.
// When that cookie expires, all failed elements share one authenticated renewal
// and each element changes its URL at most once.

import { apiFetch } from './api-fetch.ts';
import { getAPI } from './globals.ts';

let credentialGeneration = 0;
let attemptedGeneration: number | null = null;
let renewalPromise: Promise<boolean> | null = null;
let renewalPromiseGeneration: number | null = null;

export function getMediaCredentialGeneration(): number {
  return credentialGeneration;
}

export function isMediaRenewalInFlight(): boolean {
  return renewalPromise !== null;
}

/** A login, logout or test boundary changes the credential generation. */
export function advanceMediaCredentialGeneration(): void {
  credentialGeneration += 1;
  attemptedGeneration = null;
}

/** @internal — deterministic test reset. */
export function resetMediaRenewalState(): void {
  credentialGeneration = 0;
  attemptedGeneration = null;
  renewalPromise = null;
  renewalPromiseGeneration = null;
}

/**
 * A single renewal attempt is allowed for each failed credential generation.
 * Other media elements either await the same promise or observe the newer
 * generation and retry without issuing another request.
 */
export async function renewMediaCredential(failedGeneration: number): Promise<boolean> {
  if (credentialGeneration > failedGeneration) return true;
  if (failedGeneration !== credentialGeneration) return false;
  if (renewalPromise && renewalPromiseGeneration === failedGeneration) return renewalPromise;
  if (attemptedGeneration === failedGeneration) return false;

  attemptedGeneration = failedGeneration;
  renewalPromiseGeneration = failedGeneration;

  // `prefer-const` is WRONG here: the IIFE's `finally` compares against `run`,
  // and if apiFetch throws synchronously that finally executes BEFORE the
  // binding is initialised. With `const` that read is a TDZ ReferenceError;
  // with a definite-assignment `let` it is simply `undefined` and the guard
  // correctly declines to clear a promise it does not own.
  let run!: Promise<boolean>;
  // eslint-disable-next-line prefer-const
  run = (async (): Promise<boolean> => {
    try {
      const response = await apiFetch(`${getAPI()}/api/media/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!response.ok) return credentialGeneration > failedGeneration;
      if (credentialGeneration === failedGeneration) {
        credentialGeneration += 1;
        attemptedGeneration = null;
      }
      return true;
    } catch {
      return credentialGeneration > failedGeneration;
    } finally {
      if (renewalPromise === run) {
        renewalPromise = null;
        renewalPromiseGeneration = null;
      }
    }
  })();

  renewalPromise = run;
  return run;
}

export function isProtectedMediaUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const pageOrigin = location.origin;
    const parsed = new URL(value, pageOrigin);
    const apiOrigin = new URL(getAPI(), pageOrigin).origin;
    const trustedOrigin = parsed.origin === pageOrigin || parsed.origin === apiOrigin;
    return trustedOrigin && /^\/uploads(?:\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Change the URL once so the browser performs a real post-renewal request. */
export function withMediaRetry(value: string, generation: number): string {
  try {
    const wasRootRelative = value.startsWith('/');
    const parsed = new URL(value, location.origin);
    parsed.searchParams.set('_bridge_media_retry', String(generation));
    return wasRootRelative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.href;
  } catch {
    return value;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('bridge:auth-success', advanceMediaCredentialGeneration);
  document.addEventListener('bridge:auth-logout', advanceMediaCredentialGeneration);
}
