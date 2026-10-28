// server/lib/nativeAppLinks.ts
//
// Verified-link association for the native sign-in callback (security review
// finding 1: any app can register a private-use URI scheme and receive the
// authorization code). With Android App Links / iOS Universal Links the OS
// delivers an https callback ONLY to the app the callback host vouches for.
//
// This module is configuration only; it is OFF unless all of these hold:
//   · NATIVE_AUTH_REDIRECT_URIS contains at least one https redirect (already
//     validated by loadNativeAuthConfig: a dedicated host, never the web origin);
//   · NATIVE_APP_LINKS_ANDROID_PACKAGE + NATIVE_APP_LINKS_ANDROID_CERT_SHA256
//     and/or NATIVE_APP_LINKS_IOS_APP_IDS are set and well formed.
// A malformed value disables the feature entirely (fail closed: a typo must not
// vouch for the wrong app). The association files are served only when the
// request's host is one of the https callback hosts, so the Bridge web origin
// never claims any path for an app.
//
// No production domain is chosen here; that is an owner/deployment decision.
import { loadNativeAuthConfig } from './nativeAuth';

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const CERT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const IOS_APP_ID_RE = /^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const MAX_ENTRIES = 4;

export type NativeAppLinksConfig =
  | {
      enabled: true;
      /** lower-case host → callback paths on that host */
      callbacks: ReadonlyMap<string, readonly string[]>;
      android: { packageName: string; certSha256: readonly string[] } | null;
      iosAppIds: readonly string[] | null;
    }
  | { enabled: false; reason: 'not_configured' | 'no_https_redirect' | 'invalid_configuration' };

function list(raw: string | undefined): string[] | null {
  const items = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
}

export function loadNativeAppLinksConfig(env: NodeJS.ProcessEnv = process.env): NativeAppLinksConfig {
  const pkg = (env.NATIVE_APP_LINKS_ANDROID_PACKAGE ?? '').trim();
  const certs = list(env.NATIVE_APP_LINKS_ANDROID_CERT_SHA256);
  const iosIds = list(env.NATIVE_APP_LINKS_IOS_APP_IDS);
  if (!pkg && !certs && !iosIds) return { enabled: false, reason: 'not_configured' };

  // Android needs both halves; a package without a signing certificate (or the
  // reverse) is a configuration error, not "Android off".
  if (Boolean(pkg) !== Boolean(certs)) return { enabled: false, reason: 'invalid_configuration' };
  if (pkg && (!PACKAGE_RE.test(pkg) || certs!.length > MAX_ENTRIES || !certs!.every((c) => CERT_RE.test(c)))) {
    return { enabled: false, reason: 'invalid_configuration' };
  }
  if (iosIds && (iosIds.length > MAX_ENTRIES || !iosIds.every((id) => IOS_APP_ID_RE.test(id)))) {
    return { enabled: false, reason: 'invalid_configuration' };
  }

  const auth = loadNativeAuthConfig(env);
  if (!auth.enabled) return { enabled: false, reason: auth.reason === 'invalid_configuration' ? 'invalid_configuration' : 'no_https_redirect' };
  const callbacks = new Map<string, string[]>();
  for (const uri of auth.redirectUris) {
    const url = new URL(uri);
    if (url.protocol !== 'https:') continue;
    const host = url.host.toLowerCase();
    const paths = callbacks.get(host) ?? [];
    if (!paths.includes(url.pathname)) paths.push(url.pathname);
    callbacks.set(host, paths);
  }
  if (callbacks.size === 0) return { enabled: false, reason: 'no_https_redirect' };

  return {
    enabled: true,
    callbacks,
    android: pkg ? { packageName: pkg, certSha256: certs! } : null,
    iosAppIds: iosIds,
  };
}

/** Digital Asset Links statement list (served at /.well-known/assetlinks.json). */
export function assetLinksDocument(cfg: Extract<NativeAppLinksConfig, { enabled: true }>): unknown[] | null {
  if (!cfg.android) return null;
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: cfg.android.packageName, sha256_cert_fingerprints: [...cfg.android.certSha256] },
  }];
}

/**
 * apple-app-site-association for one callback host: Universal Links limited to
 * that host's callback paths, plus `webcredentials` (required for an https
 * ASWebAuthenticationSession callback).
 */
export function appleAssociationDocument(cfg: Extract<NativeAppLinksConfig, { enabled: true }>, host: string): unknown | null {
  if (!cfg.iosAppIds) return null;
  const paths = cfg.callbacks.get(host.toLowerCase());
  if (!paths) return null;
  return {
    applinks: { details: [{ appIDs: [...cfg.iosAppIds], components: paths.map((p) => ({ '/': p, comment: 'Bridge native sign-in callback' })) }] },
    webcredentials: { apps: [...cfg.iosAppIds] },
  };
}
