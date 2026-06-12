// server/db/repositories/FederationRepository.ts
// Federation peers, ActivityPub koleksiyonları ve ACL listeleri.

import db from '../loader';

class FederationRepository {
  // ── Peers ─────────────────────────────────────────────────

  async findPeers() {
    return db.federationPeers?.find({}) ?? [];
  }

  async findPeerByUrl(url: string) {
    return db.federationPeers?.findOne({ url });
  }

  async getPeerByUrl(url: string) {
    return this.findPeerByUrl(url);
  }

  async insertPeer(peer: Record<string, unknown>) {
    return db.federationPeers?.insert(peer);
  }

  async removePeerById(id: string) {
    return db.federationPeers?.remove({ _id: id });
  }

  async updatePeer(id: string, modifier: Record<string, unknown>) {
    return db.federationPeers?.update({ _id: id }, modifier);
  }

  async updatePeersWhere(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
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

  async findWhitelistOne(query: Record<string, unknown>) {
    return db.federationWhitelist?.findOne(query);
  }

  async insertWhitelist(entry: Record<string, unknown>) {
    return db.federationWhitelist?.insert(entry);
  }

  async removeWhitelistByDomain(domain: string) {
    return db.federationWhitelist?.remove({ domain });
  }

  async findBlacklist() {
    return db.federationBlacklist?.find({}) ?? [];
  }

  async findBlacklistOne(query: Record<string, unknown>) {
    return db.federationBlacklist?.findOne(query);
  }

  async insertBlacklist(entry: Record<string, unknown>) {
    return db.federationBlacklist?.insert(entry);
  }

  async removeBlacklistByDomain(domain: string) {
    return db.federationBlacklist?.remove({ domain });
  }

  // ── ActivityPub: Activities ───────────────────────────────

  async insertActivity(doc: Record<string, unknown>) {
    try {
      return await db.apActivities?.insert(doc);
    } catch {
      return null;
    }
  }

  /** Sıralama/limit zinciri için ham find döndürür. */
  apActivitiesFind(query: Record<string, unknown>) {
    return db.apActivities?.find(query);
  }

  async findActivities(query: Record<string, unknown>) {
    return db.apActivities?.find(query);
  }

  async countActivities(query: Record<string, unknown>) {
    return db.apActivities?.count(query).catch(() => 0) ?? 0;
  }

  // ── AP Follows (remote → local user) ──────────────────────

  async findApFollows(query: Record<string, unknown>) {
    return db.apFollows?.find(query) ?? [];
  }

  async findApFollowOne(query: Record<string, unknown>) {
    try {
      return await db.apFollows?.findOne(query);
    } catch {
      return null;
    }
  }

  async insertApFollow(doc: Record<string, unknown>) {
    try {
      return await db.apFollows?.insert(doc);
    } catch {
      return null;
    }
  }

  async updateApFollow(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    try {
      return await db.apFollows?.update(filter, modifier);
    } catch {
      return null;
    }
  }

  async removeApFollow(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apFollows?.remove(filter, opts ?? {}).catch(() => {});
  }

  // ── AP Outgoing follows ───────────────────────────────────

  async findApOutgoingFollows(query: Record<string, unknown>) {
    return db.apOutgoingFollows?.find(query) ?? [];
  }

  async findApOutgoingFollowOne(query: Record<string, unknown>) {
    try {
      return await db.apOutgoingFollows?.findOne(query);
    } catch {
      return null;
    }
  }

  async insertApOutgoingFollow(doc: Record<string, unknown>) {
    try {
      return await db.apOutgoingFollows?.insert(doc);
    } catch {
      return null;
    }
  }

  async updateApOutgoingFollow(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    try {
      return await db.apOutgoingFollows?.update(filter, modifier);
    } catch {
      return null;
    }
  }

  async removeApOutgoingFollow(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apOutgoingFollows?.remove(filter, opts ?? {}).catch(() => {});
  }

  // ── AP federated messages ─────────────────────────────────

  async insertApMessage(doc: Record<string, unknown>) {
    return db.apMessages?.insert(doc).catch(() => {});
  }

  async updateApMessage(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    try {
      return await db.apMessages?.update(filter, modifier);
    } catch {
      return null;
    }
  }

  async removeApMessage(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apMessages?.remove(filter, opts ?? {}).catch(() => {});
  }

  async findApMessages(query: Record<string, unknown>) {
    return db.apMessages?.find(query) ?? [];
  }

  apMessagesFind(query: Record<string, unknown>) {
    return db.apMessages?.find(query);
  }

  async countApMessages(query: Record<string, unknown>) {
    return db.apMessages?.count(query).catch(() => 0) ?? 0;
  }

  // ── AP likes / announces ──────────────────────────────────

  async insertApLike(doc: Record<string, unknown>) {
    try {
      return await db.apLikes?.insert(doc);
    } catch {
      return null;
    }
  }

  async removeApLike(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apLikes?.remove(filter, opts ?? {}).catch(() => {});
  }

  async findApLikeOne(query: Record<string, unknown>) {
    try {
      return await db.apLikes?.findOne(query);
    } catch {
      return null;
    }
  }

  async insertApAnnounce(doc: Record<string, unknown>) {
    try {
      return await db.apAnnounces?.insert(doc);
    } catch {
      return null;
    }
  }

  async removeApAnnounce(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apAnnounces?.remove(filter, opts ?? {}).catch(() => {});
  }

  // ── AP Delivery Queue (persistent retry) ─────────────────────
  // Koleksiyon: ap_delivery_queue
  // { _id, payload: {inboxUrl,activity,fromUser}, attempts, nextAt, createdAt }

  async insertDeliveryEntry(doc: Record<string, unknown>) {
    try {
      return await db.apDeliveryQueue?.insert(doc);
    } catch {
      return null;
    }
  }

  async upsertDeliveryEntry(id: string, doc: Record<string, unknown>) {
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

  async findPendingDeliveries(beforeTs: number) {
    try {
      return (await db.apDeliveryQueue?.find({ nextAt: { $lte: beforeTs } })) ?? [];
    } catch {
      return [];
    }
  }

  async removeDeliveryEntry(id: string) {
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

export default new FederationRepository();
