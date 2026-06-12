// server/routes/admin/federation-keys.ts
// ADR-0006 Faz 2: Instance federation RSA key rotasyonu (admin)

import express, { Response } from 'express';
import { authMiddleware, type AuthedRequest} from '../../middleware/auth';
import { adminOnly, logAction } from './middleware';
import { rotateFederationKeys, getFederationPublicKeyDoc } from '../../lib/federationKeys';

import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router();

/**
 * @openapi
 * /admin/federation/rotate-key:
 *   post:
 *     tags: [Admin]
 *     summary: Federation RSA key çiftini rotate et
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Yeni key bilgisi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/federation/rotate-key', authMiddleware, adminOnly, async (req, res) => {
  const adminId = castAuthed(req).user.id;
  const result  = await rotateFederationKeys();
  const doc     = getFederationPublicKeyDoc();

  await logAction(adminId, 'federation_rotate_key', null, {
    keyVersion: result.keyVersion,
    keyId:      result.keyId,
  });

  res.json({
    ok:         true,
    keyId:      result.keyId,
    keyVersion: result.keyVersion,
    rotatedAt:  result.rotatedAt,
    publicKey:  doc,
  });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
