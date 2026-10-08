// server/routes/stepUp.ts
//
// P7 B2 — the password step-up proof (level 1). The TOTP / backup-code proof
// (level 2) lives beside its existing verifier in routes/twoFactor.ts
// (`POST /api/2fa/step-up`); sign-in responses carry grants of their own. The
// policy, signing and the failed-proof lock are owned by lib/stepUp.ts.
//
// Protections are the ordinary ones for a credential check: authenticated
// session, the global CSRF middleware, the existing `limits.twoFactor()`
// limiter, plus the per-account failed-proof lock (which sign-in and password
// reset never consult).

import express from 'express';
import bcrypt from 'bcryptjs';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { Users } from '../db/repositories';
import { authMiddleware } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import {
  STEP_UP_POLICY,
  availableOptions,
  factorsOf,
  isStepUpScope,
  mintStepUpGrant,
  recordFailedStepUpProof,
  stepUpProofsLocked,
} from '../lib/stepUp';
import logger from '../lib/logger';

const router = express.Router();

/**
 * @openapi
 * /step-up/password:
 *   post:
 *     tags: [Auth]
 *     summary: Step-up proof with the account password (level 1) for one action scope
 *     description: >
 *       Returns a short-lived step-up grant valid only for `scope`. The client keeps it in
 *       memory and sends it in the `X-Bridge-Step-Up` header. Accounts with two-factor
 *       sign-in must use `POST /2fa/step-up` instead.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password, scope]
 *             properties:
 *               password: { type: string, format: password }
 *               scope: { type: string, enum: [account-security, sensitive-export, destructive-admin, moderation-burst] }
 *     responses:
 *       200: { description: 'Step-up grant for the scope (keep in memory only)' }
 *       400: { description: 'Wrong password, missing scope, or a second factor is required' }
 *       404: { description: User not found }
 *       429: { description: 'Too many failed step-up proofs; sign in again or wait' }
 *       503: { description: 'Failed-proof counter unavailable' }
 */
router.post('/password', authMiddleware, limits.twoFactor(), async (req, res) => {
  const { id } = castAuthed(req).user;
  const { password, scope } = (req.body ?? {}) as Record<string, unknown>;
  if (!isStepUpScope(scope)) return res.status(400).json({ error: 'scope required' });
  if (typeof password !== 'string' || password.length < 1 || password.length > 128)
    return res.status(400).json({ error: 'password required' });

  const user = await Users.findById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const factors = factorsOf(user);
  // A password is level 1; it never satisfies an account that signs in with a second factor.
  if (factors.twoFactor) return res.status(400).json({ error: 'STEP_UP_SECOND_FACTOR_REQUIRED', methods: availableOptions(factors) });
  if (!factors.password) return res.status(400).json({ error: 'STEP_UP_NO_PASSWORD', methods: availableOptions(factors) });

  try {
    if (await stepUpProofsLocked(id)) {
      return res.status(429).json({ error: 'STEP_UP_LOCKED', retryAfterMs: STEP_UP_POLICY.failedProof.windowMs, methods: ['sign_in'] });
    }
    if (!(await bcrypt.compare(password, String(user.password)))) {
      const locked = await recordFailedStepUpProof(id);
      return res.status(400).json({ error: 'STEP_UP_PROOF_INVALID', locked });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), userId: id, event: 'step_up.proof_unavailable' }, 'Step-up proof could not be checked');
    return res.status(503).json({ error: 'STEP_UP_UNAVAILABLE' });
  }

  const grant = mintStepUpGrant(user, 'password', scope);
  logger.info({ userId: id, scope, method: 'password', event: 'step_up.granted' }, 'Step-up proof accepted');
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, stepUp: grant });
});

export default router;
