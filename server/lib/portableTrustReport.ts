// P7 C4: operator-visible, secret-free summary of portable import trust.
// Logged once at boot so an operator (or an auditor reading the logs) can see
// exactly which source keys this installation trusts, which signing key it
// uses as a source, and whether the write stages are switched on. Only public
// SPKI fingerprints, origins and validity windows are ever emitted.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import logger from './logger';
import { readDestinationPinnedSourceRegistry } from './portableDestinationTrustConfig';
import { parsePinnedPortableSourceRegistry } from './portableSourceKeyring';
import { readPortableSourceSigningConfig } from './portableSourceExportConfig';

const EXPIRY_WARNING_MS = 14 * 24 * 3600_000;

type KeyState = 'active' | 'pending' | 'expired' | 'revoked';
export type PortableTrustSummary = {
  source: { enabled: boolean; valid: boolean; sourceOrigin: string | null; keyFingerprint: string | null };
  destination: {
    verifyEnabled: boolean;
    valid: boolean;
    keys: Array<{ sourceOrigin: string; fingerprint: string; activeFrom: string; activeUntil: string; state: KeyState }>;
    activeKeys: number;
    expiringSoon: number;
  };
  ownerApprovalEnabled: boolean;
  mappedApplyEnabled: boolean;
  warnings: string[];
};

function stateOf(key: { revoked: boolean; activeFrom: string; activeUntil: string }, now: number): KeyState {
  if (key.revoked) return 'revoked';
  if (now < Date.parse(key.activeFrom)) return 'pending';
  if (now >= Date.parse(key.activeUntil)) return 'expired';
  return 'active';
}

export function summarizePortableTrust(
  env: NodeJS.ProcessEnv = process.env, now: number = Date.now(),
): PortableTrustSummary {
  const warnings: string[] = [];

  const sourceEnabled = env.BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED === 'true';
  let source: PortableTrustSummary['source'] = {
    enabled: sourceEnabled, valid: false, sourceOrigin: null, keyFingerprint: null,
  };
  if (sourceEnabled) {
    try {
      const config = readPortableSourceSigningConfig(env);
      // Derive the PUBLIC fingerprint; the private PEM never leaves this scope.
      const spki = createPublicKey(createPrivateKey(config.signingPrivateKeyPem))
        .export({ type: 'spki', format: 'der' });
      source = {
        enabled: true, valid: true, sourceOrigin: config.sourceOrigin,
        keyFingerprint: createHash('sha256').update(spki).digest('hex'),
      };
    } catch {
      warnings.push('SOURCE_SIGNING_CONFIG_INVALID');
    }
  }

  const verifyEnabled = env.BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED === 'true';
  const destination: PortableTrustSummary['destination'] = {
    verifyEnabled, valid: false, keys: [], activeKeys: 0, expiringSoon: 0,
  };
  if (verifyEnabled) {
    try {
      const keys = parsePinnedPortableSourceRegistry(readDestinationPinnedSourceRegistry(env));
      destination.valid = true;
      destination.keys = keys.map(k => ({
        sourceOrigin: k.sourceOrigin, fingerprint: k.fingerprint,
        activeFrom: k.activeFrom, activeUntil: k.activeUntil, state: stateOf(k, now),
      }));
      const active = destination.keys.filter(k => k.state === 'active');
      destination.activeKeys = active.length;
      destination.expiringSoon = active.filter(k => Date.parse(k.activeUntil) - now < EXPIRY_WARNING_MS).length;
      if (active.length === 0) warnings.push('NO_ACTIVE_PINNED_SOURCE_KEY');
      if (destination.expiringSoon > 0) warnings.push('PINNED_SOURCE_KEY_EXPIRES_WITHIN_14_DAYS');
    } catch {
      warnings.push('DESTINATION_TRUST_REGISTRY_INVALID');
    }
  }

  const ownerApprovalEnabled = env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED === 'true';
  const mappedApplyEnabled = env.BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED === 'true';
  // The routes already fail closed; this makes a half-configured
  // deployment visible instead of silently returning 503/422 to owners.
  if ((ownerApprovalEnabled || mappedApplyEnabled) && !destination.valid) {
    warnings.push('IMPORT_STAGES_ENABLED_WITHOUT_VALID_TRUST_REGISTRY');
  }
  if (mappedApplyEnabled && !ownerApprovalEnabled) warnings.push('MAPPED_APPLY_ENABLED_WITHOUT_OWNER_APPROVAL');

  return { source, destination, ownerApprovalEnabled, mappedApplyEnabled, warnings };
}

/** One boot-time audit line; warnings repeated at warn level. */
export function reportPortableTrust(env: NodeJS.ProcessEnv = process.env): void {
  const summary = summarizePortableTrust(env);
  const anyEnabled = summary.source.enabled || summary.destination.verifyEnabled ||
    summary.ownerApprovalEnabled || summary.mappedApplyEnabled;
  if (!anyEnabled) return;
  logger.info({ event: 'portable.trust.effective', ...summary },
    '[Portable] Effective source signing and pinned destination trust (public fingerprints only).');
  if (summary.warnings.length > 0) {
    logger.warn({ event: 'portable.trust.warning', warnings: summary.warnings },
      '[Portable] Portable import trust configuration needs operator attention.');
  }
}
