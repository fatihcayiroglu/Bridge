export const PLUGIN_ACTION_PERMISSIONS = {
  'plugin:sendMessage':  'messages:send',
  'plugin:deleteMessage':'messages:delete',
  'plugin:grantRole':    'roles:assign',
} as const;

export const PLUGIN_HOOK_PERMISSIONS: Readonly<Record<string, string>> = {
  'message:created': 'messages:read',
  'member:joined':   'members:read',
};

export const PLUGIN_DB_PERMISSIONS: Readonly<Record<string, string>> = {
  messages: 'messages:read',
  channels: 'channels:read',
  members:  'members:read',
  servers:  'server:info',
  roles:    'server:info',
};

export type PluginActionEvent = keyof typeof PLUGIN_ACTION_PERMISSIONS;

export interface PluginActionEnvelope<T = unknown> {
  __bridgePluginAction: true;
  pluginId: string;
  permissions: string[];
  payload: T;
}

export function isPluginActionEvent(event: string): event is PluginActionEvent {
  return Object.prototype.hasOwnProperty.call(PLUGIN_ACTION_PERMISSIONS, event);
}

export function makePluginActionEnvelope<T>(
  pluginId: string,
  permissions: Iterable<string>,
  payload: T,
): PluginActionEnvelope<T> {
  return {
    __bridgePluginAction: true,
    pluginId,
    permissions: [...new Set(permissions)],
    payload,
  };
}

export function authorizePluginAction<T>(
  raw: unknown,
  event: PluginActionEvent,
): PluginActionEnvelope<T> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PluginActionEnvelope<T>>;
  if (obj.__bridgePluginAction !== true) return null;
  if (typeof obj.pluginId !== 'string' || !/^[a-z0-9_-]{2,64}$/.test(obj.pluginId)) return null;
  if (!Array.isArray(obj.permissions) || obj.permissions.some(p => typeof p !== 'string')) return null;
  const required = PLUGIN_ACTION_PERMISSIONS[event];
  if (!obj.permissions.includes(required)) return null;
  return obj as PluginActionEnvelope<T>;
}
