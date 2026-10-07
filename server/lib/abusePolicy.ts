// server/lib/abusePolicy.ts
//
// P7 B1 — the shared owner of message-level abuse controls added from measured
// gaps (scripts/abuse-lab, docs/P7_TRUST_SOCIAL_FOUNDATION.md § B1 evidence).
//
// Every rule closes a gap the lab measured on a real two-node cluster; every
// threshold is an explicit, documented setting; every mitigation is temporary
// and local to the action: a refusal with a retry time, or one suppressed
// notification. Nothing here bans, mutes for long, or scores a person.
//
//   rule                 lab gap           mitigation
//   repeated content     ATK-02 (2,569/h)  the same normalized text more than
//                                          `repeat.max` times per window is refused
//   repeated link host   ATK-03 (3,996/h)  one site linked more than
//                                          `linkHost.max` times per window is refused
//   mass mention         ATK-04a           more than `mentions.perMessage` distinct
//                                          people in one message is refused (members
//                                          with MENTION_EVERYONE are exempt)
//   repeated pings       ATK-04b (15/15 s) at most `mentions.perTarget` mention
//                                          NOTIFICATIONS from one sender to one person
//                                          per window; the message itself is delivered
//   DM spray             ATK-05 (2,396/h)  at most `dmNew.max` NEW conversations per
//                                          window; existing conversations are unaffected
//
// Privacy: counters are keyed by account id and a truncated SHA-256 of the
// normalized text or link host — message text and visited hosts are never
// written to Redis. End-to-end-encrypted content is not inspected (it cannot
// be); the burst and DM-conversation limits still apply to it.
//
// Counting uses the one cluster-wide window owner (socket/socketRateLimit.ts
// countInWindow): Redis when configured, fail-closed when it is unavailable.

import { createHash } from 'crypto';
import { countInWindow } from '../socket/socketRateLimit';
import { envSafeInt } from './envNumbers';

export const ABUSE_POLICY = Object.freeze({
  repeat: Object.freeze({
    windowMs: envSafeInt('ABUSE_REPEAT_WINDOW_MS', 60_000, { min: 1_000, max: 60 * 60_000 }),
    max: envSafeInt('ABUSE_REPEAT_MAX', 3, { min: 1, max: 1_000 }),
    // Short replies ("ok", "lol", "+1") legitimately repeat; they are not compared.
    minLength: envSafeInt('ABUSE_REPEAT_MIN_LENGTH', 12, { min: 1, max: 2_000 }),
  }),
  linkHost: Object.freeze({
    windowMs: envSafeInt('ABUSE_LINK_HOST_WINDOW_MS', 60_000, { min: 1_000, max: 60 * 60_000 }),
    max: envSafeInt('ABUSE_LINK_HOST_MAX', 4, { min: 1, max: 1_000 }),
  }),
  mentions: Object.freeze({
    perMessage: envSafeInt('ABUSE_MENTIONS_PER_MESSAGE', 20, { min: 1, max: 1_000 }),
    perTarget: envSafeInt('ABUSE_MENTION_NOTIFY_PER_TARGET', 5, { min: 1, max: 1_000 }),
    perTargetWindowMs: envSafeInt('ABUSE_MENTION_NOTIFY_WINDOW_MS', 60_000, { min: 1_000, max: 60 * 60_000 }),
  }),
  dmNew: Object.freeze({
    windowMs: envSafeInt('ABUSE_DM_NEW_WINDOW_MS', 10 * 60_000, { min: 1_000, max: 24 * 60 * 60_000 }),
    max: envSafeInt('ABUSE_DM_NEW_MAX', 10, { min: 1, max: 10_000 }),
  }),
});

export type ContentAbuseVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'spam_repeat' | 'spam_links'; retryAfterMs: number };

// Scheme links, www. links and bare `domain.tld/path` (spam often omits the
// scheme). A bare domain needs a path so ordinary words like "file.txt" or
// "e.g." are not links.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>()]*/gi;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/** Hosts of the links in `content`, lowercased, without `www.`; at most 5. */
export function linkHostsOf(content: string): string[] {
  const hosts = new Set<string>();
  for (const raw of content.match(URL_PATTERN) ?? []) {
    try {
      const host = new URL(/^https?:/i.test(raw) ? raw : `http://${raw}`).hostname.toLowerCase().replace(/^www\./, '');
      if (host) hosts.add(host);
    } catch { /* not a URL after all */ }
    if (hosts.size >= 5) break;
  }
  return [...hosts];
}

/**
 * Text normalized so trivially varied copies compare equal: case, punctuation
 * and whitespace are folded; a link becomes its host. Numbers are NOT folded:
 * the lab measured ordinary messages that differ only by a number ("room 101
 * is free", "room 102 is free"; an offline backlog) being refused as repeats.
 * Number-varied spam carrying a link is caught by the link-host rule instead.
 */
export function contentFingerprint(content: string): string {
  return content
    .normalize('NFKC')
    .replace(URL_PATTERN, (raw) => ` ${linkHostsOf(raw)[0] ?? 'link'} `)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function ownHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const value of [process.env.INSTANCE_URL, process.env.BASE_URL]) {
    try { if (value) hosts.add(new URL(value).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* ignore */ }
  }
  return hosts;
}

/**
 * Repeated-content and repeated-link checks for one outgoing plaintext
 * message. Call once per genuinely new message (after ACK de-duplication), so
 * a replay of the same ackId never counts twice.
 */
export async function checkContentAbuse(userId: string, content: string, now = Date.now()): Promise<ContentAbuseVerdict> {
  const text = typeof content === 'string' ? content : '';

  const fingerprint = contentFingerprint(text);
  if (fingerprint.length >= ABUSE_POLICY.repeat.minLength) {
    const seen = await countInWindow(`abuse:repeat:${userId}:${digest(fingerprint)}`, ABUSE_POLICY.repeat.windowMs, now);
    if (seen > ABUSE_POLICY.repeat.max) {
      return { allowed: false, reason: 'spam_repeat', retryAfterMs: ABUSE_POLICY.repeat.windowMs };
    }
  }

  const own = ownHosts();
  for (const host of linkHostsOf(text)) {
    if (own.has(host)) continue; // links into this Bridge instance (jump links) are not spam
    const seen = await countInWindow(`abuse:linkhost:${userId}:${digest(host)}`, ABUSE_POLICY.linkHost.windowMs, now);
    if (seen > ABUSE_POLICY.linkHost.max) {
      return { allowed: false, reason: 'spam_links', retryAfterMs: ABUSE_POLICY.linkHost.windowMs };
    }
  }
  return { allowed: true };
}

/** Distinct people mentioned (`<@id>` and `@name`); `@everyone`/`@here` are not people. */
export function distinctMentionCount(content: string): number {
  const ids = new Set<string>();
  for (const m of content.matchAll(/<@([A-Za-z0-9_-]+)>/g)) ids.add(`id:${m[1]}`);
  for (const m of content.replace(/<@[A-Za-z0-9_-]+>/g, ' ').matchAll(/(?:^|[^\w@])@([A-Za-z0-9_]{2,32})\b/g)) {
    const name = m[1].toLowerCase();
    if (name !== 'everyone' && name !== 'here') ids.add(`name:${name}`);
  }
  return ids.size;
}

export function mentionsWithinLimit(content: string, mayMentionEveryone: boolean): boolean {
  return mayMentionEveryone || distinctMentionCount(content) <= ABUSE_POLICY.mentions.perMessage;
}

/**
 * Whether one more mention NOTIFICATION from `senderId` to `targetId` fits the
 * window. Suppression only affects the ping; the message is still delivered
 * and still shows the mention in the channel.
 */
export async function mentionNotificationAllowed(senderId: string, targetId: string, now = Date.now()): Promise<boolean> {
  const seen = await countInWindow(`abuse:ping:${senderId}:${targetId}`, ABUSE_POLICY.mentions.perTargetWindowMs, now);
  return seen <= ABUSE_POLICY.mentions.perTarget;
}

export type NewConversationVerdict = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Budget for opening NEW direct conversations. Existing ones never consume it. */
export async function claimNewDmConversation(userId: string, now = Date.now()): Promise<NewConversationVerdict> {
  const opened = await countInWindow(`abuse:dmnew:${userId}`, ABUSE_POLICY.dmNew.windowMs, now);
  return opened <= ABUSE_POLICY.dmNew.max
    ? { allowed: true }
    : { allowed: false, retryAfterMs: ABUSE_POLICY.dmNew.windowMs };
}
