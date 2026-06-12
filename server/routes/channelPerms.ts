// server/routes/channelPerms.ts
// Kanal bazlı granüler rol izin matrisi

import express from 'express';
import bulkRouter from './channelPerms/bulk';
import overridesRouter from './channelPerms/overrides';

const router = express.Router({ mergeParams: true });

// bulk önce: '/batch', '/export', '/import' sabit path'leri '/:roleId' wildcard'dan önce eşleşmeli
router.use('/', bulkRouter);
router.use('/', overridesRouter);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
