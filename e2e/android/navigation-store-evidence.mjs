// #490: privacy-bounded evidence of the native navigation store lifecycle.
//
// BridgeNavigationStorePlugin (debug builds only) logs fixed-format lines:
//   event=requested|committed|failed seq=N kind=server|channel|owner op=put|remove|forget [ms=N|code=X|removed=N]
//   event=boot-read entries=N        event=read-failed code=X
// Only counts and booleans leave this module. Raw logcat and the identifiers
// it is checked against stay in memory; a line that does not match the fixed
// format is counted as malformed (it could carry anything) and fails closed.
const LINE = /^[VDIWEF]\/BridgeNavStore\(\s*([0-9]{1,8})\):\s(.*)$/;
const EVENT = /^event=(requested|committed|failed) seq=[0-9]{1,12} kind=(server|channel|owner|invalid) op=(put|remove|forget)(?: (?:ms|removed)=[0-9]{1,9}| code=[a-z_]{1,32})?$/;
const BOOT = /^event=boot-read entries=[0-9]{1,6}$/;
const READ_FAILED = /^event=read-failed code=[a-z_]{1,32}$/;

/**
 * @param {string} raw `logcat -d -v brief -s BridgeNavStore:I '*:S'` output
 * @param {{ identifiers: string[] }} options identifiers that must never appear
 */
export function parseNavigationStoreLog(raw, { identifiers = [] } = {}) {
  const result = {
    available: typeof raw === 'string', requested: 0, committed: 0, failed: 0,
    bootReads: 0, readFailed: 0, malformed: 0, identifierLeak: false,
  };
  if (!result.available) return result;
  const secrets = identifiers.filter(id => typeof id === 'string' && id.length >= 4);
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('BridgeNavStore')) continue;
    if (secrets.some(id => line.includes(id))) result.identifierLeak = true;
    const match = LINE.exec(line.trimEnd());
    const message = match?.[2] ?? '';
    const event = EVENT.exec(message);
    if (event) result[event[1]]++;
    else if (BOOT.test(message)) result.bootReads++;
    else if (READ_FAILED.test(message)) result.readFailed++;
    else result.malformed++;
  }
  return result;
}

/**
 * PASS needs real acknowledged commits and a boot read with no failure, leak
 * or unparseable line. Missing evidence is UNVERIFIED (never PASS); it is a
 * FAIL when EX01 itself passed, because EX01 exercised exactly these paths.
 */
export function navigationStoreVerdict(evidence, { lifecyclePassed }) {
  if (!evidence?.available) return lifecyclePassed ? 'FAIL' : 'UNVERIFIED';
  if (evidence.identifierLeak || evidence.malformed > 0 || evidence.failed > 0 || evidence.readFailed > 0) return 'FAIL';
  if (evidence.committed > 0 && evidence.bootReads > 0) return 'PASS';
  return lifecyclePassed ? 'FAIL' : 'UNVERIFIED';
}
