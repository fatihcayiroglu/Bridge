// client/js/core/push-installation.ts
//
// P4 — which push targets THIS installation owns. Dependency-free on purpose: auth-compat reads
// it synchronously inside logout(), and native-push / web-push-client write it; importing either
// of those from auth-compat would create an import cycle (api-fetch already imports auth-compat).

export const NATIVE_TOKEN_KEY = 'bridge_native_push_token';
export const NATIVE_PLATFORM_KEY = 'bridge_native_push_platform';
export const WEB_ENDPOINT_KEY = 'bridge_web_push_endpoint';

export interface LogoutPushTargets {
  nativeToken?: string;
  webEndpoint?: string;
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Identifiers the server needs to stop pushing to this installation when it signs out. */
export function pushTargetsForLogout(): LogoutPushTargets {
  const nativeToken = read(NATIVE_TOKEN_KEY);
  const webEndpoint = read(WEB_ENDPOINT_KEY);
  return {
    ...(nativeToken ? { nativeToken } : {}),
    ...(webEndpoint ? { webEndpoint } : {}),
  };
}

export function rememberWebEndpoint(endpoint: string | null): void {
  try {
    if (endpoint) localStorage.setItem(WEB_ENDPOINT_KEY, endpoint);
    else localStorage.removeItem(WEB_ENDPOINT_KEY);
  } catch { /* storage disabled */ }
}
