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
