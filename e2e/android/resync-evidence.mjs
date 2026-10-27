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
  else stage = 'history-loaded';
  return { stage, events, historyRequests: responses.length, historyStatuses: statuses };
}

/**
 * Starts counting on `page`. Call `read()` once, after the check.
 *
 * Counted inside the page, around window.fetch: the packaged app routes REST
 * through CapacitorHttp (mobile/capacitor.config.ts), so those requests never
 * reach the WebView network stack and Playwright's network events miss them
 * (#505's first run reported no history request although the message arrived).
 */
export async function startResyncRecorder(page) {
  await page.evaluate((source) => {
    const historyPath = new RegExp(source);
    const base = location.href;
    const isHistory = (input) => {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        return historyPath.test(new URL(url, base).pathname);
      } catch {
        return false;
      }
    };
    const names = ['bridge:socket-reconnected', 'bridge:socket-ready', 'bridge:auth-success', 'bridge:auth-logout'];
    const evidence = { counts: Object.fromEntries(names.map((n) => [n, 0])), online: 0, history: [] };
    for (const n of names) document.addEventListener(n, () => { evidence.counts[n] += 1; });
    window.addEventListener('online', () => { evidence.online += 1; });
    const original = window.fetch;
    window.fetch = async function (...args) {
      const counted = isHistory(args[0]);
      try {
        const res = await original.apply(this, args);
        if (counted) evidence.history.push(res.status);
        return res;
      } catch (err) {
        if (counted) evidence.history.push('failed');
        throw err;
      }
    };
    window.__bridgeResyncEvidence = { evidence, restore: () => { window.fetch = original; } };
  }, HISTORY_PATH.source);
  return {
    async read() {
      const inPage = await page.evaluate(() => {
        const r = window.__bridgeResyncEvidence;
        if (!r) return null;
        r.restore();
        return { events: { ...r.evidence.counts, online: r.evidence.online }, history: [...r.evidence.history] };
      }).catch(() => null);
      return summarizeResync(inPage, inPage?.history ?? []);
    },
  };
}
