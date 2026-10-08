// server/lib/stepUp.ts
//
// P7 B2 — the one owner of step-up verification: "prove it is still you"
// before an action a stolen session could otherwise turn into account
// takeover, lock-out, bulk exfiltration or irreversible community damage.
//
// Threat (docs/P7_TRUST_SOCIAL_FOUNDATION.md § B2, lab scripts/stepup-lab): an
// attacker holding only an access token or refresh cookie, without the
// person's credentials, could add their own recovery e-mail, register a
// passkey, enrol their own authenticator, export the account, or delete a
// server; a stolen moderator session could ban members until the route
// limiter stopped it.
//
// Model
//   · A STEP-UP GRANT is a short-lived signed proof that this account proved a
//     credential recently, for ONE scope (an action group):
//       { sub, v (tokenVersion), level, method, scope, typ: 'stepup', iat, exp }
//     It is signed with a domain-separated key (HMAC of STEP_UP_SECRET, or of
//     JWT_SECRET when no dedicated secret is configured, with a fixed label) and
//     its own audience, so a grant never verifies as an access token and an
//     access token never verifies as a grant. `tokenVersion++` (sign out
//     everywhere, password change/reset, 2FA change) revokes every grant.
//   · LEVEL: 2 for a demonstrated second factor (TOTP, backup code, a sign-in
//     that used one, a passkey assertion), else 1 (password, plain SSO). The
//     level required is the account's own sign-in strength: 2 when the account
//     has 2FA enabled, otherwise 1. Nothing else raises the bar.
//   · Most protected actions need a grant every time; destructive moderation
//     needs one only after a burst (the compromised-moderator signal), so
//     ordinary moderation is never interrupted.
//   · FAILED PROOFS: after `failedProof.max` wrong proofs in the window the
//     account's step-up proofs are refused until the window ends. Sign-in and
//     account recovery never consult this lock, so an attacker cannot use it to
//     keep the owner out; signing in again is always the escape path.
//
// Inputs, all documented and bounded: the grant (age, level, scope, version),
// the account's own credential settings, the actor's own destructive-moderation
// count in a 60 s window, and the account's failed-proof count in a 15 min
// window. No score, no IP, location or device input, no inferred attributes.
//
// Refusal: 403 { error: 'STEP_UP_REQUIRED', action, scope, reasons[], why,
// level, methods[], ttlMs } — never 401, which the client treats as an expired
// session.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { Users } from '../db/repositories';
import { countInWindow } from '../socket/socketRateLimit';
import { cache, isRedisAvailable } from './redisAdapter';
import { envSafeInt } from './envNumbers';
import { parseTokenVersion } from './tokenVersion';
import logger from './logger';

export const STEP_UP_POLICY = Object.freeze({
  /** How long one proof unlocks its scope. */
  ttlMs: envSafeInt('STEP_UP_TTL_MS', 10 * 60_000, { min: 60_000, max: 60 * 60_000 }),
  /** Destructive moderation actions one actor may take per window before a proof is needed (measured, B2 baseline). */
  moderationBurst: Object.freeze({
    max: envSafeInt('STEP_UP_MODERATION_BURST_MAX', 5, { min: 1, max: 10_000 }),
    windowMs: envSafeInt('STEP_UP_MODERATION_BURST_WINDOW_MS', 60_000, { min: 1_000, max: 60 * 60_000 }),
  }),
  /** Wrong step-up proofs per account before step-up proofs are refused for the rest of the window. */
  failedProof: Object.freeze({
    max: envSafeInt('STEP_UP_FAILED_PROOF_MAX', 5, { min: 1, max: 1_000 }),
    windowMs: envSafeInt('STEP_UP_FAILED_PROOF_WINDOW_MS', 15 * 60_000, { min: 60_000, max: 24 * 60 * 60_000 }),
  }),
});

export const STEP_UP_HEADER = 'x-bridge-step-up';
const AUDIENCE = 'bridge-step-up';
const KEY_LABEL = 'bridge-step-up-grant-v1';
const MAX_GRANT_LENGTH = 2048;

export const STEP_UP_SCOPES = ['account-security', 'sensitive-export', 'destructive-admin', 'moderation-burst'] as const;
export type StepUpScope = typeof STEP_UP_SCOPES[number];

/** How the credential was proven. */
export const STEP_UP_METHODS = ['password', 'totp', 'backup_code', 'passkey', 'sso'] as const;
export type StepUpMethod = typeof STEP_UP_METHODS[number];
/** What the person can do now to obtain a grant. `sign_in` is always the last resort. */
export type StepUpOption = 'password' | 'totp' | 'backup_code' | 'sign_in';
export type StepUpLevel = 1 | 2;

type ActionSpec = { scope: StepUpScope; when: 'always' | 'burst'; why: string };

export const STEP_UP_ACTIONS = Object.freeze({
  'email.change': { scope: 'account-security', when: 'always', why: 'Your recovery e-mail controls password reset, so changing it needs a fresh proof.' },
  'passkey.add': { scope: 'account-security', when: 'always', why: 'A new passkey is a permanent way to sign in to your account.' },
  'passkey.remove': { scope: 'account-security', when: 'always', why: 'Removing a passkey can lock you out of your account.' },
  'two_factor.enable': { scope: 'account-security', when: 'always', why: 'Turning on two-factor sign-in with an unknown authenticator would lock you out.' },
  'two_factor.disable': { scope: 'account-security', when: 'always', why: 'Turning off two-factor sign-in removes your second factor.' },
  'backup_codes.regenerate': { scope: 'account-security', when: 'always', why: 'New backup codes can be used instead of your second factor.' },
  'account.export': { scope: 'sensitive-export', when: 'always', why: 'The export contains your whole account history.' },
  'account.delete': { scope: 'destructive-admin', when: 'always', why: 'Deleting your account cannot be undone.' },
  'server.delete': { scope: 'destructive-admin', when: 'always', why: 'Deleting a server cannot be undone for any of its members.' },
  'admin.user.delete': { scope: 'destructive-admin', when: 'always', why: 'Deleting an account on this instance cannot be undone.' },
  'admin.server.delete': { scope: 'destructive-admin', when: 'always', why: 'Deleting a server on this instance cannot be undone.' },
  'moderation.ban': { scope: 'moderation-burst', when: 'burst', why: 'Many bans, kicks or bulk deletions in a short time is what a stolen moderator session does.' },
  'moderation.kick': { scope: 'moderation-burst', when: 'burst', why: 'Many bans, kicks or bulk deletions in a short time is what a stolen moderator session does.' },
  'messages.bulk_delete': { scope: 'moderation-burst', when: 'burst', why: 'Many bans, kicks or bulk deletions in a short time is what a stolen moderator session does.' },
} as const satisfies Record<string, ActionSpec>);

export type StepUpAction = keyof typeof STEP_UP_ACTIONS;

export type StepUpReason =
  | 'step_up_missing' | 'step_up_expired' | 'step_up_invalid' | 'step_up_revoked'
  | 'step_up_other_account' | 'step_up_level' | 'step_up_scope_mismatch'
  | 'moderation_burst' | 'invite_burst' | 'step_up_locked';

export interface StepUpGrantClaims {
  sub: string;
  v: number;
  level: StepUpLevel;
  method: StepUpMethod;
  scope: StepUpScope;
  typ: 'stepup';
  iat: number;
  exp: number;
}

export interface AccountFactors { password: boolean; twoFactor: boolean; tokenVersion: number }

export interface MintedGrant {
  scope: StepUpScope;
  token: string;
  level: StepUpLevel;
  method: StepUpMethod;
  expiresAt: number;
  ttlMs: number;
}

/** Sign-in result: one grant per scope, each valid only for its own scope. */
export interface SignInGrants {
  level: StepUpLevel;
  method: StepUpMethod;
  expiresAt: number;
  ttlMs: number;
  grants: Record<StepUpScope, string>;
}

export function isStepUpScope(value: unknown): value is StepUpScope {
  return typeof value === 'string' && (STEP_UP_SCOPES as readonly string[]).includes(value);
}

function isStepUpMethod(value: unknown): value is StepUpMethod {
  return typeof value === 'string' && (STEP_UP_METHODS as readonly string[]).includes(value);
}

/**
 * Domain-separated signing key. The configured secret is never used directly:
 * even an operator who sets STEP_UP_SECRET equal to JWT_SECRET gets a key that
 * no access, refresh or media token is signed with.
 */
function grantKey(): Buffer {
  const secret = process.env.STEP_UP_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET (or STEP_UP_SECRET) is required for step-up grants');
  return crypto.createHmac('sha256', secret).update(KEY_LABEL).digest();
}

export function methodLevel(method: StepUpMethod): StepUpLevel {
  return method === 'totp' || method === 'backup_code' || method === 'passkey' ? 2 : 1;
}

/** Operator rollback switch: scopes listed in STEP_UP_DISABLED_SCOPES are not enforced. */
export function scopeEnforced(scope: StepUpScope): boolean {
  const raw = process.env.STEP_UP_DISABLED_SCOPES;
  if (!raw) return true;
  return !raw.split(',').map((s) => s.trim()).includes(scope);
}

/** Signs a grant for `scope`. The caller has just verified `method` for `user`. */
export function mintStepUpGrant(
  user: { _id: string; tokenVersion?: unknown },
  method: StepUpMethod,
  scope: StepUpScope,
  now = Date.now(),
): MintedGrant {
  const level = methodLevel(method);
  const iat = Math.floor(now / 1000);
  const ttlSeconds = Math.floor(STEP_UP_POLICY.ttlMs / 1000);
  const token = jwt.sign(
    { sub: String(user._id), v: parseTokenVersion(user.tokenVersion), level, method, scope, typ: 'stepup', iat },
    grantKey(),
    { algorithm: 'HS256', expiresIn: ttlSeconds, audience: AUDIENCE },
  );
  return { scope, token, level, method, expiresAt: (iat + ttlSeconds) * 1000, ttlMs: STEP_UP_POLICY.ttlMs };
}

/** Every sign-in is a fresh credential proof: it yields one grant per scope. */
export function mintSignInGrants(
  user: { _id: string; tokenVersion?: unknown },
  method: StepUpMethod,
  now = Date.now(),
): SignInGrants {
  const minted = STEP_UP_SCOPES.map((scope) => mintStepUpGrant(user, method, scope, now));
  const first = minted[0]!;
  return {
    level: first.level,
    method,
    expiresAt: first.expiresAt,
    ttlMs: first.ttlMs,
    grants: Object.fromEntries(minted.map((g) => [g.scope, g.token])) as Record<StepUpScope, string>,
  };
}

/** Whether the account has a password at all; SSO-only accounts store ''. */
export function hasUsablePassword(hash: unknown): boolean {
  return typeof hash === 'string' && hash.length > 0;
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

export function factorsOf(user: { password?: unknown; twoFactorEnabled?: unknown; tokenVersion?: unknown }): AccountFactors {
  return {
    password: hasUsablePassword(user.password),
    twoFactor: isTruthyFlag(user.twoFactorEnabled),
    tokenVersion: parseTokenVersion(user.tokenVersion),
  };
}

export async function accountFactors(userId: string): Promise<AccountFactors | null> {
  const user = await Users.findById(userId) as { password?: unknown; twoFactorEnabled?: unknown; tokenVersion?: unknown } | null;
  return user ? factorsOf(user) : null;
}

export function requiredLevel(f: AccountFactors): StepUpLevel {
  return f.twoFactor ? 2 : 1;
}

/** What this account can do now to obtain a grant, strongest first. */
export function availableOptions(f: AccountFactors, locked = false): StepUpOption[] {
  if (locked) return ['sign_in'];
  const options: StepUpOption[] = [];
  if (f.twoFactor) options.push('totp', 'backup_code');
  else if (f.password) options.push('password');
  options.push('sign_in');
  return options;
}

export type GrantCheck =
  | { ok: true; claims: StepUpGrantClaims }
  | { ok: false; reason: StepUpReason };

// `decoded` is what jwt.verify returned: an object, or a string payload, which
// has no `typ` and is refused by the first check.
function parseClaims(decoded: string | object): StepUpGrantClaims | null {
  const c = decoded as Record<string, unknown>;
  if (c.typ !== 'stepup') return null;
  if (typeof c.sub !== 'string' || c.sub.length === 0) return null;
  if (!Number.isSafeInteger(c.v) || (c.v as number) < 0) return null;
  if (c.level !== 1 && c.level !== 2) return null;
  if (!isStepUpMethod(c.method) || !isStepUpScope(c.scope)) return null;
  if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp)) return null;
  // A grant's level is a property of how it was proven; a token claiming more is forged or stale.
  if ((c.level as StepUpLevel) > methodLevel(c.method)) return null;
  return c as unknown as StepUpGrantClaims;
}

export function checkStepUpGrant(
  raw: unknown,
  userId: string,
  factors: AccountFactors,
  scope: StepUpScope,
  now = Date.now(),
): GrantCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'step_up_missing' };
  if (raw.length > MAX_GRANT_LENGTH) return { ok: false, reason: 'step_up_invalid' };
  let decoded: string | object;
  try {
    decoded = jwt.verify(raw, grantKey(), {
      algorithms: ['HS256'],
      audience: AUDIENCE,
      clockTimestamp: Math.floor(now / 1000),
    });
  } catch (err) {
    return { ok: false, reason: (err as { name?: string }).name === 'TokenExpiredError' ? 'step_up_expired' : 'step_up_invalid' };
  }
  const claims = parseClaims(decoded);
  if (!claims) return { ok: false, reason: 'step_up_invalid' };
  if (claims.sub !== userId) return { ok: false, reason: 'step_up_other_account' };
  if (claims.v !== factors.tokenVersion) return { ok: false, reason: 'step_up_revoked' };
  if (claims.scope !== scope) return { ok: false, reason: 'step_up_scope_mismatch' };
  if (claims.level < requiredLevel(factors)) return { ok: false, reason: 'step_up_level' };
  return { ok: true, claims };
}

// ── Failed-proof lock ─────────────────────────────────────────────────────────
// One fixed window per account, opened by the first wrong proof: a cluster-wide
// counter (Redis when configured) that expires on its own. Fail-closed: when
// the configured authority is unavailable, step-up proofs are refused rather
// than verified without a guessing bound. Consulted ONLY by the step-up proof
// endpoints — never by sign-in, 2FA sign-in or password reset.

const failKey = (userId: string) => `stepup:fail:${userId}`;

function assertCounterAuthority(): void {
  if (process.env.REDIS_URL && !isRedisAvailable()) {
    throw new Error('Step-up failed-proof authority unavailable');
  }
}

export async function stepUpProofsLocked(userId: string): Promise<boolean> {
  assertCounterAuthority();
  const seen = Number(await cache.get<number>(failKey(userId)) ?? 0);
  return Number.isFinite(seen) && seen >= STEP_UP_POLICY.failedProof.max;
}

/** Records one wrong proof; returns whether the account is now locked. */
export async function recordFailedStepUpProof(userId: string): Promise<boolean> {
  assertCounterAuthority();
  const seen = await cache.increment(failKey(userId), Math.ceil(STEP_UP_POLICY.failedProof.windowMs / 1000));
  if (seen >= STEP_UP_POLICY.failedProof.max) {
    logger.warn({ userId, event: 'step_up.proofs_locked' }, 'Step-up proofs locked after repeated failures');
    return true;
  }
  return false;
}

// ── Decision ──────────────────────────────────────────────────────────────────

function headerGrant(req: Request): string | undefined {
  const value = req.headers[STEP_UP_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

export interface StepUpRefusal {
  error: 'STEP_UP_REQUIRED';
  action: StepUpAction;
  scope: StepUpScope;
  reasons: StepUpReason[];
  why: string;
  level: StepUpLevel;
  methods: StepUpOption[];
  ttlMs: number;
}

export type StepUpDecision =
  | { allowed: true; via: 'grant' | 'not_required' }
  | { allowed: false; status: 401; body: { error: string } }
  | { allowed: false; status: 403; body: StepUpRefusal };

async function refusal(userId: string, action: StepUpAction, factors: AccountFactors, reasons: StepUpReason[]): Promise<StepUpDecision> {
  const spec: ActionSpec = STEP_UP_ACTIONS[action];
  const locked = await stepUpProofsLocked(userId);
  if (locked) reasons.push('step_up_locked');
  logger.info({ userId, action, scope: spec.scope, reasons, event: 'step_up.required' }, 'Step-up verification required');
  return {
    allowed: false,
    status: 403,
    body: {
      error: 'STEP_UP_REQUIRED',
      action,
      scope: spec.scope,
      reasons,
      why: spec.why,
      level: requiredLevel(factors),
      methods: availableOptions(factors, locked),
      ttlMs: STEP_UP_POLICY.ttlMs,
    },
  };
}

/**
 * The decision for `action` by `userId` on this request. Exported for routes
 * whose existing body credential (a password) keeps working beside a grant;
 * everything else uses `requireStepUp`.
 */
export async function evaluateStepUp(req: Request, userId: string, action: StepUpAction, now = Date.now()): Promise<StepUpDecision> {
  const spec: ActionSpec = STEP_UP_ACTIONS[action];
  if (!scopeEnforced(spec.scope)) return { allowed: true, via: 'not_required' };
  const factors = await accountFactors(userId);
  if (!factors) return { allowed: false, status: 401, body: { error: 'User not found' } };

  const check = checkStepUpGrant(headerGrant(req), userId, factors, spec.scope, now);
  if (check.ok) return { allowed: true, via: 'grant' };

  if (spec.when === 'burst') {
    // Counted only when no valid grant is presented: one proof lets a cleanup
    // continue for the grant's lifetime without feeding the counter.
    const { max, windowMs } = STEP_UP_POLICY.moderationBurst;
    const seen = await countInWindow(`stepup:burst:${spec.scope}:${userId}`, windowMs, now);
    if (seen <= max) return { allowed: true, via: 'not_required' };
    return refusal(userId, action, factors, ['moderation_burst', check.reason]);
  }
  return refusal(userId, action, factors, [check.reason]);
}

/**
 * Inline form for handlers that must run their own authorisation first (owner,
 * moderator permission) so only actions the person may perform are asked for a
 * proof or counted toward a burst. Answers the request itself and returns false
 * when the action may not proceed.
 */
export async function enforceStepUp(req: Request, res: Response, userId: string, action: StepUpAction): Promise<boolean> {
  try {
    const decision = await evaluateStepUp(req, userId, action);
    if (decision.allowed) return true;
    res.status(decision.status).json(decision.body);
  } catch (err) {
    // Fail closed: an unavailable counter or account store never waives the proof.
    logger.warn({ err: err instanceof Error ? err.message : String(err), userId, action, event: 'step_up.check_failed' }, 'Step-up check unavailable');
    res.status(503).json({ error: 'STEP_UP_UNAVAILABLE', action });
  }
  return false;
}

/** Express guard: the authenticated user needs a valid grant for `action`'s scope. */
export function requireStepUp(action: StepUpAction) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = String((req as Request & { user?: { id?: unknown } }).user?.id ?? '');
    if (await enforceStepUp(req, res, userId, action)) next();
  };
}
