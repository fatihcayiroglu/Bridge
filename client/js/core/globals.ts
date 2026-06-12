// client/js/core/globals.ts
// Compatibility exports for legacy modules.
import { BridgeRegistry } from './bridge-registry.ts';

export function getAPI(): string {
  const api = (globalThis as unknown as { BRIDGE_API?: unknown }).BRIDGE_API;
  return typeof api === 'string' && api.length > 0 ? api : location.origin;
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

export const currentServerChannels: Array<{ _id: string; name?: string; type?: string; bitrate?: number }> = new Proxy([] as Array<{ _id: string; name?: string; type?: string; bitrate?: number }>, {
  get(target, prop, receiver) {
    const channels = BridgeRegistry.get<unknown>('currentServerChannels');
    const value = typeof channels === 'function' ? channels() : channels;
    if (Array.isArray(value)) {
      return Reflect.get(value, prop, receiver);
    }
    return Reflect.get(target, prop, receiver);
  },
});

export const friendsCache: Map<string, unknown> = new Map();
export function getRtc(): unknown {
  return BridgeRegistry.get<unknown>('rtc') ?? BridgeRegistry.get<unknown>('BridgeRTC') ?? null;
}
