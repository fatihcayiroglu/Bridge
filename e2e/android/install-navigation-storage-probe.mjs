// This instrumentation is opt-in for the debug emulator TEST APK only.
// It modifies generated mobile/www, never the tracked mobile shell template.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const marker = '<!-- BRIDGE:APP-SCRIPTS:START -->';
const tag = '<script src="js/navigation-storage-probe.js"></script>';

export function installNavigationStorageProbe(repo = root) {
  const index = path.join(repo, 'mobile/www/index.html');
  const source = path.join(repo, 'e2e/android/navigation-storage-probe.js');
  const dest = path.join(repo, 'mobile/www/js/navigation-storage-probe.js');
  if (!fs.existsSync(index) || !fs.existsSync(source)) throw new Error('EX01 generated shell or probe missing');
  const html = fs.readFileSync(index, 'utf8');
  if (html.split(marker).length !== 2 || html.includes(tag) || !html.includes('type="module"')) {
    throw new Error('EX01 script marker missing/duplicated or shell already instrumented');
  }
  fs.copyFileSync(source, dest);
  fs.writeFileSync(index, html.replace(marker, tag + '\n' + marker));
  return { installed: true };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.env.BRIDGE_NAV_PROBE_TEST_APK !== '1') {
    console.error('EX01 requires explicit TEST APK opt-in');
    process.exitCode = 1;
  } else {
    try {
      installNavigationStorageProbe();
      console.log('EX01 read-only navigation probe installed in test APK');
    } catch {
      console.error('EX01 test APK probe installation failed');
      process.exitCode = 1;
    }
  }
}
