// Closed-shape evidence about the web login form at the moment an iOS journey fails (explicit-consent, runs
// 40690582185 and 40693195325: no native-code request, 2 text + 2 secure fields). It reads the XCUITest page
// source and reports only booleans, counts, lengths and a fixed allow-list of UI labels - never a field value,
// the username, the password, a URL or any other free text.
const LABELS = ['Sign In', 'Create Account', 'All fields are required', 'Continue in the app', 'Forgot your password?',
  'Sign in with a passkey', 'Username', 'Password', 'Invalid credentials'];
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");
const nodes = (source) => [...String(source).matchAll(/<(XCUIElementType\w+)\b([^>]*)>/g)].map(([, type, attrs]) => ({ type, ...attrsOf(attrs) }));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
export function loginEvidence(source, username) {
  const all = nodes(source);
  const named = (label) => all.filter((n) => [n.name, n.label, n.value].some((v) => typeof v === 'string' && decode(v) === label));
  const text = all.filter((n) => n.type === 'XCUIElementTypeTextField');
  const secure = all.filter((n) => n.type === 'XCUIElementTypeSecureTextField');
  return {
    labelsPresent: LABELS.filter((label) => named(label).length > 0),
    signInControls: named('Sign In').slice(0, 6).map((n) => ({ type: n.type.replace('XCUIElementType', ''), y: num(n.y), height: num(n.height), visible: n.visible === 'true' })),
    textFields: text.slice(0, 4).map((n) => ({ visible: n.visible === 'true', y: num(n.y), valueIsUsername: typeof username === 'string' && username.length > 0 && decode(n.value ?? '') === username,
      valueContainsUsername: typeof username === 'string' && username.length > 0 && decode(n.value ?? '').includes(username), valueLength: (n.value ?? '').length })),
    secureFields: secure.slice(0, 4).map((n) => ({ visible: n.visible === 'true', y: num(n.y), valueLength: (n.value ?? '').length })),
  };
}

// After typing, the one visible username field must hold exactly the username. Run 40700229648 showed the password
// appended to it (value length 63, the secure field empty), so the form could never submit. Closed error codes only.
export function assertUsernameIntact(evidence) {
  const visible = (evidence?.textFields ?? []).filter((field) => field.visible);
  if (visible.length !== 1) throw new Error('LOGIN_USERNAME_FIELD_NOT_UNIQUE');
  if (!visible[0].valueIsUsername) throw new Error(visible[0].valueContainsUsername ? 'LOGIN_PASSWORD_TYPED_INTO_USERNAME_FIELD' : 'LOGIN_USERNAME_FIELD_NOT_SET');
  return true;
}

// Where a field is on screen, as plain numbers: the password field moved after the username keyboard opened (the
// stale-position hypothesis for run 40706730676, where focus still landed in the username field).
export function fieldGeometry(rect) {
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  return { x: n(rect?.x), y: n(rect?.y), width: n(rect?.width), height: n(rect?.height) };
}
export function centerOf(rect) {
  const g = fieldGeometry(rect);
  if ([g.x, g.y, g.width, g.height].some((v) => v === null) || g.width <= 0 || g.height <= 0) throw new Error('LOGIN_FIELD_RECT_REQUIRED');
  return { x: g.x + Math.floor(g.width / 2), y: g.y + Math.floor(g.height / 2) };
}
// W3C pointer actions for one real touch tap at a point (the same path a finger takes), no element shortcut.
export function tapActions(point) {
  return { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x: point.x, y: point.y }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 120 }, { type: 'pointerUp', button: 0 }] }] };
}
