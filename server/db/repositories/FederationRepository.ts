// server/db/repositories/FederationRepository.js
// Federation peers, ActivityPub koleksiyonları ve ACL listeleri.

'use strict';
const db = require('../loader');

class FederationRepository {
  // ── Peers ─────────────────────────────────────────────────

  async findPeers() {
    return db.federationPeers?.find({}) ?? [];
  }

  async findPeerByUrl(url) {
    return db.federationPeers?.findOne({ url });
  }

  async insertPeer(peer) {
    return db.federationPeers?.insert(peer);
  }

  async removePeerById(id) {
    return db.federationPeers?.remove({ _id: id });
  }

  async updatePeer(id, modifier) {
    return db.federationPeers?.update({ _id: id }, modifier);
  }

  async updatePeersWhere(filter, modifier) {
    try {
      return await db.federationPeers?.update(filter, modifier);
    } catch {
      return null;
    }
  }

  // ── ACL (admin + middleware) ──────────────────────────────

  async findWhitelist() {
    return db.federationWhitelist?.find({}) ?? [];
  }

  async findWhitelistOne(query) {
    return db.federationWhitelist?.findOne(query);
  }

  async insertWhitelist(entry) {
    return db.federationWhitelist?.insert(entry);
  }

  async removeWhitelistByDomain(domain) {
    return db.federationWhitelist?.remove({ domain });
  }

  async findBlacklist() {
    return db.federationBlacklist?.find({}) ?? [];
  }

  async findBlacklistOne(query) {
    return db.federationBlacklist?.findOne(query);
  }

  async insertBlacklist(entry) {
    return db.federationBlacklist?.insert(entry);
  }

  async removeBlacklistByDomain(domain) {
    return db.federationBlacklist?.remove({ domain });
  }

  // ── ActivityPub: Activities ───────────────────────────────

  async insertActivity(doc) {
    try {
      return await db.apActivities?.insert(doc);
    } catch {
      return null;
    }
  }

  /** Sıralama/limit zinciri için ham find döndürür. */
  apActivitiesFind(query) {
    return db.apActivities?.find(query);
  }

  async findActivities(query) {
    return db.apActivities?.find(query);
  }

  async countActivities(query) {
    return db.apActivities?.count(query).catch(() => 0) ?? 0;
  }

  // ── AP Follows (remote → local user) ──────────────────────

  async findApFollows(query) {
    return db.apFollows?.find(query) ?? [];
  }

  async findApFollowOne(query) {
    try {
      return await db.apFollows?.findOne(query);
    } catch {
      return null;
    }
  }

  async insertApFollow(doc) {
    try {
      return await db.apFollows?.insert(doc);
    } catch {
      return null;
    }
  }

  async updateApFollow(filter, modifier) {
    try {
      return await db.apFollows?.update(filter, modifier);
    } catch {
      return null;
    }
  }

  async removeApFollow(filter, opts) {
    return db.apFollows?.remove(filter, opts ?? {}).catch(() => {});
  }

  // ── AP Outgoing follows ───────────────────────────────────

  async findApOutgoingFollows(query) {
    return db.apOutgoingFollows?.find(query) ?? [];
  }

  async findApOutgoingFollowOne(query) {
    try {
      return await db.apOutgoingFollows?.findOne(query);
    } catch {
      return null;
    }
  }

  async insertApOutgoingFollow(doc) {
    try {
      return await db.apOutgoingFollows?.insert(doc);
    } catch {
      return null;
    }
  }

  async updateApOutgoingFollow(filter, modifier) {
    try {
      return await db.apOutgoingFollows?.update(filter, modifier);
    } catch {
      return null;
    }
  }

  async removeApOutgoingFollow(filter, opts) {
    return db.apOutgoingFollows?.remove(filter, opts ?? {}).catch(() => {});
  }

  // ── AP federated messages ─────────────────────────────────

  async insertApMessage(doc) {
    return db.apMessages?.insert(doc).catch(() => {});
  }

  async updateApMessage(filter, modifier) {
    try {
      return await db.apMessages?.update(filter, modifier);
    } catch {
      return null;
    }
  }

  async removeApMessage(filter, opts) {
    return db.apMessages?.remove(filter, opts ?? {}).catch(() => {});
  }

  async findApMessages(query) {
    return db.apMessages?.find(query) ?? [];
  }

  apMessagesFind(query) {
    return db.apMessages?.find(query);
  }

  async countApMessages(query) {
    return db.apMessages?.count(query).catch(() => 0) ?? 0;
  }

  // ── AP likes / announces ──────────────────────────────────

  async insertApLike(doc) {
    try {
      return await db.apLikes?.insert(doc);
    } catch {
      return null;
    }
  }

  async removeApLike(filter, opts) {
    return db.apLikes?.remove(filter, opts ?? {}).catch(() => {});
  }

  async findApLikeOne(query) {
    try {
      return await db.apLikes?.findOne(query);
    } catch {
      return null;
    }
  }

  async insertApAnnounce(doc) {
    try {
      return await db.apAnnounces?.insert(doc);
    } catch {
      return null;
    }
  }

  async removeApAnnounce(filter, opts) {
    return db.apAnnounces?.remove(filter, opts ?? {}).catch(() => {});
  }

  // ── AP Delivery Queue (persistent retry) ─────────────────────
  // Koleksiyon: ap_delivery_queue
  // { _id, payload: {inboxUrl,activity,fromUser}, attempts, nextAt, createdAt }

  async insertDeliveryEntry(doc) {
    try {
      return await db.apDeliveryQueue?.insert(doc);
    } catch {
      return null;
    }
  }

  async upsertDeliveryEntry(id, doc) {
    try {
      const existing = await db.apDeliveryQueue?.findOne({ _id: id });
      if (existing) {
        return await db.apDeliveryQueue?.update({ _id: id }, { $set: doc });
      }
      return await db.apDeliveryQueue?.insert({ _id: id, ...doc });
    } catch {
      return null;
    }
  }

  async findPendingDeliveries(beforeTs) {
    try {
      return (await db.apDeliveryQueue?.find({ nextAt: { $lte: beforeTs } })) ?? [];
    } catch {
      return [];
    }
  }

  async removeDeliveryEntry(id) {
    try {
      return await db.apDeliveryQueue?.remove({ _id: id });
    } catch {
      return null;
    }
  }

  async countPendingDeliveries() {
    try {
      const rows = await db.apDeliveryQueue?.find({});
      return Array.isArray(rows) ? rows.length : 0;
    } catch {
      return 0;
    }
  }
}

module.exports = new FederationRepository();
export {};
