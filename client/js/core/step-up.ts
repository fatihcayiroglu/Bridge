// client/js/core/step-up.ts
//
// P7 B2 — the ONE client owner of step-up proofs ("prove it is still you").
// The server refuses a protected action with
//   403 { error: 'STEP_UP_REQUIRED', action, scope, reasons[], why, level, methods[], ttlMs }
// (never 401, which would mean "session expired"). `apiFetch` hands every such
// refusal to this module, which:
//   · re-sends silently with a grant it already holds for that scope (e.g. the
//     grants every sign-in returns), or
//   · asks for ONE proof through the existing product dialog — the password,
//     or an authenticator / backup code when the account has 2FA — and
//     concurrent refusals for the same scope share that one prompt, or
//   · explains that signing in again is needed (SSO-only accounts, too many
//     failed proofs).
// Cancel returns the original 403 to the caller unchanged.
//
// Grants live in MEMORY ONLY (P7 rule D): never localStorage/sessionStorage/
// IndexedDB. They are bound to the account and tokenVersion on the server, are
// valid for one scope each, expire after ttlMs (10 min), and are dropped on
// sign-out and on every new sign-in.

import { t } from './i18n/index.ts';
import { confirmProductAction, promptProductText } from './product-dialog.ts';
import { createLogger } from './logger.ts';

const log = createLogger('StepUp');

export const STEP_UP_HEADER = 'X-Bridge-Step-Up';
export const STEP_UP_SCOPES = ['account-security', 'sensitive-export', 'destructive-admin', 'moderation-burst'] as const;
export type StepUpScope = typeof STEP_UP_SCOPES[number];

export interface StepUpRefusal {
  error: 'STEP_UP_REQUIRED';
  action: string;
  scope: StepUpScope;
  reasons: string[];
  why?: string;
  level: number;
  methods: string[];
  ttlMs?: number;
}

/** Sends one proof request (a POST through apiFetch, so CSRF and refresh still apply). */
export type ProofSender = (path: string, body: Record<string, unknown>) => Promise<Response>;

export interface StepUpHooks {
  send: ProofSender;
  /** Leaves the session so the person can sign in again (the escape path that always exists). */
  signInAgain: () => void;
}

/** A grant is not used in its last few seconds: the request could arrive after it expires. */
const EXPIRY_MARGIN_MS = 5_000;

const grants = new Map<StepUpScope, { token: string; expiresAt: number }>();
const pending = new Map<StepUpScope, Promise<string | null>>();

export function isStepUpScope(value: unknown): value is StepUpScope {
  return typeof value === 'string' && (STEP_UP_SCOPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clearStepUpGrants(): void {
  grants.clear();
}

export function rememberGrant(scope: StepUpScope, token: string, expiresAt: number): void {
  if (!token || !Number.isFinite(expiresAt)) return;
  grants.set(scope, { token, expiresAt });
}

/** The grant held for `scope`, or null when there is none or it is about to expire. */
export function grantFor(scope: StepUpScope, now = Date.now()): string | null {
  const held = grants.get(scope);
  if (!held) return null;
  if (held.expiresAt - EXPIRY_MARGIN_MS <= now) {
    grants.delete(scope);
    return null;
  }
  return held.token;
}

/**
 * The `stepUp` field of a sign-in response: `{ expiresAt, grants: { scope: token } }`.
 * A new sign-in replaces whatever an earlier session held.
 */
export function rememberSignInGrants(stepUp: unknown): void {
  clearStepUpGrants();
  if (!isRecord(stepUp) || !isRecord(stepUp.grants)) return;
  const expiresAt = Number(stepUp.expiresAt);
  for (const [scope, token] of Object.entries(stepUp.grants)) {
    if (isStepUpScope(scope) && typeof token === 'string') rememberGrant(scope, token, expiresAt);
  }
}

// ── Which requests carry which grant up front ────────────────────────────────
// A mirror of the server catalog (server/lib/stepUp.ts), used ONLY to attach a
// grant the client already holds so a protected action does not need a refused
// round trip first. The server's refusal stays authoritative: a route missing
// here still works through the refusal path.
const PREFIX = '^/api(?:/v1)?';
const protectedRoute = (method: string, tail: string, scope: StepUpScope) =>
  ({ method, path: new RegExp(`${PREFIX}${tail}$`), scope });

const PROTECTED: ReadonlyArray<{ method: string; path: RegExp; scope: StepUpScope }> = [
  protectedRoute('POST', '/email/add', 'account-security'),
  protectedRoute('POST', '/webauthn/register/(?:begin|complete)', 'account-security'),
  protectedRoute('DELETE', '/webauthn/credentials/[^/]+', 'account-security'),
  protectedRoute('POST', '/2fa/(?:setup|verify|disable|backup-codes/regenerate)', 'account-security'),
  protectedRoute('GET', '/account/export', 'sensitive-export'),
  protectedRoute('DELETE', '/account/?', 'destructive-admin'),
  protectedRoute('DELETE', '/servers/[^/]+', 'destructive-admin'),
  protectedRoute('DELETE', '/admin/(?:users|servers)/[^/]+', 'destructive-admin'),
  protectedRoute('POST', '/servers/[^/]+/bans', 'moderation-burst'),
  protectedRoute('POST', '/servers/[^/]+/members/[^/]+/kick', 'moderation-burst'),
  protectedRoute('DELETE', '/channels/bulk', 'moderation-burst'),
];

export function scopeForRequest(method: string, url: string): StepUpScope | null {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://bridge.invalid').pathname;
  } catch {
    return null;
  }
  const verb = method.toUpperCase();
  return PROTECTED.find(route => route.method === verb && route.path.test(pathname))?.scope ?? null;
}

/** The refusal carried by `response`, or null. The body is read from a clone. */
export async function readStepUpRefusal(response: Response): Promise<StepUpRefusal | null> {
  if (response.status !== 403) return null;
  try {
    const body: unknown = await response.clone().json();
    if (!isRecord(body) || body.error !== 'STEP_UP_REQUIRED' || !isStepUpScope(body.scope)) return null;
    return {
      error: 'STEP_UP_REQUIRED',
      action: typeof body.action === 'string' ? body.action : '',
      scope: body.scope,
      reasons: Array.isArray(body.reasons) ? body.reasons.filter((r): r is string => typeof r === 'string') : [],
      why: typeof body.why === 'string' ? body.why : undefined,
      level: Number(body.level) === 2 ? 2 : 1,
      methods: Array.isArray(body.methods) ? body.methods.filter((m): m is string => typeof m === 'string') : [],
      ttlMs: Number.isFinite(Number(body.ttlMs)) ? Number(body.ttlMs) : undefined,
    };
  } catch {
    return null;
  }
}

function explanation(refusal: StepUpRefusal): string {
  return refusal.why || t('stepup_generic_why');
}

async function offerSignInAgain(refusal: StepUpRefusal, hooks: StepUpHooks, locked: boolean): Promise<null> {
  const confirmed = await confirmProductAction({
    title: t('stepup_title'),
    message: `${explanation(refusal)}\n\n${locked ? t('stepup_locked') : t('stepup_sign_in_again_body')}`,
    confirmLabel: t('stepup_sign_in_again'),
  });
  if (confirmed) hooks.signInAgain();
  return null;
}

async function proofBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

async function askForProof(refusal: StepUpRefusal, hooks: StepUpHooks): Promise<string | null> {
  if (refusal.reasons.includes('step_up_locked')) return offerSignInAgain(refusal, hooks, true);
  let secondFactor = refusal.methods.includes('totp') || refusal.methods.includes('backup_code');
  if (!secondFactor && !refusal.methods.includes('password')) return offerSignInAgain(refusal, hooks, false);

  let problem = '';
  for (;;) {
    const value = await promptProductText({
      title: t('stepup_title'),
      message: problem ? `${explanation(refusal)}\n\n${problem}` : explanation(refusal),
      confirmLabel: t('stepup_confirm'),
      placeholder: secondFactor ? t('stepup_code_label') : t('stepup_password_label'),
      inputType: secondFactor ? 'one-time-code' : 'password',
      maxLength: 128,
    });
    if (value === null) return null;
    if (!value.trim()) { problem = t('stepup_empty'); continue; }

    let response: Response;
    try {
      response = secondFactor
        ? await hooks.send('/api/2fa/step-up', { code: value, scope: refusal.scope })
        : await hooks.send('/api/step-up/password', { password: value, scope: refusal.scope });
    } catch (error) {
      log.warn('Step-up proof request failed', error);
      problem = t('stepup_unavailable');
      continue;
    }
    const body = await proofBody(response);

    if (response.ok && isRecord(body.stepUp) && typeof body.stepUp.token === 'string') {
      rememberGrant(refusal.scope, body.stepUp.token, Number(body.stepUp.expiresAt));
      return body.stepUp.token;
    }
    if (response.status === 429 || body.locked === true) return offerSignInAgain(refusal, hooks, true);
    if (body.error === 'STEP_UP_PROOF_INVALID') { problem = t('stepup_wrong'); continue; }
    if (body.error === 'STEP_UP_SECOND_FACTOR_REQUIRED' && !secondFactor) {
      // 2FA was turned on since the refusal was issued: ask for the stronger proof.
      secondFactor = true;
      problem = '';
      continue;
    }
    if (body.error === 'STEP_UP_NO_PASSWORD') return offerSignInAgain(refusal, hooks, false);
    log.warn(`Step-up proof failed (HTTP ${response.status})`);
    problem = t('stepup_unavailable');
  }
}

/**
 * A grant for the refused action's scope, or null when the person cancelled
 * (or must sign in again). `sent` is the grant the refused request carried, if
 * any: a held grant different from it is used silently; the same one is stale.
 */
export function obtainStepUp(refusal: StepUpRefusal, sent: string | null, hooks: StepUpHooks): Promise<string | null> {
  const held = grantFor(refusal.scope);
  if (held && held !== sent) return Promise.resolve(held);
  if (held) grants.delete(refusal.scope);

  const inFlight = pending.get(refusal.scope);
  if (inFlight) return inFlight;
  const asked = askForProof(refusal, hooks).finally(() => { pending.delete(refusal.scope); });
  pending.set(refusal.scope, asked);
  return asked;
}

// A grant belongs to one signed-in account: it never outlives the session.
if (typeof document !== 'undefined') {
  document.addEventListener('bridge:auth-logout', () => { clearStepUpGrants(); });
}
