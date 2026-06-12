// server/db/seed.ts — Seed default "Bridge Global" server
import { v4 as uuidv4 } from 'uuid';
import db from './loader';
import logger from '../lib/logger';

async function seed() {
  const exists = await db.servers.findOne({ name: 'Bridge Global' });
  if (exists) return;

  const serverId = uuidv4();
  await db.servers.insert({
    _id: serverId,
    name: 'Bridge Global',
    icon: '🌉',
    ownerId: 'system',
    createdAt: Date.now(),
  });

  const structure = [
    { cat: 'INFORMATION', channels: [
      { name: 'announcements', type: 'text' as const, topic: 'Official announcements 📢' },
      { name: 'rules',         type: 'text' as const, topic: 'Community guidelines' },
    ]},
    { cat: 'GENERAL', channels: [
      { name: 'general',       type: 'text' as const,  topic: 'Open chat for everyone 🌍' },
      { name: 'introductions', type: 'text' as const,  topic: 'Introduce yourself!' },
      { name: 'off-topic',     type: 'text' as const,  topic: 'Anything goes' },
    ]},
    { cat: 'VOICE & VIDEO', channels: [
      { name: 'General Voice', type: 'voice', topic: '' },
      { name: 'Gaming',        type: 'voice', topic: '' },
      { name: 'Study Room',    type: 'voice', topic: '' },
    ]},
    { cat: 'TECH', channels: [
      { name: 'frontend', type: 'text' as const, topic: 'HTML, CSS, JS, React...' },
      { name: 'backend',  type: 'text' as const, topic: 'Node, Python, databases...' },
      { name: 'ai-ml',    type: 'text' as const, topic: 'Artificial intelligence & ML' },
    ]},
  ];

  let order = 0;
  for (const { cat, channels } of structure) {
    for (const ch of channels) {
      await db.channels.insert({
        _id: uuidv4(), serverId,
        name: ch.name, type: ch.type as import('./repositories/types/entities').ChannelType, topic: ch.topic,
        category: cat, order: order++, createdAt: Date.now(),
      });
    }
  }

  const generalCh = await db.channels.findOne({ serverId, name: 'general' });
  if (generalCh) {
    await db.messages.insert({
      _id: uuidv4(), channelId: generalCh._id, serverId,
      userId: 'system', username: 'Bridge', displayName: 'Bridge', avatarColor: '#e8432d',
      content: '🌉 Welcome to **Bridge** — connect with anyone, anywhere. Zero borders, zero lag.',
      type: 'system', createdAt: Date.now(),
    });
  }

  logger.info({ event: 'db.seed.completed', serverName: 'Bridge Global' }, 'Default Bridge Global server seeded.');
}

export default seed;
