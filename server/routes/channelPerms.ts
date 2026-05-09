// server/routes/channelPerms.js.1
// Kanal bazlı granüler rol izin matrisi — refactor: kod 3 alt modüle bölündü
//
//   channelPerms/helpers.js  — rate limiter'lar, audit, log mesajı, socket
//   channelPerms/overrides.js — GET/PUT/DELETE tek kanal override + audit-log + kalıtım
//   channelPerms/bulk.js     — bulk-sync, bulk-sync/preview, batch PUT, export, import
//
// Bu dosya Express router'ları birleştiren ince bir wrapper'dır.
// Tüm iş mantığı alt modüllerdedir; buraya yeni route ekleme.

'use strict';

const express  = require('express');
const router   = express.Router({ mergeParams: true });

// bulk.js önce mount edilmeli: '/batch', '/export', '/import' gibi sabit path'ler
// '/:roleId' wildcard route'undan önce eşleşmelidir.
router.use('/', require('./channelPerms/bulk'));
router.use('/', require('./channelPerms/overrides'));

module.exports = router;
export {};
