// server/routes/servers/index.ts — Assembles server sub-routes
// Replaces the monolithic servers.ts (526 lines → 4 focused modules)
import express from 'express';
import coreRouter    from './core';
import invitesRouter from './invites';
import channelsRouter from './channels';
import ogImageRouter  from './og-image';

const router = express.Router();

// Server CRUD + member operations
router.use('/', coreRouter);

// Invite operations
router.use('/invites', invitesRouter);

// Channel operations (nested under :sid)
router.use('/:sid/channels', channelsRouter);

// Open Graph image
router.use('/:sid/og-image', ogImageRouter);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
