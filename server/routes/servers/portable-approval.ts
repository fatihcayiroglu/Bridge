// P7 C4: owner-only, explicit signed mapping approval staging.
// Feature-flagged OFF by default. NO import/apply route is enabled.
// Never accept owner, signing keyring, DB pool or transaction state from HTTP.
import express from 'express';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
import { authMiddleware } from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { Servers } from '../../db/repositories';
import db from '../../db/loader';
import { enforceStepUp, STEP_UP_HEADER } from '../../lib/stepUp';
import { readDestinationPinnedSourceRegistry } from '../../lib/portableDestinationTrustConfig';
import { isCanonicalPortableSourceOrigin } from '../../lib/portableSourceAttestation';
import { stageOwnerConfirmedPortableApproval } from '../../lib/portableTransactionalApprovalStage';

const router = express.Router();
const EXACT_KEYS = [
  'structure', 'permissions', 'attestation', 'expectedSourceOrigin',
  'expectedSourceServerId', 'targetServerId', 'mapping',
  'confirmedReviewFingerprint', 'confirmation',
];
const CONFIRM = 'CONFIRM_SIGNED_MAPPING_AND_PERMISSION_CONSEQUENCES';
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 1152 * 1024;
function validObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validate(value: unknown, sid: string): value is Record<string, unknown> {
  if (!validObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== EXACT_KEYS.length || keys.some(x => !EXACT_KEYS.includes(x))) return false;
  if (value.targetServerId !== sid ||
      value.confirmation !== CONFIRM ||
      typeof value.confirmedReviewFingerprint !== 'string' ||
      !HEX64.test(value.confirmedReviewFingerprint) ||
      !isCanonicalPortableSourceOrigin(value.expectedSourceOrigin) ||
      typeof value.expectedSourceServerId !== 'string' ||
      !value.expectedSourceServerId.trim() ||
      value.expectedSourceServerId.trim() !== value.expectedSourceServerId ||
      value.expectedSourceServerId.length > 256 ||
      !validObject(value.structure) ||
      !validObject(value.permissions) ||
      !validObject(value.attestation) ||
      !validObject(value.mapping)) return false;
  const mapping = value.mapping;
  const mkeys = Object.keys(mapping);
  const mapFields = [
    'targetServerId', 'structureDigest', 'permissionsDigest',
    'expectedTargetDigest', 'categories', 'roles', 'channels',
  ];
  if (mkeys.length !== mapFields.length ||
      !mapFields.every(x => mkeys.includes(x)) ||
      mapping.targetServerId !== sid ||
      !['structureDigest', 'permissionsDigest', 'expectedTargetDigest'].every(x =>
        typeof mapping[x] === 'string' && HEX64.test(mapping[x] as string))) return false;
  for (const field of ['categories', 'roles', 'channels']) {
    const links: unknown = mapping[field];
    if (!Array.isArray(links) || links.length > 2000 ||
        links.some(link => !validObject(link) ||
          Object.keys(link).length !== 2 ||
          typeof link.sourceId !== 'string' || !link.sourceId ||
          typeof link.targetId !== 'string' || !link.targetId)) return false;
  }
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_BODY_BYTES;
  } catch { return false; }
}

/**
 * @openapi
 * /servers/{sid}/portable-import/owner-approval:
 *   post:
 *     tags: [Servers]
 *     summary: Stage an owner-confirmed signed mapping token without importing data
 *     description: Disabled by default. Requires the authenticated destination owner, a fresh import step-up proof, and operator-pinned signed source review.
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
 *             required: [structure, permissions, attestation, expectedSourceOrigin, expectedSourceServerId, targetServerId, mapping, confirmedReviewFingerprint, confirmation]
 *             properties:
 *               structure: { type: object }
 *               permissions: { type: object }
 *               attestation: { type: object }
 *               expectedSourceOrigin: { type: string, format: uri }
 *               expectedSourceServerId: { type: string }
 *               targetServerId: { type: string }
 *               mapping: { type: object }
 *               confirmedReviewFingerprint: { type: string, minLength: 64, maxLength: 64 }
 *               confirmation: { type: string, enum: [CONFIRM_SIGNED_MAPPING_AND_PERMISSION_CONSEQUENCES] }
 *     responses:
 *       201:
 *         description: Short-lived hashed one-use record created; no community data imported
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Owner authentication or step-up required
 *       404:
 *         description: Destination not found
 *       422:
 *         description: Verification failed
 *       503:
 *         description: Approval disabled or trust or database unavailable
 */
// This endpoint only stages an approval record (short-lived, one-use).
// A committed token is not a data-migration authorization unless and until
// an independently reviewed atomic importer is enabled in a future release.
router.post('/:sid/portable-import/owner-approval',
  authMiddleware, limits.write(), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const actor = castAuthed(req).user;
    const sid = String(req.params.sid ?? '');
    const destination = await Servers.findById(sid);
    if (!destination) return res.status(404).json({ error: 'Target community not found' });
    if (destination.ownerId !== actor.id) {
      return res.status(403).json({ error: 'Only destination owner can approve signed mappings' });
    }
    // Both the HTTP precheck and the transaction-local guard are needed.
    // The latter *never* honors the global step-up disable switch.
    if (!(await enforceStepUp(req, res, actor.id, 'account.import'))) return;
    if (process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED !== 'true') {
      return res.status(503).json({ code: 'PORTABLE_OWNER_APPROVAL_DISABLED' });
    }
    const pool = db._pool;
    if (!pool) return res.status(503).json({ code: 'PORTABLE_OWNER_APPROVAL_DB_UNAVAILABLE' });
    if (!validate(req.body as unknown, sid)) {
      return res.status(400).json({ code: 'PORTABLE_OWNER_APPROVAL_INVALID' });
    }
    const input = req.body as Record<string, unknown>;
    const grant = req.header(STEP_UP_HEADER);
    if (!grant || grant.length > 2048) {
      return res.status(403).json({ code: 'PORTABLE_OWNER_APPROVAL_STEPUP_REQUIRED' });
    }

    let registry: string;
    try { registry = readDestinationPinnedSourceRegistry(); }
    catch {
      return res.status(503).json({ code: 'PORTABLE_SOURCE_TRUST_UNAVAILABLE' });
    }
    try {
      const result = await stageOwnerConfirmedPortableApproval({
        pool, targetServerId: sid, ownerId: actor.id, stepUpGrant: grant,
        confirmedReviewFingerprint: input.confirmedReviewFingerprint,
        structure: input.structure, permissions: input.permissions,
        attestation: input.attestation,
        expectedSourceOrigin: input.expectedSourceOrigin as string,
        expectedSourceServerId: input.expectedSourceServerId as string,
        mapping: input.mapping as { categories: unknown; roles: unknown; channels: unknown },
        operatorRegistryJson: registry,
      });
      // Never cache, log or repeat the bearer approvalToken.
      return res.status(201).json(result);
    } catch {
      // Uniform error: no registry, signature, step-up, owner-row, topology
      // or grant-parity oracle, and never reveal an uncommitted token.
      return res.status(422).json({ code: 'PORTABLE_OWNER_APPROVAL_UNAVAILABLE' });
    }
  },
);

export default router;
