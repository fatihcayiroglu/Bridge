import { writable } from 'svelte/store';

export type ServerSettingsTab = 'general' | 'roles' | 'channels' | 'media' | 'emoji' | 'webhooks' | 'audit' | 'plugins' | string;
export interface ServerSettingsServer {
  id?: string;
  _id?: string;
  name?: string;
  icon?: string | null;
  banner?: string | null;
  slug?: string | null;
  [key: string]: unknown;
}
export interface ServerSettingsStore {
  serverId: string;
  server: ServerSettingsServer;
  activeTab: ServerSettingsTab;
  error: string | null;
  name: string;
  icon: string;
  slug: string;
  slugPreview: string;
  bannerUrl: string;
  iconUrl: string;
  saving: boolean;
  setTab(tab: ServerSettingsTab): void;
  setError(error: string | null): void;
  setName(value: string): void;
  setIcon(value: string): void;
  setSlug(value: string): void;
  setBannerUrl(value: string): void;
  setIconUrl(value: string): void;
  saveGeneral(): Promise<boolean>;
  saveSlug(): Promise<boolean>;
  saveMedia(): Promise<boolean>;
  loadSlug(): Promise<void>;
  reload(): Promise<void>;
  subscribe: ReturnType<typeof writable<Record<string, unknown>>>['subscribe'];
  [key: string]: unknown;
}

export function getCurrentServerFromRegistry(): ServerSettingsServer | null { return null; }

export function createServerSettingsStore(input: string | ServerSettingsServer = ''): ServerSettingsStore {
  const server = typeof input === 'string' ? { id: input, _id: input, name: '' } : input;
  const serverId = String(server._id ?? server.id ?? '');
  const initial = {
    serverId,
    server,
    activeTab: 'general',
    error: null,
    name: String(server.name ?? ''),
    icon: String(server.icon ?? ''),
    slug: String(server.slug ?? ''),
    slugPreview: '',
    bannerUrl: String(server.banner ?? ''),
    iconUrl: String(server.icon ?? ''),
    saving: false,
  } satisfies Record<string, unknown>;
  const state = writable<Record<string, unknown>>(initial);
  const commit = (patch: Record<string, unknown>) => state.update(s => ({ ...s, ...patch }));
  const store: ServerSettingsStore = {
    ...initial,
    activeTab: 'general',
    error: null,
    subscribe: state.subscribe,
    setTab(tab) { store.activeTab = tab; commit({ activeTab: tab }); },
    setError(error) { store.error = error; commit({ error }); },
    setName(value) { store.name = value; commit({ name: value }); },
    setIcon(value) { store.icon = value; commit({ icon: value, iconUrl: value }); },
    setSlug(value) { store.slug = value; commit({ slug: value, slugPreview: value }); },
    setBannerUrl(value) { store.bannerUrl = value; commit({ bannerUrl: value }); },
    setIconUrl(value) { store.iconUrl = value; commit({ iconUrl: value }); },
    async saveGeneral() { return true; },
    async saveSlug() { return true; },
    async saveMedia() { return true; },
    async loadSlug() { store.slugPreview = store.slug; commit({ slugPreview: store.slug }); },
    async reload() {},
  };
  return store;
}
