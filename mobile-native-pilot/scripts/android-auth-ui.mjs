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

// The Bridge login page has TWO controls named "Sign In": the active tab (client/index.html:140) and the submit
// button below the password field (:150). Run 40694259425 failed AMBIGUOUS_NATIVE_CONTROL on exactly this pair
// (bounds [105,999][538,1117] and [94,1676][987,1794]). The submit is the single match that starts at or below the
// bottom of the password field; zero such matches means "not rendered yet" (null), several stay ambiguous.
export function signInSubmit(nodes, label, packages, passwordField) {
  const box=b=>{const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(b ?? '');return m&&m.slice(1).map(Number);};
  const field=box(passwordField?.bounds);
  assert.ok(field && field[3]>field[1],'PASSWORD_FIELD_BOUNDS_REQUIRED');
  const below=nodes.filter(n=>packages.includes(n.package) && n.enabled==='true' && n.clickable==='true'
    && (n.text===label || n['content-desc']===label) && (box(n.bounds)?.[1] ?? -1)>=field[3]);
  assert.ok(below.length<=1,'AMBIGUOUS_SIGN_IN_SUBMIT');
  return below[0] ?? null;
}

// Text fields of one package, split by the `password` attribute. Run 40695774846 typed the password into the
// username field (its visible text was the username followed by the redacted secret, then the page said "All
// fields are required"): the password field's bounds were stale after the first keyboard, so the tap missed.
export function loginFields(nodes, packages) {
  const edits=nodes.filter(n=>packages.includes(n.package) && n.class==='android.widget.EditText');
  const names=edits.filter(n=>n.password==='false'),secrets=edits.filter(n=>n.password==='true');
  assert.ok(names.length===1 && secrets.length===1,'REAL_LOGIN_FIELDS_REQUIRED');
  return {name:names[0],secret:secrets[0]};
}
// The field that must receive the next typed text: it has to report focus itself, never be assumed from a tap.
export const isFocused=n=>n?.focused==='true';
// After typing, the username field must hold exactly the username (so the password cannot have landed there).
export function usernameIntact(nodes, packages, username) {
  return loginFields(nodes,packages).name.text===username;
}

// The smallest clickable node (same package) whose bounds contain the target. A label's own centre can be covered
// by, or not itself carry, the click handler (run 40699718082: the CA file stayed listed after repeated taps).
export function smallestClickableContaining(nodes, target) {
  const box=b=>{const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(b ?? '');return m&&m.slice(1).map(Number);};
  const t=box(target?.bounds);
  if(!t)return null;
  const area=b=>(b[2]-b[0])*(b[3]-b[1]);
  const containers=nodes.filter(n=>n!==target && n.package===target.package && n.enabled==='true' && n.clickable==='true')
    .map(n=>({n,b:box(n.bounds)})).filter(({b})=>b && b[0]<=t[0] && b[1]<=t[1] && b[2]>=t[2] && b[3]>=t[3] && area(b)>0)
    .sort((x,y)=>area(x.b)-area(y.b));
  return containers[0]?.n ?? null;
}

// What Chrome's WebView itself reported when the login form never rendered (run 40703767548: the page showed the
// Sign In / Create Account tabs but no input field for 60 s). Console / error lines of the chromium tags only, with every
// URL and long token removed, bounded in number and width. Never the page content, a URL, a code or a credential.
const CHROME_LINE=/\b(?:chromium|cr_\w+|chromium_android)\b.*(?:CONSOLE|Uncaught|ERR_[A-Z_]+|Failed to|ERROR)/i;
export function chromeConsoleEvidence(logText, max=12, width=160) {
  return String(logText ?? '').split('\n').filter(l=>CHROME_LINE.test(l))
    .map(l=>l.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi,'<url>').replace(/[A-Za-z0-9+/_=-]{24,}/g,m=>/^ERR_[A-Z_]+$/.test(m)?m:'[redacted]').replace(/\s+/g,' ').trim().slice(0,width)).slice(-max);
}
