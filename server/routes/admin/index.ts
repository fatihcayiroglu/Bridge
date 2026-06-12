// server/routes/admin/index.ts
// Admin router — tüm alt modülleri birleştirir

import express from 'express';
import { router as coreRouter, logAction } from './core';
import { router as fedAclRouter, checkFederationACL } from './federation-acl';
import { router as sfuRouter } from './sfu';
import ipBanRouter from './ipban';
import federationKeysRouter from './federation-keys';

const router = express.Router();

router.use('/', coreRouter);
router.use('/', fedAclRouter);
router.use('/', federationKeysRouter);
router.use('/', sfuRouter);
router.use('/', ipBanRouter);

export default router;
export { checkFederationACL };
