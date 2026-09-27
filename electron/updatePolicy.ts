// electron/updatePolicy.ts
//
// Decides whether this build may check for, download and install updates.
//
// Final21 Phase 12 — measured on an installed build: package.json hard-coded the
// update feed to github.com/bridge-app/bridge. That account exists, the repository
// does not (HTTP 404), and the build is unsigned, so electron-updater would verify
// nothing but a SHA-512 taken from the same feed. Whoever creates that repository
// would be able to ship code to every installed client.
//
// Policy (fail closed):
//   - development (unpackaged) builds: disabled unless BRIDGE_UPDATER_FORCE=true;
//   - no build-time feed (no resources/app-update.yml): disabled;
//   - feed without a code-signing publisher (unsigned build): disabled, unless the
//     build was explicitly produced as an unsigned channel
//     (package.json "bridgeDesktop.allowUnsignedUpdates": true, set by the
//     unsigned release workflow and the local update-mechanics test builds).
// A signed feed carries `publisherName`; electron-updater then refuses any
// downloaded installer whose Authenticode publisher does not match.

export type UpdateDisabledReason = 'development' | 'no-feed' | 'unsigned';

export type UpdatePolicy =
  | { enabled: true; signed: boolean }
  | { enabled: false; reason: UpdateDisabledReason };

export interface UpdatePolicyInput {
  isPackaged: boolean;
  forceInDevelopment: boolean;
  /** Contents of resources/app-update.yml, or null when the build has no feed. */
  appUpdateYml: string | null;
  allowUnsignedUpdates: boolean;
}

/** True when app-update.yml names at least one code-signing publisher. */
export function feedRequiresSignature(appUpdateYml: string): boolean {
  const lines = appUpdateYml.split(/\r?\n/);
  const index = lines.findIndex((line) => /^publisherName\s*:/.test(line));
  if (index < 0) return false;
  const inline = lines[index].replace(/^publisherName\s*:/, '').trim();
  if (inline && inline !== '[]') return true;
  const next = lines[index + 1] ?? '';
  return /^\s*-\s*\S/.test(next);
}

export function resolveUpdatePolicy(input: UpdatePolicyInput): UpdatePolicy {
  if (!input.isPackaged && !input.forceInDevelopment) return { enabled: false, reason: 'development' };
  if (input.appUpdateYml === null || !input.appUpdateYml.trim()) return { enabled: false, reason: 'no-feed' };
  const signed = feedRequiresSignature(input.appUpdateYml);
  if (!signed && !input.allowUnsignedUpdates) return { enabled: false, reason: 'unsigned' };
  return { enabled: true, signed };
}
