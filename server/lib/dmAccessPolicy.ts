import { Dms, Social } from '../db/repositories';
import { normalizeDmPrivacy } from './userUtils';

export type DmAccessDenial = 'blocked' | 'privacy_none' | 'friends_only';
export type DmAccessResult =
  | { allowed: true; existingConversation: boolean }
  | { allowed: false; reason: DmAccessDenial };

/**
 * Blocking is an unconditional safety boundary: an existing conversation does
 * not preserve access after either participant blocks the other.
 *
 * Privacy (`friends` / `none`) controls *starting* a conversation. Existing
 * conversations keep working across later privacy preference changes, matching
 * the established Bridge product contract.
 *
 * Repository failures intentionally propagate. Callers must fail closed rather
 * than interpreting an unavailable policy store as "not blocked"/"not found".
 */
export async function evaluateDmAccess(
  senderId: string,
  recipient: { _id: string; dmPrivacy?: unknown },
): Promise<DmAccessResult> {
  const recipientId = recipient._id;

  const senderBlockedRecipient = await Social.findBlock(senderId, recipientId);
  if (senderBlockedRecipient) return { allowed: false, reason: 'blocked' };
  const recipientBlockedSender = await Social.findBlock(recipientId, senderId);
  if (recipientBlockedSender) return { allowed: false, reason: 'blocked' };

  const existingConversation = await Dms.findConversationByParticipants(senderId, recipientId);
  if (existingConversation) return { allowed: true, existingConversation: true };

  const privacy = normalizeDmPrivacy(recipient.dmPrivacy);
  if (privacy === 'none') return { allowed: false, reason: 'privacy_none' };
  if (privacy === 'friends') {
    const friendship = await Social.findFriendship(senderId, recipientId);
    const accepted = Boolean(friendship && (friendship as { status?: unknown }).status === 'accepted');
    if (!accepted) return { allowed: false, reason: 'friends_only' };
  }

  return { allowed: true, existingConversation: false };
}

/** Blocking-only check for call/signaling initiation where dmPrivacy is not the gate. */
export async function isDmBlocked(userA: string, userB: string): Promise<boolean> {
  if (await Social.findBlock(userA, userB)) return true;
  return Boolean(await Social.findBlock(userB, userA));
}
