// server/lib/dmPush.ts
//
// ════════════════════════════════════════════════════════════════════════════
// P4 — DIRECT AND GROUP MESSAGES REACH A PHONE THAT IS NOT CONNECTED
// ════════════════════════════════════════════════════════════════════════════
// MEASURED: `dm:send` and `gdm:send` emitted only to live sockets. Mentions had a push path
// (lib/notifications.ts deliverPushBatched); direct messages had none. A backgrounded or killed
// mobile app — exactly when a phone needs a notification — never heard about a DM.
//
// Policy is decided BEFORE this module runs: `dm:send` has already applied the canonical DM access
// check (blocks always win, privacy gates new conversations) and `gdm:send` requires current
// membership; group recipients are read from the membership table at send time.
//
// Batching mirrors mention pushes (3 s debounce, 15 s maximum wait, last 3 messages kept) so a
// burst of messages is one notification, and a continuous conversation still notifies.
// End-to-end encrypted DMs never put their content in a push.

import logger from './logger';
import { sendPushToUser, type PushPayload } from './pushSender';
import { serverText, userLocale } from './serverLocale';

export interface DmPushMessage {
  /** Sender. */
  userId: string;
  displayName?: string;
  username?: string;
  content?: string;
  e2e?: boolean;
}

export type DmPushTarget =
  | { kind: 'dm'; dmId: string; fromUserId: string }
  | { kind: 'gdm'; groupId: string; groupName?: string };

interface Pending {
  msgs: DmPushMessage[];
  count: number;
  firstAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  target: DmPushTarget;
}

const DEBOUNCE_MS = 3_000;
const MAX_WAIT_MS = 15_000;
const KEEP = 3;
const PREVIEW = 120;

const pending = new Map<string, Pending>();

function senderName(m: DmPushMessage): string {
  return String(m.displayName || m.username || '').trim() || 'Bridge';
}

function previewOf(m: DmPushMessage, locale: unknown, max: number): string {
  const text = String(m.content ?? '');
  if (m.e2e || text.startsWith('🔒e2e:')) return serverText(locale, 'push_encrypted_message');
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function keyOf(recipientId: string, target: DmPushTarget): string {
  return target.kind === 'dm' ? `${recipientId}:dm:${target.dmId}` : `${recipientId}:gdm:${target.groupId}`;
}

async function flush(recipientId: string, entry: Pending): Promise<void> {
  const last = entry.msgs[entry.msgs.length - 1];
  if (!last) return;
  const locale = await userLocale(recipientId);
  const target = entry.target;
  const conversation = target.kind === 'dm' ? senderName(last) : (target.groupName?.trim() || senderName(last));
  let title: string;
  let body: string;
  if (entry.count === 1) {
    title = conversation;
    body = target.kind === 'dm' ? previewOf(last, locale, PREVIEW) : `${senderName(last)}: ${previewOf(last, locale, PREVIEW)}`;
  } else {
    title = serverText(locale, 'push_dm_many', { count: entry.count, name: conversation });
    body = entry.msgs.slice(-KEEP).map((m) => `${senderName(m)}: ${previewOf(m, locale, 60)}`).join('\n');
  }
  const payload: PushPayload = {
    title,
    body,
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    data: target.kind === 'dm'
      ? { type: 'dm', dmId: target.dmId, fromUserId: target.fromUserId }
      : { type: 'gdm', groupId: target.groupId },
  };
  await sendPushToUser(recipientId, payload);
}

/**
 * Queues a push for one recipient of a direct or group message. Never throws: a push failure must
 * not fail the message that was already stored and delivered to live sockets.
 */
export function deliverDmPushBatched(recipientId: string, message: DmPushMessage, target: DmPushTarget): void {
  if (!recipientId || recipientId === message.userId) return;
  const key = keyOf(recipientId, target);
  const now = Date.now();
  let entry = pending.get(key);
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.msgs.push(message);
    if (entry.msgs.length > KEEP) entry.msgs.splice(0, entry.msgs.length - KEEP);
    entry.count += 1;
    entry.target = target;
  } else {
    entry = { msgs: [message], count: 1, firstAt: now, timer: null, target };
    pending.set(key, entry);
  }
  const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - entry.firstAt)));
  const current = entry;
  current.timer = setTimeout(() => {
    pending.delete(key);
    void flush(recipientId, current).catch((err) => {
      logger.warn({ err: (err as Error)?.message, recipientId, kind: target.kind, event: 'push.dm.flush_failed' }, 'DM push could not be sent');
    });
  }, delay);
  current.timer.unref?.();
}

/** Test hooks. */
export const __pendingDmPushForTest = pending;
export const __DM_PUSH_DEBOUNCE_MS = DEBOUNCE_MS;
export const __DM_PUSH_MAX_WAIT_MS = MAX_WAIT_MS;
