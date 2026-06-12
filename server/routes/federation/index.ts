// server/routes/federation/index.ts
// Federation router — tüm alt modülleri birleştirir

import express from 'express';
import peersRouter from './peers';
import activitypubRouter from './activitypub';
import socialRouter from './social';

const router = express.Router();

router.use('/', peersRouter);
router.use('/', activitypubRouter);
router.use('/', socialRouter);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
