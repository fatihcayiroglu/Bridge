import assert from 'node:assert/strict';
const decode = text => text.replace(/&(amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (_, entity) => {
  const named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'};
  return named[entity] ?? String.fromCodePoint(entity.startsWith('#x') ? parseInt(entity.slice(2),16) : Number(entity.slice(1)));
});
// UIAutomator's native accessibility hierarchy, never page script or a callback.
export function nodesOf(xml) {
  assert.match(xml, /<hierarchy\b/, 'NATIVE_UI_HIERARCHY_REQUIRED');
  return [...xml.matchAll(/<node\b([^>]+)>/g)].map(([,attrs]) => Object.fromEntries(
    [...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)])));
}
// System packages that host the Settings navigation. On API 35 `android.settings.SECURITY_SETTINGS` opens Safety
// Center, owned by the permission controller, not com.android.settings (run 40678995495). Only OS packages.
export const SETTINGS_HOSTS=['com.android.settings','com.google.android.permissioncontroller','com.android.permissioncontroller'];
// Some system buttons are rendered in capitals ("INSTALL ANYWAY", run 40686263044). `ignoreCase` is opt-in per
// call so every other control keeps exact matching; package scoping, enabled-only and ambiguity checks are unchanged.
const sameName=(value,label,ignoreCase)=>typeof value==='string' && (ignoreCase ? value.toLocaleLowerCase('en-US')===label.toLocaleLowerCase('en-US') : value===label);
export function namedNode(nodes, label, packages, {ignoreCase=false}={}) {
  const matches=nodes.filter(n=>packages.includes(n.package) && n.enabled==='true'
    && (sameName(n.text,label,ignoreCase) || sameName(n['content-desc'],label,ignoreCase)));
  if(matches.length<=1)return matches[0] ?? null;
  // React Native exposes one Pressable as a clickable container plus its Text child, both carrying the label.
  // That is one control: accept it only when exactly one match is clickable and every other match lies inside it.
  const clickable=matches.filter(n=>n.clickable==='true');
  if(clickable.length===1 && matches.every(n=>n===clickable[0] || boundsWithin(n.bounds,clickable[0].bounds)))return clickable[0];
  throw Object.assign(Error('AMBIGUOUS_NATIVE_CONTROL'),{matches:matches.slice(0,6).map(n=>({class:n.class,package:n.package,clickable:n.clickable,bounds:n.bounds}))});
}
function boundsWithin(inner,outer) {
  const parse=b=>{const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(b ?? '');return m&&m.slice(1).map(Number);};
  const i=parse(inner),o=parse(outer);
  return Boolean(i&&o&&i[0]>=o[0]&&i[1]>=o[1]&&i[2]<=o[2]&&i[3]<=o[3]);
}
export function centerOf(node) {
  const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node?.bounds ?? '');
  assert.ok(m,'NATIVE_CONTROL_BOUNDS_REQUIRED');
  const [x1,y1,x2,y2]=m.slice(1).map(Number);
  assert.ok(x2>x1 && y2>y1,'EMPTY_NATIVE_CONTROL');
  return [Math.floor((x1+x2)/2),Math.floor((y1+y2)/2)];
}

// A system "<process> isn't responding" dialog (package `android`). It covers whatever app is below it, so a
// foreign one (e.g. the launcher, #209) is answered with Wait; the caller records every press. An ANR of the
// app under test or of the browser is a real failure and is never dismissed.
export const MAX_ANR_DIALOGS=30;
export function anrDialog(nodes) {
  const title=nodes.find(n=>n.package==='android' && /^.+ isn[\u2019']t responding$/.test(n.text ?? ''));
  return title ? {process:title.text.replace(/ isn[\u2019']t responding$/,''), wait:namedNode(nodes,'Wait',['android'])} : null;
}
export function anrVerdict(dialog, protectedNames, handled=0) {
  if(!dialog) return 'NONE';
  if(protectedNames.includes(dialog.process)) return 'APP_OR_BROWSER_ANR';
  if(!dialog.wait || handled>=MAX_ANR_DIALOGS) return 'ANR_DIALOG_UNHANDLED';
  return 'WAIT';
}

// `uiautomator dump` can exit 0 without writing the file (e.g. no idle state on a screen that is still
// loading; run 40682196007). Success is the tool's own confirmation, never the exit code alone.
export const MAX_UI_DUMP_ATTEMPTS=5;
// The tool's own message misspells the word ("UI hierchary dumped to:", observed in run 40683551643); both spellings count.
export const dumpSucceeded=output=>/UI hier(?:archy|chary) dumped to: \S+/.test(String(output ?? ''));

// `adb shell a b c` joins its arguments with spaces and the DEVICE shell re-parses them, so a probe must be ONE
// string: `sh -c test -s F && ...` as separate arguments runs a bare `test` and always answers "absent"
// (run 40684975946). Only a plain absolute path is accepted, so nothing can be injected.
export function nonEmptyFileProbe(file) {
  if(!/^\/[\w./-]+$/.test(file)) throw new Error('PROBE_PATH_INVALID');
  return `test -s ${file} && echo present || echo absent`;
}

// What the system itself says about an ANR (process, reason, load). A bounded, redacted excerpt of ActivityManager's
// own lines; nothing else from the log. Used to explain a recurring dialog instead of just dismissing it.
const ANR_LINE=/\bANR in\b|Reason:|\bLoad:|CPU usage from|\bPID:|\bam_anr\b/;
export function anrEvidence(logText, max=10, width=200) {
  return String(logText ?? '').split('\n').filter(l=>ANR_LINE.test(l))
    .map(l=>l.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/[A-Za-z0-9+/_=-]{32,}/g,'[redacted]').replace(/\s+/g,' ').trim().slice(0,width)).slice(-max);
}

// On API 35 the device-PIN prompt of the certificate install is an AuthCredentialPasswordView hosted by System UI
// even though the activity is Settings' ConfirmDeviceCredentialActivity (run 40689648802: visible package was only
// com.android.systemui). OS packages only; more than one candidate field is ambiguous and fatal.
export const PIN_HOSTS=['com.android.settings','com.android.systemui'];
export function findPinField(nodes) {
  const fields=nodes.filter(n=>PIN_HOSTS.includes(n.package) && n.enabled==='true' && n.class==='android.widget.EditText');
  assert.ok(fields.length<=1,'AMBIGUOUS_PIN_FIELD');
  return fields[0] ?? null;
}
