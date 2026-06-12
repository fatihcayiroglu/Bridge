// Channel bridges (cross-server forwarding)

import db from '../loader';

class BridgeRepository {
  async findOne(query: Record<string, unknown>) {
    return db.channelBridges?.findOne(query);
  }

  async find(query: Record<string, unknown>) {
    return db.channelBridges?.find(query) ?? [];
  }

  async insert(doc: Record<string, unknown>) {
    return db.channelBridges?.insert(doc);
  }

  async update(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.channelBridges?.update(filter, modifier);
  }

  async findActiveFromSourceChannel(channelId: string) {
    return db.channelBridges?.find({ sourceChannelId: channelId, active: true }) ?? [];
  }
}

export default new BridgeRepository();
