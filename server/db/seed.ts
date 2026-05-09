// server/db/seed.js — Seed default "Bridge Global" server
const { v4: uuidv4 } = require('uuid');
const db = require('./loader');
const logger = require('../lib/logger');

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
      { name: 'announcements', type: 'text', topic: 'Official announcements 📢' },
      { name: 'rules',         type: 'text', topic: 'Community guidelines' },
    ]},
    { cat: 'GENERAL', channels: [
      { name: 'general',       type: 'text',  topic: 'Open chat for everyone 🌍' },
      { name: 'introductions', type: 'text',  topic: 'Introduce yourself!' },
      { name: 'off-topic',     type: 'text',  topic: 'Anything goes' },
    ]},
    { cat: 'VOICE & VIDEO', channels: [
      { name: 'General Voice', type: 'voice', topic: '' },
      { name: 'Gaming',        type: 'voice', topic: '' },
      { name: 'Study Room',    type: 'voice', topic: '' },
    ]},
    { cat: 'TECH', channels: [
      { name: 'frontend', type: 'text', topic: 'HTML, CSS, JS, React...' },
      { name: 'backend',  type: 'text', topic: 'Node, Python, databases...' },
      { name: 'ai-ml',    type: 'text', topic: 'Artificial intelligence & ML' },
    ]},
  ];

  let order = 0;
  for (const { cat, channels } of structure) {
    for (const ch of channels) {
      await db.channels.insert({
        _id: uuidv4(), serverId,
        name: ch.name, type: ch.type, topic: ch.topic,
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

module.exports = seed;
export {};
