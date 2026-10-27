// Read-only, failure-only shape of the already selected packaged WebView.
// The function is serialized into that actual page; retain no HTML, URL, error
// message, source, title, identifier or input value.
export function startupPageFacts(doc = globalThis.document, realm = globalThis) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const early = Array.isArray(realm.__BRIDGE_EARLY_ERRORS__) ? realm.__BRIDGE_EARLY_ERRORS__ : null;
  return {
    readyState: ['loading', 'interactive', 'complete'].includes(doc?.readyState) ? doc.readyState : 'unknown',
    htmlDocument: doc?.contentType === 'text/html',
    topLevelFrame: realm.top === realm,
    canonicalIndexPath: ['/', '/index.html'].includes(realm.location?.pathname),
    bodyPresent: !!doc?.body,
    bodyElementCount: count(doc?.body?.childElementCount),
    scriptCount: count(doc?.scripts?.length),
    authRootPresent: !!doc?.getElementById('auth-screen'),
    appRootPresent: !!doc?.getElementById('app'),
    earlyErrorBufferPresent: early !== null,
    earlyErrorCount: early === null ? null : Math.min(early.length, 20),
    earlyResourceErrorCount: early === null ? null : early.slice(0, 20).filter(e => e?.type === 'resource').length,
  };
}
