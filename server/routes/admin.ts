// server/routes/admin.ts
// Bu dosya geriye dönük uyumluluk için korunmaktadır.
// Gerçek implementasyon: server/routes/admin/ (core.ts + federation-acl.ts + sfu.ts)
//
// require('../routes/admin')                    → router
// require('../routes/admin').checkFederationACL → ACL fonksiyonu
'use strict';

module.exports = require('./admin/index');
export {};
