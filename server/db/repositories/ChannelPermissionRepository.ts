// Kanal izin matrisi (rol bazlı channel_permissions)

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class ChannelPermissionRepository {
  async findByChannel(channelId: string) {
    return db.channelPermissions?.find({ channelId }) ?? [];
  }

  async findOne(query: Record<string, unknown>) {
    return db.channelPermissions?.findOne(query);
  }

  async find(query: Record<string, unknown>) {
    return db.channelPermissions?.find(query) ?? [];
  }

  async remove(query: Record<string, unknown>) {
    return db.channelPermissions?.remove(query);
  }

  async removeByChannel(channelId: string) {
    return db.channelPermissions?.remove({ channelId });
  }

  async insert(doc: Record<string, unknown>) {
    if (doc._id) return db.channelPermissions?.insert(doc);
    return db.channelPermissions?.insert({ _id: uuidv4(), ...doc });
  }

  async update(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.channelPermissions?.update(filter, modifier);
  }
}

export default new ChannelPermissionRepository();
