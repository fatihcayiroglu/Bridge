// Canonical persisted AutoMod policy contract shared by HTTP CRUD and realtime enforcement.
// Keep input normalization here so route validation and message enforcement cannot drift.

export const AUTOMOD_RULE_TYPES = [
  'blocked_words',
  'spam_messages',
  'caps_lock',
  'link_filter',
  'invite_filter',
  'mention_spam',
  'repeated_chars',
] as const;

export type AutomodRuleType = typeof AUTOMOD_RULE_TYPES[number];
export type AutomodAction = 'delete' | 'timeout' | 'delete_and_timeout';

export interface AutomodConfig {
  action: AutomodAction;
  timeoutMs: number;
  logChannelId: string | null;
  exemptRoles: string[];
  words?: string[];
  maxMessages?: number;
  windowSecs?: number;
  minLength?: number;
  maxMentions?: number;
  minRepeat?: number;
}

export interface AutomodRuleLike {
  _id?: unknown;
  serverId?: unknown;
  type?: unknown;
  enabled?: unknown;
  config?: unknown;
}

export interface AutomodDecision {
  matched: boolean;
  matchedRuleIds: string[];
  reasons: string[];
  deleteMessage: boolean;
  timeoutMs: number | null;
  logChannelIds: string[];
}

export type NormalizeAutomodResult =
  | { ok: true; config: AutomodConfig }
  | { ok: false; error: string };

const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const GENERIC_KEYS = new Set(['action', 'timeoutMs', 'logChannelId', 'exemptRoles']);
const TYPE_KEYS: Record<AutomodRuleType, ReadonlySet<string>> = {
  blocked_words: new Set(['words']),
  spam_messages: new Set(['maxMessages', 'windowSecs']),
  caps_lock: new Set(['minLength']),
  link_filter: new Set(),
  invite_filter: new Set(),
  mention_spam: new Set(['maxMentions']),
  repeated_chars: new Set(['minRepeat']),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

function cleanOptionalId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return trimmed;
}

export function isAutomodRuleType(value: unknown): value is AutomodRuleType {
  return typeof value === 'string' && (AUTOMOD_RULE_TYPES as readonly string[]).includes(value);
}

/** PostgreSQL JSONB returns objects; legacy/mock rows may still contain JSON strings. */
export function parseStoredAutomodConfig(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return { ...value };
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Strict request/runtime normalization. No string/boolean/number coercion. */
export function normalizeAutomodConfig(type: AutomodRuleType, input: unknown): NormalizeAutomodResult {
  if (!isPlainObject(input)) return { ok: false, error: 'config nesne olmalı' };

  const allowed = TYPE_KEYS[type];
  for (const key of Object.keys(input)) {
    if (!GENERIC_KEYS.has(key) && !allowed.has(key)) {
      return { ok: false, error: `config.${key} desteklenmiyor` };
    }
  }

  let action: AutomodAction = 'delete';
  if (input.action !== undefined) {
    if (input.action !== 'delete' && input.action !== 'timeout' && input.action !== 'delete_and_timeout') {
      return { ok: false, error: 'config.action geçersiz' };
    }
    action = input.action;
  }

  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000, MAX_TIMEOUT_MS);
  if (timeoutMs === null) return { ok: false, error: 'config.timeoutMs 60000 ile 604800000 arasında güvenli bir tam sayı olmalı' };

  let logChannelId: string | null = null;
  if (input.logChannelId !== undefined) {
    const parsed = cleanOptionalId(input.logChannelId);
    if (parsed === undefined) return { ok: false, error: 'config.logChannelId null veya geçerli bir kimlik olmalı' };
    logChannelId = parsed;
  }

  let exemptRoles: string[] = [];
  if (input.exemptRoles !== undefined) {
    if (!Array.isArray(input.exemptRoles) || input.exemptRoles.length > 10) {
      return { ok: false, error: 'config.exemptRoles en fazla 10 rol kimliği içeren bir dizi olmalı' };
    }
    const seen = new Set<string>();
    for (const raw of input.exemptRoles) {
      const roleId = cleanOptionalId(raw);
      if (!roleId || roleId === '__everyone__') {
        return { ok: false, error: 'config.exemptRoles geçersiz rol kimliği içeriyor' };
      }
      seen.add(roleId);
    }
    exemptRoles = [...seen];
  }

  const config: AutomodConfig = { action, timeoutMs, logChannelId, exemptRoles };

  if (type === 'blocked_words') {
    if (!Array.isArray(input.words) || input.words.length < 1 || input.words.length > 100) {
      return { ok: false, error: 'blocked_words için config.words 1-100 kelime içermeli' };
    }
    const seen = new Set<string>();
    for (const raw of input.words) {
      if (typeof raw !== 'string') return { ok: false, error: 'config.words yalnızca string değerler içermeli' };
      const word = raw.trim().toLowerCase();
      if (!word || word.length > 50) return { ok: false, error: 'config.words içindeki her kelime 1-50 karakter olmalı' };
      seen.add(word);
    }
    config.words = [...seen];
  } else if (type === 'spam_messages') {
    const maxMessages = boundedInteger(input.maxMessages, 5, 2, 20);
    const windowSecs = boundedInteger(input.windowSecs, 5, 1, 60);
    if (maxMessages === null) return { ok: false, error: 'config.maxMessages 2-20 arasında tam sayı olmalı' };
    if (windowSecs === null) return { ok: false, error: 'config.windowSecs 1-60 arasında tam sayı olmalı' };
    config.maxMessages = maxMessages;
    config.windowSecs = windowSecs;
  } else if (type === 'caps_lock') {
    const minLength = boundedInteger(input.minLength, 8, 4, 50);
    if (minLength === null) return { ok: false, error: 'config.minLength 4-50 arasında tam sayı olmalı' };
    config.minLength = minLength;
  } else if (type === 'mention_spam') {
    const maxMentions = boundedInteger(input.maxMentions, 5, 2, 20);
    if (maxMentions === null) return { ok: false, error: 'config.maxMentions 2-20 arasında tam sayı olmalı' };
    config.maxMentions = maxMentions;
  } else if (type === 'repeated_chars') {
    const minRepeat = boundedInteger(input.minRepeat, 10, 5, 30);
    if (minRepeat === null) return { ok: false, error: 'config.minRepeat 5-30 arasında tam sayı olmalı' };
    config.minRepeat = minRepeat;
  }

  return { ok: true, config };
}

function countMentions(content: string): number {
  return (content.match(/<@[A-Za-z0-9_-]+>|@(?:everyone|here)\b|@[A-Za-z0-9_]{2,32}\b/g) || []).length;
}

function hasRepeatedRun(content: string, minRepeat: number): boolean {
  let previous = '';
  let run = 0;
  for (const char of content) {
    if (char === previous) run += 1;
    else { previous = char; run = 1; }
    if (run >= minRepeat) return true;
  }
  return false;
}

function matchesContentRule(type: AutomodRuleType, config: AutomodConfig, content: string): string | null {
  const lower = content.toLowerCase();
  if (type === 'blocked_words') {
    const hit = (config.words || []).find((word) => lower.includes(word));
    return hit ? 'Yasaklı kelime filtresi' : null;
  }
  if (type === 'caps_lock') {
    if (content.length < (config.minLength || 8)) return null;
    const upper = (content.match(/[A-ZÇĞİÖŞÜ]/g) || []).length / Math.max(content.length, 1);
    return upper > 0.65 ? 'Aşırı büyük harf kullanımı' : null;
  }
  if (type === 'link_filter') {
    return /\b(?:https?:\/\/|www\.)\S+/i.test(content) ? 'Link filtresi' : null;
  }
  if (type === 'invite_filter') {
    return /\/invite\/[A-Za-z0-9_-]{2,}/i.test(content) ? 'Davet linki filtresi' : null;
  }
  if (type === 'mention_spam') {
    return countMentions(content) > (config.maxMentions || 5) ? 'Toplu mention filtresi' : null;
  }
  if (type === 'repeated_chars') {
    return hasRepeatedRun(content, config.minRepeat || 10) ? 'Tekrar karakter filtresi' : null;
  }
  return null;
}

function persistedEnabledState(value: unknown): 'enabled' | 'disabled' | 'invalid' {
  if (value === true || value === 1) return 'enabled';
  if (value === false || value === 0) return 'disabled';
  return 'invalid';
}

/**
 * Runtime enforcement must distinguish an actually empty JSON object from a
 * malformed persisted value. `parseStoredAutomodConfig()` intentionally keeps
 * its legacy-friendly public API and returns `{}` on bad input, which is useful
 * for display/migration code but unsafe for an enabled moderation rule: for
 * rule types whose default config is valid (for example `link_filter`) a broken
 * JSON value could otherwise silently turn into a different policy.
 */
function parseStoredAutomodConfigForEnforcement(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return { ...value };
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function evaluateAutomodRules(
  rules: AutomodRuleLike[],
  context: {
    serverId: string;
    userId: string;
    content: string;
    memberRoleIds: string[];
    event?: 'send' | 'edit';
  },
  increment: (key: string, ttlSeconds: number) => Promise<number>,
): Promise<AutomodDecision> {
  const decision: AutomodDecision = {
    matched: false,
    matchedRuleIds: [],
    reasons: [],
    deleteMessage: false,
    timeoutMs: null,
    logChannelIds: [],
  };
  const roleIds = new Set(context.memberRoleIds);

  for (const rule of Array.isArray(rules) ? rules : []) {
    const enabled = persistedEnabledState(rule.enabled);
    if (enabled === 'disabled') continue;
    if (enabled === 'invalid') {
      throw new Error(`Invalid persisted AutoMod enabled state for rule ${String(rule._id ?? '<unknown>')}`);
    }
    if (!isAutomodRuleType(rule.type)) {
      throw new Error(`Invalid persisted AutoMod rule type for rule ${String(rule._id ?? '<unknown>')}`);
    }

    const storedConfig = parseStoredAutomodConfigForEnforcement(rule.config);
    if (!storedConfig) {
      throw new Error(`Invalid persisted AutoMod config for rule ${String(rule._id ?? '<unknown>')}`);
    }
    const normalized = normalizeAutomodConfig(rule.type, storedConfig);
    if (!normalized.ok) {
      throw new Error(`Invalid persisted AutoMod config for rule ${String(rule._id ?? '<unknown>')}: ${normalized.error}`);
    }
    const config = normalized.config;
    if (config.exemptRoles.some((roleId) => roleIds.has(roleId))) continue;

    let reason: string | null;
    if (rule.type === 'spam_messages') {
      // Message frequency belongs to send semantics. Editing an existing message
      // must not consume/inflate the spam counter.
      if (context.event === 'edit') continue;
      const ruleId = typeof rule._id === 'string' && rule._id ? rule._id : rule.type;
      const count = await increment(
        `automod:spam:${context.serverId}:${ruleId}:${context.userId}`,
        config.windowSecs || 5,
      );
      reason = count > (config.maxMessages || 5) ? 'Mesaj sıklığı filtresi' : null;
    } else {
      reason = matchesContentRule(rule.type, config, context.content);
    }
    if (!reason) continue;

    decision.matched = true;
    const ruleId = typeof rule._id === 'string' && rule._id ? rule._id : rule.type;
    if (!decision.matchedRuleIds.includes(ruleId)) decision.matchedRuleIds.push(ruleId);
    if (!decision.reasons.includes(reason)) decision.reasons.push(reason);
    if (config.action === 'delete' || config.action === 'delete_and_timeout') decision.deleteMessage = true;
    if (config.action === 'timeout' || config.action === 'delete_and_timeout') {
      decision.timeoutMs = Math.max(decision.timeoutMs || 0, config.timeoutMs);
    }
    if (config.logChannelId && !decision.logChannelIds.includes(config.logChannelId)) {
      decision.logChannelIds.push(config.logChannelId);
    }
  }

  return decision;
}
