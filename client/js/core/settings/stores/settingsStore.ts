import { writable } from 'svelte/store';
export type SettingsTab = 'profile' | 'appearance' | 'notifications' | 'privacy' | 'devices' | string;
export type BridgeLayoutMode = 'cozy' | 'compact' | 'comfortable' | 'classic' | 'focus' | string;
export interface SettingsStore {
  activeTab: SettingsTab;
  error: string | null;
  saving: boolean;
  profile?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
  privacy?: Record<string, unknown>;
  devices?: Record<string, unknown>;
  layoutMode?: BridgeLayoutMode;
  setTab(tab: SettingsTab): void;
  setError(error: string | null): void;
  save(payload?: Record<string, unknown>): Promise<boolean>;
  reload(): Promise<void>;
  setLayoutMode(mode: BridgeLayoutMode): void;
  setDevicePreference(key: string, value: unknown): void;
  setPrivacyOption(key: string, value: unknown): void;
  subscribe: ReturnType<typeof writable<Record<string, unknown>>>['subscribe'];
  [key: string]: unknown;
}
export function createSettingsStore(initialTab: SettingsTab = 'profile'): SettingsStore {
  const state = writable<Record<string, unknown>>({ activeTab: initialTab, error: null, saving: false, layoutMode: 'cozy' });
  const commit = (patch: Record<string, unknown>) => state.update(s => ({ ...s, ...patch }));
  const store: SettingsStore = {
    activeTab: initialTab,
    error: null,
    saving: false,
    layoutMode: 'cozy',
    subscribe: state.subscribe,
    setTab(tab) { store.activeTab = tab; commit({ activeTab: tab }); },
    setError(error) { store.error = error; commit({ error }); },
    async save(payload = {}) { store.saving = true; commit({ saving: true, ...payload }); store.saving = false; commit({ saving: false }); return true; },
    async reload() {},
    setLayoutMode(mode) { store.layoutMode = mode; commit({ layoutMode: mode }); },
    setDevicePreference(key, value) { const devices = { ...(store.devices ?? {}), [key]: value }; store.devices = devices; commit({ devices }); },
    setPrivacyOption(key, value) { const privacy = { ...(store.privacy ?? {}), [key]: value }; store.privacy = privacy; commit({ privacy }); },
  };
  return store;
}
