// Closed-shape evidence about the web login form at the moment an iOS journey fails (explicit-consent, runs
// 40690582185 and 40693195325: no native-code request, 2 text + 2 secure fields). It reads the XCUITest page
// source and reports only booleans, counts, lengths and a fixed allow-list of UI labels - never a field value,
// the username, the password, a URL or any other free text.
const LABELS = ['Sign In', 'Create Account', 'All fields are required', 'Continue in the app', 'Forgot your password?',
  'Sign in with a passkey', 'Username', 'Password', 'Invalid credentials'];
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");
const nodes = (source) => [...String(source).matchAll(/<(XCUIElementType\w+)\b([^>]*)>/g)].map(([, type, attrs]) => ({ type, ...attrsOf(attrs) }));
// Whether the page source reports keyboard focus for a node: true, false, or null when the attribute is absent.
const flag = (v) => (v === 'true' ? true : v === 'false' ? false : null);
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
      valueContainsUsername: typeof username === 'string' && username.length > 0 && decode(n.value ?? '').includes(username), valueLength: (n.value ?? '').length, focused: flag(n.focused) })),
    secureFields: secure.slice(0, 4).map((n) => ({ visible: n.visible === 'true', y: num(n.y), valueLength: (n.value ?? '').length, focused: flag(n.focused) })),
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

// Which field reports focus, as booleans only (null = the page source carries no focus attribute).
export function focusSnapshot(evidence) {
  const flags = (fields) => (fields ?? []).slice(0, 4).map((field) => (typeof field.focused === 'boolean' ? field.focused : null));
  return { text: flags(evidence?.textFields), secure: flags(evidence?.secureFields) };
}

// What is on screen when the system browser never shows a login form (run 40772071912: 9 web views, 0 fields, no known
// label). Counts by element type plus a fixed allow-list of control names - never text, values or URLs.
const PLAIN_LABEL = /^[A-Za-z][A-Za-z .,'!?-]*$/;
const SURVEY_NAMES = ['Sign in with your browser', 'Continue', 'Cancel', 'Open', 'Allow', 'Done', 'Sign Out', 'Switch account'];
export function uiSurvey(source) {
  const all = nodes(source);
  const byType = {};
  for (const n of all) { const t = n.type.replace('XCUIElementType', ''); byType[t] = (byType[t] ?? 0) + 1; }
  const named = (label) => all.some((n) => [n.name, n.label].some((v) => typeof v === 'string' && decode(v) === label));
  return {
    nodes: all.length,
    byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)),
    namesPresent: SURVEY_NAMES.filter(named),
    visibleWebViews: all.filter((n) => n.type === 'XCUIElementTypeWebView' && n.visible === 'true').length,
    // Run 40774768212: 3 visible web views, "Cancel" present, none of the known login labels. Plain-word UI copy only
    // (letters, spaces and . , ' ! ? -), at most 40 characters, at most 12 distinct; anything with a digit, underscore,
    // slash, colon, @ or similar (user names, URLs, tokens) is dropped by the pattern, never printed.
    plainLabels: [...new Set(all.filter((n) => ['XCUIElementTypeButton', 'XCUIElementTypeStaticText', 'XCUIElementTypeLink'].includes(n.type))
      .flatMap((n) => [n.name, n.label].filter((v) => typeof v === 'string').map(decode))
      .filter((v) => v.length > 0 && v.length <= 40 && PLAIN_LABEL.test(v)))].slice(0, 12),
  };
}

// The route a driver command used, with every element or session id replaced, so a failure can be placed on a step
// without printing ids, arguments or response bodies (run 40779920476: DRIVER_OR_SERVICE_FAILED after the username).
export function routeShape(method, route) {
  const clean = String(route ?? '').split('?')[0].split('/').map((seg) => (/^[0-9A-Fa-f-]{16,}$/.test(seg) ? ':id' : seg)).join('/');
  const ok = /^\/[A-Za-z0-9_:\/.-]{0,120}$/.test(clean) ? clean : '/?';
  return `${/^[A-Z]{3,7}$/.test(String(method)) ? method : '?'} ${ok}`;
}

// W3C key actions that type text into whatever holds keyboard focus (one keyDown/keyUp pair per character).
export function keyActions(text) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length === 0 || chars.length > 256) throw new Error('KEY_TEXT_INVALID');
  return { actions: [{ type: 'key', id: 'keyboard', actions: chars.flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }] };
}

// After typing the password, the one visible secure field must hold exactly that many characters. Run 40785140974
// showed `mobile: keys` returning 500; a method that reports success but types nowhere must not pass either.
export function assertPasswordLanded(evidence, length) {
  const visible = (evidence?.secureFields ?? []).filter((field) => field.visible);
  if (visible.length !== 1) throw new Error('LOGIN_SECRET_FIELD_NOT_UNIQUE');
  if (visible[0].valueLength !== length) throw new Error('LOGIN_PASSWORD_NOT_IN_SECRET_FIELD');
  return true;
}
