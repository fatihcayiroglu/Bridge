// client/js/core/globals.ts
// Compatibility exports for legacy modules.
import { BridgeRegistry } from './bridge-registry.ts';

export function getAPI(): string {
  const api = (globalThis as unknown as { BRIDGE_API?: unknown }).BRIDGE_API;
  return typeof api === 'string' && api.length > 0 ? api : location.origin;
}

// ── SUNUCU-GÖRELİ ADRESLER (Final21 Faz 19, 19-28) ─────────────────────────────
// Web'de API kökeni sayfanın kökenidir ve `/api/…`, `/uploads/…` gibi göreli yollar doğru
// çözülür. Paketlenmiş mobil uygulamada sayfanın kökeni `https://localhost`tur (Capacitor):
// göreli yol ORAYA çözülür ve uygulama sunucu yerine kendi `index.html`ini alırdı (ölçüldü:
// "Handling local request: https://localhost/api/…"). `BRIDGE_API` yalnızca o derlemede
// tanımlıdır (mobile/scripts/setup.js → js/bridge-config.js); web'de bu iki yardımcı dizgeyi
// DEĞİŞTİRMEDEN döndürür.
function externalApiBase(): string | null {
  const api = (globalThis as unknown as { BRIDGE_API?: unknown }).BRIDGE_API;
  return typeof api === 'string' && api.length > 0 ? api.replace(/\/+$/, '') : null;
}

/** İstek adresi: sunucu-göreli yol, harici API kökeni varsa ona bağlanır. */
export function toServerUrl(url: string): string {
  const api = externalApiBase();
  return api && url.startsWith('/') && !url.startsWith('//') ? `${api}${url}` : url;
}

/** Sunucudan gelen medya adresi: yalnız http(s) ya da sunucu-göreli yol (javascript:/data: reddedilir). */
export function safeServerUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return toServerUrl(value);
  try {
    const parsed = new URL(value, location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch { return null; }
}

export const currentServer = new Proxy({} as { _id?: string; [key: string]: unknown }, {
  get(_target, prop) {
    const server = BridgeRegistry.get<unknown>('currentServer') ?? BridgeRegistry.get<unknown>('getCurrentServer');
    const value = typeof server === 'function' ? server() : server;
    if (value && typeof value === 'object') {
      return (value as Record<PropertyKey, unknown>)[prop];
    }
    return undefined;
  },
  set(_target, prop, value) {
    const server = BridgeRegistry.get<unknown>('currentServer') ?? BridgeRegistry.get<unknown>('getCurrentServer');
    const target = typeof server === 'function' ? server() : server;
    if (target && typeof target === 'object') {
      (target as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    }
    return false;
  },
});

function liveServerChannels(): unknown {
  const channels = BridgeRegistry.get<unknown>('currentServerChannels');
  return typeof channels === 'function' ? channels() : channels;
}

export const currentServerChannels: Array<{ _id: string; name?: string; type?: string; bitrate?: number }> = new Proxy([] as Array<{ _id: string; name?: string; type?: string; bitrate?: number }>, {
  get(target, prop, receiver) {
    const value = liveServerChannels();
    if (Array.isArray(value)) {
      return Reflect.get(value, prop, receiver);
    }
    return Reflect.get(target, prop, receiver);
  },
  // `filter`/`map`/`forEach`/`some`/`reduce` ask HasProperty(this, index)
  // before reading it, and that question is answered by the `has` trap — NOT
  // by `get`. Without this trap the question fell through to the empty local
  // target, so every index looked absent: `filter` returned [], `map` produced
  // holes and `forEach` visited nothing, even though `length` and
  // `channels[i]` both reported live data. That silently emptied the text
  // channel picker in Server Settings → Webhooks (WebhookTab.svelte builds it
  // with `currentServerChannels.filter(...)`), so no outgoing webhook could be
  // created at all.
  has(target, prop) {
    const value = liveServerChannels();
    return Array.isArray(value) ? Reflect.has(value, prop) : Reflect.has(target, prop);
  },
});

export const friendsCache: Map<string, unknown> = new Map();
export function getRtc(): unknown {
  // Canonical runtime owner is the instantiated engine. `BridgeRTC` is the
  // constructor kept only for compatibility and has no instance methods on the
  // class object; falling back to it turns optional calls into silent no-ops.
  return BridgeRegistry.get<unknown>('rtc') ?? null;
}
