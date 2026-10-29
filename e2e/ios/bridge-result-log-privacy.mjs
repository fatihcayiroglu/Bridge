import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Fixed shape only: never include a rejected native line in an error/log. */
export function checkBridgeResultPrivacy(consoleText) {
  let results = 0;
  let decrypts = 0;
  for (const line of consoleText.split(/\r?\n/)) {
    const at = line.indexOf('⚡️  TO JS');
    if (at < 0) continue;
    const safe = /^⚡️  TO JS \[payload redacted\] ([A-Za-z0-9_]{1,64}) ([A-Za-z0-9_]{1,64})\s*$/.exec(line.slice(at));
    if (!safe) throw new Error('IOS_NATIVE_RESULT_PAYLOAD_LOGGED');
    results++;
    if (safe[1] === 'BridgeLocalFirstCrypto' && safe[2] === 'decrypt') decrypts++;
  }
  if (!decrypts) throw new Error('IOS_NATIVE_DECRYPT_LOG_CONTROL_MISSING');
  return { results, decrypts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const counts = checkBridgeResultPrivacy(fs.readFileSync(process.argv[2], 'utf8'));
    console.log(`PASS native result log privacy: ${counts.results} results, ${counts.decrypts} decrypt controls`);
  } catch (error) {
    // Filesystem/provider errors can contain paths or payloads. Fixed codes only.
    console.error(error instanceof Error && error.message.startsWith('IOS_NATIVE_')
      ? error.message : 'IOS_NATIVE_RESULT_LOG_CHECK_FAILED');
    process.exitCode = 1;
  }
}
