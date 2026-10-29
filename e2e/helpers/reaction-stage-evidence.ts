import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const browserCounters = ['quickReactionClicks', 'dispatched', 'queued', 'applied', 'rejected', 'timeout', 'socketReady', 'socketReconnected'] as const;
const socketEvents = ['channel:join', 'message:react', 'message:reaction', 'message:ack', 'message:new', 'userAuthenticated', 'error:message'] as const;
type SocketEvent = typeof socketEvents[number];
const bounded = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.floor(value))) : 0;

// Serialized by addInitScript: keep this function self-contained. Observe only;
// never replace application callbacks, the encrypted store or socket methods.
export function installReactionObservation(): () => void {
  const counts = { quickReactionClicks: 0, dispatched: 0, queued: 0, applied: 0, rejected: 0, timeout: 0, socketReady: 0, socketReconnected: 0 };
  (window as Window & { __bridgeReactionEvidence?: unknown }).__bridgeReactionEvidence = counts;
  const listeners: Array<[string, EventListener]> = [];
  const listen = (name: string, callback: EventListener): void => {
    document.addEventListener(name, callback, true);
    listeners.push([name, callback]);
  };
  listen('click', event => {
    if (event.target instanceof Element && event.target.closest('.msg-emoji-row button')) {
      counts.quickReactionClicks = Math.min(100, counts.quickReactionClicks + 1);
    }
  });
  for (const stage of ['dispatched', 'queued', 'applied', 'rejected', 'timeout'] as const) {
    listen(`bridge:message-operation-${stage}`, event => {
      if ((event as CustomEvent).detail?.kind === 'reaction-state') counts[stage] = Math.min(100, counts[stage] + 1);
    });
  }
  for (const [event, key] of [['bridge:socket-ready', 'socketReady'], ['bridge:socket-reconnected', 'socketReconnected']] as const) {
    listen(event, () => { counts[key] = Math.min(100, counts[key] + 1); });
  }
  return () => { for (const [name, callback] of listeners) document.removeEventListener(name, callback, true); };
}

export function safeBrowserCounts(value: unknown): Record<typeof browserCounters[number], number> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(browserCounters.map(key => [key, bounded(source[key])])) as Record<typeof browserCounters[number], number>;
}

export function observedSocketEvent(payload: string): SocketEvent | null {
  // Default-namespace Socket.IO event packets only. Do not export arbitrary
  // event names, URLs, packet bodies, nonces, user/message/channel IDs or text.
  if (payload.length > 65_536 || !/^42\d*\[/.test(payload)) return null;
  try {
    const value: unknown = JSON.parse(payload.slice(payload.indexOf('[')));
    return Array.isArray(value) && socketEvents.includes(value[0]) ? value[0] as SocketEvent : null;
  } catch { return null; }
}

export function persistedReaction(data: unknown, messageId: string): boolean | null {
  const messages = Array.isArray(data) ? data : data && typeof data === 'object' ? (data as { messages?: unknown }).messages : null;
  if (!Array.isArray(messages)) return null;
  const message: unknown = messages.find(item => item && typeof item === 'object' && (item._id || item.id) === messageId);
  if (!message || typeof message !== 'object') return null;
  let reactions: unknown = (message as { reactions?: unknown }).reactions;
  if (typeof reactions === 'string') {
    try { reactions = JSON.parse(reactions); } catch { return null; }
  }
  if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) return null;
  return Object.values(reactions).some(users => Array.isArray(users) && users.length > 0);
}

export async function startReactionEvidence(page: Page) {
  const packets = Object.fromEntries(socketEvents.map(event => [event, { sent: 0, received: 0 }])) as Record<SocketEvent, { sent: number; received: number }>;
  let opened = 0;
  let closed = 0;
  let pageErrors = 0;
  page.on('pageerror', () => { pageErrors = bounded(pageErrors + 1); });
  page.on('websocket', socket => {
    opened = bounded(opened + 1);
    socket.on('close', () => { closed = bounded(closed + 1); });
    const record = (direction: 'sent' | 'received') => ({ payload }: { payload: string | Buffer }): void => {
      if (payload.length > 65_536) return;
      const event = observedSocketEvent(String(payload));
      if (event) packets[event][direction] = bounded(packets[event][direction] + 1);
    };
    socket.on('framesent', record('sent'));
    socket.on('framereceived', record('received'));
  });
  await page.addInitScript(installReactionObservation);
  return async (info: TestInfo, request: APIRequestContext, token: string, channelId: string, target?: Locator): Promise<void> => {
    const unavailable: string[] = [];
    let browser: unknown = null;
    let persisted: boolean | null = null;
    let readStatus: number | null = null;
    try {
      browser = await page.evaluate(() => (window as Window & { __bridgeReactionEvidence?: unknown }).__bridgeReactionEvidence);
      if (!browser || typeof browser !== 'object') unavailable.push('browser-observation');
    } catch { unavailable.push('browser-observation'); }
    try {
      const messageId = target && await target.count() === 1 ? await target.getAttribute('data-id') : null;
      if (messageId && channelId) {
        // Authorized read only, after the original UI assertion. Never send a
        // replacement reaction or retry an operation to make the scenario pass.
        const response = await request.get(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 5_000,
        });
        readStatus = response.status();
        if (response.ok()) {
          persisted = persistedReaction(await response.json(), messageId);
          if (persisted === null) unavailable.push('authoritative-message');
        }
        else unavailable.push('authoritative-read');
      } else unavailable.push('target-message');
    } catch { unavailable.push('authoritative-read'); }
    const report = JSON.stringify({
      version: 1, browser: safeBrowserCounts(browser), websocket: { opened, closed, packets },
      pageErrors, authoritative: { readStatus, persistedReaction: persisted }, unavailable,
      limits: 'Snapshot after the UI assertion; asynchronous settlement may continue. UI click is not proof of callback completion. Dispatch follows the durable sending write. Polling, non-default namespaces and frames over 64 KiB are not decoded. Server receipt/broadcast and the private operation log are not directly observed. Null means unknown.',
    });
    // CI uses only the list reporter and uploads test-results. Inline attachment
    // bodies live in reporter metadata, so persist a file in the test output too.
    const evidencePath = info.outputPath('reaction-stage-evidence.json');
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, report, { encoding: 'utf8', mode: 0o600 });
    await info.attach('reaction-stage-evidence', { path: evidencePath, contentType: 'application/json' });
  };
}
