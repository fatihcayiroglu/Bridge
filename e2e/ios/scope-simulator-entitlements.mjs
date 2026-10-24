// CI Debug simulator only: attach the Keychain entitlements to the App
// target's Debug configuration and nothing else.
//
// Passing CODE_SIGN_ENTITLEMENTS on the xcodebuild command line applies it to
// every target, Swift package targets included (they then fail to find the
// file, and would otherwise be granted the app's Keychain group). Exactly one
// XCBuildConfiguration must match (Debug, INFOPLIST_FILE = App/Info.plist),
// and an existing CODE_SIGN_ENTITLEMENTS is never overridden.
//
// Usage: node e2e/ios/scope-simulator-entitlements.mjs <project.pbxproj> <entitlements path>
import fs from 'node:fs';

const [pbxPath, entitlements] = process.argv.slice(2);
if (!pbxPath || !entitlements || !/^[A-Za-z0-9_./-]+\.entitlements$/.test(entitlements)) {
  console.error('usage: scope-simulator-entitlements.mjs <project.pbxproj> <App/Name.entitlements>');
  process.exit(2);
}
const source = fs.readFileSync(pbxPath, 'utf8');
// Tolerant of indentation and quoting (Capacitor's generated projects use tabs
// and unquoted values; hand-edited ones may not).
const block = /([0-9A-F]{24} \/\* Debug \*\/ = \{\s*isa = XCBuildConfiguration;[\s\S]*?buildSettings = \{\n)([\s\S]*?)(\n[ \t]*\};\s*name = Debug;\s*\};)/g;
let matches = 0;
const updated = source.replace(block, (whole, head, settings, tail) => {
  if (!/\bINFOPLIST_FILE = "?App\/Info\.plist"?;/.test(settings)) return whole;
  matches += 1;
  if (/\bCODE_SIGN_ENTITLEMENTS\b/.test(settings)) {
    console.error('App Debug configuration already declares CODE_SIGN_ENTITLEMENTS; refusing to override it');
    process.exit(1);
  }
  const indent = (/^([ \t]+)\S/m.exec(settings) || [, '\t\t\t\t'])[1];
  return `${head}${indent}CODE_SIGN_ENTITLEMENTS = ${entitlements};\n${settings}${tail}`;
});
if (matches !== 1) {
  console.error(`expected exactly one App Debug configuration, found ${matches}`);
  process.exit(1);
}
fs.writeFileSync(pbxPath, updated);
console.log(`CODE_SIGN_ENTITLEMENTS = ${entitlements} set on the App target's Debug configuration only`);
