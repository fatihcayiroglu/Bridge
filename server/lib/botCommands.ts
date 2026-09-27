export interface BotSlashCommandMetadata {
  name: string;
  description: string;
  usage: string;
}

export interface BotContextCommandMetadata {
  name: string;
  type: 'USER_COMMAND' | 'MESSAGE_COMMAND';
  description: string;
}

const SLASH_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_COMMANDS = 100;

function objectArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length > MAX_COMMANDS) return null;
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    out.push(entry as Record<string, unknown>);
  }
  return out;
}

export function normalizeSlashCommands(value: unknown): BotSlashCommandMetadata[] | null {
  const entries = objectArray(value);
  if (!entries) return null;
  const seen = new Set<string>();
  const out: BotSlashCommandMetadata[] = [];
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || !SLASH_NAME_RE.test(entry.name)) return null;
    const name = entry.name.toLowerCase();
    if (seen.has(name)) return null;
    seen.add(name);
    if (entry.description != null && typeof entry.description !== 'string') return null;
    if (entry.usage != null && typeof entry.usage !== 'string') return null;
    const description = String(entry.description ?? '').trim();
    const usage = String(entry.usage ?? '').trim();
    if (description.length > 100 || usage.length > 200) return null;
    out.push({ name, description, usage });
  }
  return out;
}

export function normalizeContextCommands(value: unknown): BotContextCommandMetadata[] | null {
  const entries = objectArray(value);
  if (!entries) return null;
  const seen = new Set<string>();
  const out: BotContextCommandMetadata[] = [];
  for (const entry of entries) {
    if (typeof entry.name !== 'string') return null;
    const name = entry.name.trim();
    if (!name || name.length > 32 || seen.has(name)) return null;
    seen.add(name);
    if (entry.type !== 'USER_COMMAND' && entry.type !== 'MESSAGE_COMMAND') return null;
    if (entry.description != null && typeof entry.description !== 'string') return null;
    const description = String(entry.description ?? '').trim();
    if (description.length > 100) return null;
    out.push({ name, type: entry.type, description });
  }
  return out;
}

/** Persisted JSONB may be a parsed array or a legacy JSON string. Corruption is fail-closed. */
export function readPersistedCommandArray(value: unknown): Record<string, unknown>[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
  } catch {
    return [];
  }
}
