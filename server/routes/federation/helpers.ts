// server/routes/federation/helpers.ts
//
// Compatibility facade only.
//
// Historical Bridge revisions accidentally grew two independent ActivityPub
// handler/delivery implementations (`helpers.ts` and `inbox-handlers.ts` /
// `delivery.ts`). Production activitypub.ts imported this file while deeper
// tests exercised the other implementation, so fixes could be green without
// protecting the live route. Keep the old import surface, but delegate every
// operation to the canonical owners.

export {
  handleApFollow,
  handleApUnfollow,
  handleApAccept,
  handleApReject,
  handleApCreate,
  handleApDelete,
  handleApUpdate,
  handleApLike,
  handleApAnnounce,
} from './inbox-handlers';

export {
  signRequest,
  deliverApActivity,
  fanOutActivityToFollowers,
  deliverToFollowers,
} from './delivery';
