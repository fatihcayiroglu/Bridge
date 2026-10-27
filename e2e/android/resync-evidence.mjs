// N02 reconnect-resync evidence (#497 run 40470478921: the server stored the
// missed message, the socket reconnected 0.2 s after the network returned, and
// the WebView still never showed it — with nothing recorded about why).
//
// Records only what the client did after reconnecting: lifecycle event counts,
// and the status of each channel-history request. Never URLs, ids, message
// text or console lines. Evidence only: it never changes N02's verdict.

const HISTORY_PATH = /^\/api\/channels\/[^/]+\/messages$/;

export function isHistoryRequest(url) {
  try {
    return HISTORY_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * @param {{ events: Record<string, number>, history: Array<number|'failed'> } | null} page
 *   counters read back from the WebView
 * @param {Array<number|'failed'>} responses history request outcomes seen by the harness
 */
export function summarizeResync(page, responses) {
  const statuses = {};
  for (const r of responses) statuses[String(r)] = (statuses[String(r)] ?? 0) + 1;
  const events = page?.events ?? null;
  const reconnected = (events?.['bridge:socket-reconnected'] ?? 0) + (events?.['bridge:socket-ready'] ?? 0);
  let stage;
  if (!page) stage = 'page-unreadable';
  else if (reconnected === 0) stage = 'no-reconnect-event';
  else if (responses.length === 0) stage = 'no-history-request';
  else if (!responses.some((r) => r === 200)) stage = 'history-request-failed';
  else stage = 'history-loaded-not-rendered';
  return { stage, events, historyRequests: responses.length, historyStatuses: statuses };
}

/** Starts counting on `page`. Call `read()` once, after the check. */
export async function startResyncRecorder(page) {
  const responses = [];
  const onResponse = (res) => { if (isHistoryRequest(res.url())) responses.push(res.status()); };
  const onFailed = (req) => { if (isHistoryRequest(req.url())) responses.push('failed'); };
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  await page.evaluate(() => {
    const names = ['bridge:socket-reconnected', 'bridge:socket-ready', 'bridge:auth-success', 'bridge:auth-logout'];
    const counts = Object.fromEntries(names.map((n) => [n, 0]));
    for (const n of names) document.addEventListener(n, () => { counts[n] += 1; });
    window.__bridgeResyncEvidence = { counts, online: [] };
    window.addEventListener('online', () => window.__bridgeResyncEvidence.online.push('online'));
  });
  return {
    async read() {
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
      const inPage = await page.evaluate(() => {
        const e = window.__bridgeResyncEvidence;
        return e ? { events: { ...e.counts, online: e.online.length } } : null;
      }).catch(() => null);
      return summarizeResync(inPage, responses);
    },
  };
}
