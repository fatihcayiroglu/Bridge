// P7 C4: deliberately opt-in write route, restricted to existing mapped
// categories/roles/channels. No identities, grants, hierarchy or messages.
import express from 'express';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
import { authMiddleware } from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { Servers } from '../../db/repositories';
import db from '../../db/loader';
import { enforceStepUp, STEP_UP_HEADER } from '../../lib/stepUp';
import { readDestinationPinnedSourceRegistry } from '../../lib/portableDestinationTrustConfig';
import { applyApprovedPortableCommunityMapping } from '../../lib/portableAtomicMappedApply';
import { validatePortableOwnerMappingRequest } from './portable-approval';

const router = express.Router();

/**
 * @openapi
 * /servers/{sid}/portable-import/mapped-apply:
 *   post:
 *     tags: [Servers]
 *     summary: Apply approved portable metadata to existing mapped target rows only
 *     description: Disabled by default. Consumes one short-lived approval token, re-verifies the signed source and destination owner under SERIALIZABLE, and atomically updates existing mapped metadata. Never imports membership or permission grants.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [structure, permissions, attestation, expectedSourceOrigin, expectedSourceServerId, targetServerId, mapping, confirmedReviewFingerprint, confirmation, approvalToken]
 *             properties:
 *               structure: { type: object }
 *               permissions: { type: object }
 *               attestation: { type: object }
 *               expectedSourceOrigin: { type: string, format: uri }
 *               expectedSourceServerId: { type: string }
 *               targetServerId: { type: string }
 *               mapping: { type: object }
 *               confirmedReviewFingerprint: { type: string, minLength: 64, maxLength: 64 }
 *               confirmation: { type: string, enum: [APPLY_MAPPED_PORTABLE_METADATA_ONLY] }
 *               approvalToken: { type: string, minLength: 43, maxLength: 43 }
 *     responses:
 *       200:
 *         description: Existing mapped category/role/channel metadata committed atomically
 *       400:
 *         description: Invalid explicit mapping or token shape
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Destination owner and fresh step-up required
 *       404:
 *         description: Destination not found
 *       422:
 *         description: Signature, permissions, approval or atomic commit rejected
 *       503:
 *         description: Import opt-in not enabled or trusted database unavailable
 */
router.post('/:sid/portable-import/mapped-apply',
  authMiddleware, limits.write(), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const actor = castAuthed(req).user;
    const sid = String(req.params.sid ?? '');
    const target = await Servers.findById(sid);
    if (!target) return res.status(404).json({ code: 'PORTABLE_TARGET_NOT_FOUND' });
    if (target.ownerId !== actor.id) {
      return res.status(403).json({ code: 'PORTABLE_OWNER_REQUIRED' });
    }
    if (!(await enforceStepUp(req, res, actor.id, 'account.import'))) return;

    // Double independent operator switches. Neither is request-controlled.
    if (process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED !== 'true' ||
        process.env.BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED !== 'true') {
      return res.status(503).json({ code: 'PORTABLE_MAPPED_APPLY_DISABLED' });
    }
    const pool = db._pool;
    if (!pool) return res.status(503).json({ code: 'PORTABLE_MAPPED_APPLY_DB_UNAVAILABLE' });
    if (!validatePortableOwnerMappingRequest(req.body as unknown, sid, 'apply')) {
      return res.status(400).json({ code: 'PORTABLE_MAPPED_APPLY_INVALID' });
    }
    const body = req.body as Record<string, unknown>;
    const grant = req.header(STEP_UP_HEADER);
    if (!grant || grant.length > 2048) {
      return res.status(403).json({ code: 'PORTABLE_MAPPED_APPLY_STEPUP_REQUIRED' });
    }
    let registry: string;
    try { registry = readDestinationPinnedSourceRegistry(); }
    catch { return res.status(503).json({ code: 'PORTABLE_SOURCE_TRUST_UNAVAILABLE' }); }

    try {
      const result = await applyApprovedPortableCommunityMapping({
        pool, ownerId: actor.id, targetServerId: sid, stepUpGrant: grant,
        approvalToken: body.approvalToken as string,
        confirmedReviewFingerprint: body.confirmedReviewFingerprint as string,
        structure: body.structure, permissions: body.permissions,
        attestation: body.attestation,
        expectedSourceOrigin: body.expectedSourceOrigin as string,
        expectedSourceServerId: body.expectedSourceServerId as string,
        operatorRegistryJson: registry,
        mapping: body.mapping as { categories: unknown; roles: unknown; channels: unknown },
      });
      // The library never returns approvalToken; do not echo bearer material.
      return res.status(200).json({
        mode: 'existing-mapped-metadata-only',
        applied: result.applied, transactionCommitted: result.transactionCommitted,
        changed: result.changed,
        grantsPreserved: result.grantsPreserved,
        identitiesPreserved: result.identitiesPreserved,
        membershipImported: false, permissionGrantsImported: false,
      });
    } catch {
      // Do not expose token existence, source keyring, ownership concurrency
      // or failed COMMIT status as a probing oracle.
      return res.status(422).json({ code: 'PORTABLE_MAPPED_APPLY_UNAVAILABLE' });
    }
  },
);

export default router;
