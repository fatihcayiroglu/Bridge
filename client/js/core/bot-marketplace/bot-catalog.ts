import { apiFetch } from '../api-fetch.ts';
import { getAPI } from '../globals.ts';
import type { BotEntry } from './types.js';

const catalog: BotEntry[] = [];

function normalizeBot(raw: unknown): BotEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : '';
  const name = typeof row.name === 'string' ? row.name : '';
  const category = typeof row.category === 'string' ? row.category : '';
  if (!id || !name || !category) return null;
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const finite = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    id, name, category,
    description: typeof row.description === 'string' ? row.description : '',
    longDescription: typeof row.longDescription === 'string' ? row.longDescription : (typeof row.description === 'string' ? row.description : ''),
    author: typeof row.author === 'string' ? row.author : '',
    avatar: typeof row.avatar === 'string' ? row.avatar : '🤖',
    tags: strings(row.tags), commands: strings(row.commands),
    featured: row.featured === true,
    rating: Math.min(5, Math.max(0, finite(row.rating))),
    installs: Math.max(0, finite(row.installs)),
    installable: row.installable === true,
    requestedScopes: strings(row.requestedScopes),
    unsupportedPermissions: strings(row.unsupportedPermissions),
    authorVerified: row.authorVerified === true,
  };
}

export function getCatalog(): BotEntry[] { return catalog; }

export async function loadCatalog(): Promise<BotEntry[]> {
  const response = await apiFetch(`${getAPI()}/api/bots/marketplace?limit=100`);
  if (!response.ok) throw new Error(`Marketplace catalog HTTP ${response.status}`);
  const payload = await response.json() as { bots?: unknown };
  const next = Array.isArray(payload?.bots) ? payload.bots.map(normalizeBot).filter((bot): bot is BotEntry => bot !== null) : [];
  catalog.splice(0, catalog.length, ...next);
  return catalog;
}
