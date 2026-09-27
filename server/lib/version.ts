import fs from 'fs';
import path from 'path';

function packageVersionFromDisk(): string | null {
  // Source execution:   server/lib -> server/package.json (../package.json)
  // Compiled execution: server/dist/lib -> server/package.json (../../package.json)
  const candidates = [
    path.resolve(__dirname, '../package.json'),
    path.resolve(__dirname, '../../package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parsed.version)) {
        return parsed.version;
      }
    } catch { /* try the next runtime layout */ }
  }
  return null;
}

/** Canonical first-party runtime version, also available when launched with plain `node`. */
export const BRIDGE_VERSION =
  process.env.BRIDGE_VERSION?.trim()
  || process.env.npm_package_version?.trim()
  || packageVersionFromDisk()
  || '0.0.0';
