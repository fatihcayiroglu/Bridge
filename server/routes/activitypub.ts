'use strict';
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Users, Messages } = require('../db/repositories');

const INSTANCE = () => process.env.INSTANCE_URL || 'https://bridge.local';

router.get('/users/:username', async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    '@context': ['https://www.w3.org/ns/activitystreams'],
    type: 'Person', id: `${INSTANCE()}/ap/users/${user.username}`,
    preferredUsername: user.username, name: user.displayName || user.username,
    inbox: `${INSTANCE()}/ap/users/${user.username}/inbox`,
    outbox: `${INSTANCE()}/ap/users/${user.username}/outbox`,
    followers: `${INSTANCE()}/ap/users/${user.username}/followers`,
    following: `${INSTANCE()}/ap/users/${user.username}/following`,
  });
});

router.get('/users/:username/followers', async (req, res) => {
  res.json({ '@context': 'https://www.w3.org/ns/activitystreams', type: 'OrderedCollection', totalItems: 0, orderedItems: [] });
});

router.get('/users/:username/following', async (req, res) => {
  res.json({ '@context': 'https://www.w3.org/ns/activitystreams', type: 'OrderedCollection', totalItems: 0, orderedItems: [] });
});

router.get('/notes/:id', async (req, res) => {
  const msg = await Messages.findById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Note not found' });
  res.json({ '@context': 'https://www.w3.org/ns/activitystreams', type: 'Note', id: `${INSTANCE()}/ap/notes/${msg._id}`, content: msg.content, published: new Date(msg.createdAt).toISOString() });
});

router.get('/.well-known/nodeinfo', (req, res) => {
  res.json({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `${INSTANCE()}/nodeinfo/2.1` }] });
});

router.get('/nodeinfo/2.1', async (req, res) => {
  const userCount = await Users.count({});
  res.json({ version: '2.1', software: { name: 'bridge', version: '60' }, protocols: ['activitypub'], usage: { users: { total: userCount } }, openRegistrations: true });
});

module.exports = router;
export {};
