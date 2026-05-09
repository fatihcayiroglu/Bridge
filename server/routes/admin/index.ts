// server/routes/admin/index.js
// Admin router — tüm alt modülleri birleştirir
// Eski: server/routes/admin.js (513 satır, tek dosya)
// Yeni: core.js + federation-acl.js + sfu.js
//
// Mevcut import'lar değişmez:
//   require('../routes/admin')                   → router
//   require('../routes/admin').checkFederationACL → ACL fonksiyonu

'use strict';

const express = require('express');
const router  = express.Router();

// Temel admin işlevleri
const { router: coreRouter } = require('./core');
router.use('/', coreRouter);

// Federation whitelist / blacklist
const { router: fedAclRouter, checkFederationACL } = require('./federation-acl');
router.use('/', fedAclRouter);

// SFU cluster istatistikleri
router.use('/', require('./sfu'));

module.exports = router;
module.exports.checkFederationACL = checkFederationACL;
export {};
