#!/usr/bin/env bash
# AUTOMATED / SIMULATOR evidence: the packaged app must carry a valid ad hoc
# signature whose entitlements grant Keychain access to its own group.
#
# Without a signature an iOS app has no application identifier, and every
# Keychain call from the native local-encryption plugin fails with
# errSecMissingEntitlement (-34018); measured on PR #365 with
# CODE_SIGNING_ALLOWED=NO. This gate reads what the built binary actually
# carries (code signature and the simulator `__entitlements` section) instead
# of trusting build settings, and writes it to the evidence directory.
set -euo pipefail
APP="${1:?usage: verify-simulator-signature.sh <App.app> <bundle id>}"
BUNDLE_ID="${2:?usage: verify-simulator-signature.sh <App.app> <bundle id>}"
OUT="${IOS_EVIDENCE_DIR:-e2e/ios/results}"
mkdir -p "$OUT"
test -d "$APP"

executable="$APP/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")" = "$BUNDLE_ID"

# 1. The signature exists, is ad hoc, and verifies (nested frameworks included).
codesign --verify --deep --strict --verbose=2 "$APP" 2> "$OUT/codesign-verify.txt"
codesign -dvvv "$APP" 2> "$OUT/codesign-details.txt"
grep -q '^Signature=adhoc$' "$OUT/codesign-details.txt" || {
  echo "FAIL: $APP is not ad hoc signed"; cat "$OUT/codesign-details.txt"; exit 1; }

# 2. Entitlements as the signature declares them, and as the simulator reads
#    them from the binary (Xcode embeds them in __TEXT,__entitlements for
#    simulator builds).
codesign -d --entitlements - --xml "$APP" > "$OUT/entitlements-signature.plist" 2>/dev/null || true
python3 - "$executable" "$OUT/entitlements-simulated.plist" <<'PY'
# Read __TEXT,__entitlements from the Mach-O (thin or fat; 64-bit slices).
import struct, sys
exe, out = sys.argv[1], sys.argv[2]
data = open(exe, 'rb').read()
def slices(buf):
    magic = struct.unpack('>I', buf[:4])[0]
    if magic in (0xcafebabe, 0xcafebabf):          # fat: big-endian arch table
        count = struct.unpack('>I', buf[4:8])[0]
        wide = magic == 0xcafebabf
        for i in range(count):
            if wide:
                _, _, off, size, _, _ = struct.unpack('>iiQQII', buf[8 + i * 32:8 + i * 32 + 32])
            else:
                _, _, off, size, _ = struct.unpack('>iiIII', buf[8 + i * 20:8 + i * 20 + 20])
            yield buf[off:off + size]
    else:
        yield buf
def section(macho):
    if struct.unpack('<I', macho[:4])[0] != 0xfeedfacf:   # 64-bit little-endian only
        return None
    ncmds = struct.unpack('<I', macho[16:20])[0]
    pos = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack('<II', macho[pos:pos + 8])
        if cmd == 0x19:                                    # LC_SEGMENT_64
            segname = macho[pos + 8:pos + 24].rstrip(b'\0')
            nsects = struct.unpack('<I', macho[pos + 64:pos + 68])[0]
            for j in range(nsects):
                sp = pos + 72 + j * 80
                sectname = macho[sp:sp + 16].rstrip(b'\0')
                if segname == b'__TEXT' and sectname == b'__entitlements':
                    sect_size = struct.unpack('<Q', macho[sp + 40:sp + 48])[0]
                    offset = struct.unpack('<I', macho[sp + 48:sp + 52])[0]
                    return macho[offset:offset + sect_size]
        pos += size
    return None
found = [s for s in (section(m) for m in slices(data)) if s]
# Every slice must embed the same set; keep the first, record disagreement.
if len({bytes(s) for s in found}) > 1:
    sys.exit('FAIL: architecture slices embed different entitlements')
open(out, 'wb').write(found[0] if found else b'')
PY

python3 - "$BUNDLE_ID" "$OUT/entitlements-signature.plist" "$OUT/entitlements-simulated.plist" "$OUT/signature-summary.json" <<'PY'
import json, plistlib, sys
bundle, sig_path, sim_path, summary_path = sys.argv[1:5]
def load(path):
    data = open(path, 'rb').read().strip(b'\0')
    if not data:
        return {}
    return plistlib.loads(data)
sources = {'signature': load(sig_path), 'simulated': load(sim_path)}
def keychain_groups(ent):
    groups = ent.get('keychain-access-groups') or []
    return [g for g in groups if isinstance(g, str)]
ok = {name: any(g == bundle or g.endswith('.' + bundle) for g in keychain_groups(ent))
      for name, ent in sources.items()}
summary = {
    'bundleId': bundle,
    'entitlements': {name: {
        'application-identifier': ent.get('application-identifier'),
        'keychain-access-groups': keychain_groups(ent),
        'keys': sorted(ent.keys()),
    } for name, ent in sources.items()},
    'keychainGroupGranted': ok,
}
json.dump(summary, open(summary_path, 'w'), indent=2)
print(json.dumps(summary, indent=2))
# The simulator honours the embedded section; the signature carries the same
# set on a correctly signed build. Either one granting the app's own group is
# required; none is a hard failure.
if not any(ok.values()):
    sys.exit('FAIL: no entitlement source grants the Keychain group for ' + bundle)
# A shared or wildcard group would widen key access beyond this app.
for name, ent in sources.items():
    for group in keychain_groups(ent):
        if '*' in group or not (group == bundle or group.endswith('.' + bundle)):
            sys.exit(f'FAIL: {name} entitlements grant an unexpected Keychain group: {group}')
PY
echo "PASS: $APP is ad hoc signed and entitled to its own Keychain group"
