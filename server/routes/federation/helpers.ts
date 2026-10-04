// server/routes/federation/helpers.ts
//
// Compatibility facade only.
//
// Historical Bridge revisions accidentally grew two independent ActivityPub
// handler/delivery implementations (`helpers.ts` and `inbox-handlers.ts` /
// `delivery.ts`). Production activitypub.ts imports this file while deeper
// tests exercise the other implementation, so fixes could be green without
// protecting the live route. Keep the old import surface, but delegate every
// operation to the canonical owners.

export {
  handleApFollow,
  handleApUnfollow,
  handleApAccept,
  handleApReject,
  handleApLike,
  handleApAnnounce,
} from './inbox-handlers';

// P6 lifecycle ordering/tombstones live in a production wrapper so Create can
// preserve the canonical DM/audience/notification behavior while Update/Delete
// gain stale-event ordering and late-Create resurrection protection.
export {
  handleApCreate,
  handleApDelete,
  handleApUpdate,
} from './inbox-lifecycle';

export {
  signRequest,
  deliverApActivity,
  fanOutActivityToFollowers,
  deliverToFollowers,
} from './delivery';
