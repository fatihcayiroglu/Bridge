// server/lib/serverLocale.ts
//
// Text the SERVER sends to a person (push notification titles today).
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS (Final21 Phase 16)
// ════════════════════════════════════════════════════════════════════════════
// The client ships ten locales, but everything the server itself writes to a person was
// Turkish only: a German or Japanese reader got "Ayse seni mention etti" on the lock screen.
// The server could not do better because nothing recorded WHICH language a person reads —
// `users` had no locale column at all (migration 075 adds it; the client writes it).
//
// Scope is deliberately small and honest: only the strings the server actually sends. A key
// with a missing translation falls back to Turkish rather than shipping an empty push.

import { Users } from '../db/repositories';

export const SERVER_LOCALES = ['tr', 'en', 'es', 'ru', 'ja', 'ko', 'zh', 'pt', 'de', 'fr'] as const;
export type ServerLocale = typeof SERVER_LOCALES[number];
export const DEFAULT_SERVER_LOCALE: ServerLocale = 'tr';

export type ServerTextKey =
  | 'push_mention_title'      // {name} mentioned you
  | 'push_watch_word_title'   // {name} — a word you follow
  | 'push_many_notifications' // {count} new notifications — {channel}
  | 'push_many_mentions'      // {count} new mentions — {channel}
  | 'push_dm_many'            // {count} new messages — {name}   (P4: DM / group DM batches)
  | 'push_encrypted_message'; // an end-to-end encrypted message (no preview leaves the server)

type Catalog = Record<ServerTextKey, string>;

const CATALOGS: Record<ServerLocale, Catalog> = {
  tr: {
    push_mention_title: '{name} seni mention etti',
    push_watch_word_title: '{name} — takip ettiğin kelime',
    push_many_notifications: '{count} yeni bildirim — {channel}',
    push_many_mentions: '{count} yeni mention — {channel}',
    push_dm_many: '{count} yeni mesaj — {name}',
    push_encrypted_message: '🔒 Şifreli mesaj',
  },
  en: {
    push_mention_title: '{name} mentioned you',
    push_watch_word_title: '{name} — a word you follow',
    push_many_notifications: '{count} new notifications — {channel}',
    push_many_mentions: '{count} new mentions — {channel}',
    push_dm_many: '{count} new messages — {name}',
    push_encrypted_message: '🔒 Encrypted message',
  },
  es: {
    push_mention_title: '{name} te mencionó',
    push_watch_word_title: '{name} — una palabra que sigues',
    push_many_notifications: '{count} notificaciones nuevas — {channel}',
    push_many_mentions: '{count} menciones nuevas — {channel}',
    push_dm_many: '{count} mensajes nuevos — {name}',
    push_encrypted_message: '🔒 Mensaje cifrado',
  },
  ru: {
    push_mention_title: '{name} упомянул вас',
    push_watch_word_title: '{name} — слово, за которым вы следите',
    push_many_notifications: '{count} новых уведомлений — {channel}',
    push_many_mentions: '{count} новых упоминаний — {channel}',
    push_dm_many: '{count} новых сообщений — {name}',
    push_encrypted_message: '🔒 Зашифрованное сообщение',
  },
  ja: {
    push_mention_title: '{name} があなたにメンションしました',
    push_watch_word_title: '{name} — フォロー中のキーワード',
    push_many_notifications: '新しい通知が {count} 件 — {channel}',
    push_many_mentions: '新しいメンションが {count} 件 — {channel}',
    push_dm_many: '新しいメッセージが {count} 件 — {name}',
    push_encrypted_message: '🔒 暗号化されたメッセージ',
  },
  ko: {
    push_mention_title: '{name}님이 회원님을 멘션했습니다',
    push_watch_word_title: '{name} — 팔로우 중인 단어',
    push_many_notifications: '새 알림 {count}개 — {channel}',
    push_many_mentions: '새 멘션 {count}개 — {channel}',
    push_dm_many: '새 메시지 {count}개 — {name}',
    push_encrypted_message: '🔒 암호화된 메시지',
  },
  zh: {
    push_mention_title: '{name} 提到了你',
    push_watch_word_title: '{name} — 你关注的关键词',
    push_many_notifications: '{count} 条新通知 — {channel}',
    push_many_mentions: '{count} 条新提及 — {channel}',
    push_dm_many: '{count} 条新消息 — {name}',
    push_encrypted_message: '🔒 加密消息',
  },
  pt: {
    push_mention_title: '{name} mencionou você',
    push_watch_word_title: '{name} — uma palavra que você segue',
    push_many_notifications: '{count} novas notificações — {channel}',
    push_many_mentions: '{count} novas menções — {channel}',
    push_dm_many: '{count} novas mensagens — {name}',
    push_encrypted_message: '🔒 Mensagem criptografada',
  },
  de: {
    push_mention_title: '{name} hat dich erwähnt',
    push_watch_word_title: '{name} — ein Wort, dem du folgst',
    push_many_notifications: '{count} neue Benachrichtigungen — {channel}',
    push_many_mentions: '{count} neue Erwähnungen — {channel}',
    push_dm_many: '{count} neue Nachrichten — {name}',
    push_encrypted_message: '🔒 Verschlüsselte Nachricht',
  },
  fr: {
    push_mention_title: '{name} t’a mentionné',
    push_watch_word_title: '{name} — un mot que tu suis',
    push_many_notifications: '{count} nouvelles notifications — {channel}',
    push_many_mentions: '{count} nouvelles mentions — {channel}',
    push_dm_many: '{count} nouveaux messages — {name}',
    push_encrypted_message: '🔒 Message chiffré',
  },
};

/** A stored value becomes a supported locale, or the default. Never throws. */
export function normalizeServerLocale(value: unknown): ServerLocale {
  if (typeof value !== 'string') return DEFAULT_SERVER_LOCALE;
  // `split(…, 1).join('')`: always a string (the first segment) without an index access that the
  // strict profile types as possibly undefined, and without an unreachable fallback branch.
  const base = value.trim().toLowerCase().split(/[-_]/, 1).join('');
  return (SERVER_LOCALES as readonly string[]).includes(base) ? base as ServerLocale : DEFAULT_SERVER_LOCALE;
}

/** Server-owned text for one person. Placeholders are `{name}`, `{count}`, `{channel}`. */
export function serverText(locale: unknown, key: ServerTextKey, vars: Record<string, string | number> = {}): string {
  // No `?? DEFAULT` here: normalizeServerLocale returns a member of SERVER_LOCALES and the
  // parity test proves each one has a catalog, so a fallback would be unreachable code.
  const catalog = CATALOGS[normalizeServerLocale(locale)];
  // Same reason as the catalog lookup above: `Catalog` requires every key in every locale and
  // the parity test proves it, so a per-key fallback could never run. Behaviour for an
  // untyped caller with an unknown key is unchanged (both spellings threw).
  const template = catalog[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

/**
 * The locale a person reads, or the default.
 *
 * Fail-soft on purpose: this lookup only decides WORDING. A database hiccup (or a caller whose
 * repository surface does not expose `findById`) must never break delivery of the notification
 * itself, so every failure falls back to the default locale instead of propagating.
 */
export async function userLocale(userId: string): Promise<ServerLocale> {
  try {
    // Static import on purpose: a dynamic import here would run on every push and adds an
    // extra async hop to the notification path.
    const lookup = (Users as { findById?: (id: string) => Promise<unknown> } | undefined)?.findById;
    if (typeof lookup !== 'function') return DEFAULT_SERVER_LOCALE;
    const row = await lookup.call(Users, userId) as { locale?: unknown } | null;
    return normalizeServerLocale(row?.locale);
  } catch {
    return DEFAULT_SERVER_LOCALE;
  }
}

/** Exposed for the parity test: every locale must carry every key. */
export const __CATALOGS_FOR_TEST = CATALOGS;
