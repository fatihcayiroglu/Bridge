// server/routes/federation/index.ts
// Federation router — tüm alt modülleri birleştirir

import express from 'express';
import peersRouter from './peers';
import lifecycleRouter from './lifecycle';
import activitypubRouter from './activitypub';
import socialRouter from './social';

const router = express.Router();

router.use('/', peersRouter);
// P6: lifecycle routes must precede the historical Create-only note reader so
// GET/PATCH/DELETE observe the latest durable ActivityPub lifecycle state.
router.use('/', lifecycleRouter);
router.use('/', activitypubRouter);
router.use('/', socialRouter);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;