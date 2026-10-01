// server/routes/admin/federation-keys.ts
// ADR-0006 Faz 2: Instance federation RSA key rotasyonu (admin)

import express from 'express';
import logger from '../../lib/logger';
import { authMiddleware } from '../../middleware/auth';
import { adminOnly, logAction } from './middleware';
import { rotateFederationKeys, getFederationPublicKeyDoc, getOrCreateFederationKeys } from '../../lib/federationKeys';
import { announceKeyRotation } from '../../lib/federationPeerAnnounce';

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
  // P5 FED-03: keep the outgoing key — it signs the announcement to peers.
  const previous = await getOrCreateFederationKeys();
  const result  = await rotateFederationKeys();
  const doc     = getFederationPublicKeyDoc();
  // The rotation result always carries the new key; announcing never depends
  // on the cached document. A failed announcement never fails the rotation.
  const announced = await announceKeyRotation(previous.privateKeyPem, { id: result.keyId, publicKeyPem: result.publicKeyPem })
    .catch((err: Error) => {
      logger.warn({ event: 'federation.key_rotation.announce_error', err: err.message }, '[Federation] Key rotation announcement failed.');
      return [];
    });

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
    announced:  announced.map((a) => ({ url: a.url, ok: a.ok, status: a.status ?? null })),
  });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
