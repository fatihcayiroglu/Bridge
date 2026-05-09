// server/routes/federation/index.js
// Federation router — tüm alt modülleri birleştirir
// Eski: server/routes/federation.js (779 satır)
// Yeni: peers.js + activitypub.js + helpers.js
//
// server/app/setupRoutes.js'de değişiklik gerekmez —
// bu dosya eskisiyle aynı API'yi dışa aktarır.

'use strict';

const express = require('express');
const router  = express.Router();

// Peer yönetimi, keşif, CORS proxy
router.use('/', require('./peers'));

// ActivityPub actor, inbox, outbox, followers, webfinger
router.use('/', require('./activitypub'));

// Helpers (deliverToFollowers) — route dışı export
const { deliverToFollowers } = require('./helpers');

module.exports = router;
module.exports.deliverToFollowers = deliverToFollowers;
export {};
