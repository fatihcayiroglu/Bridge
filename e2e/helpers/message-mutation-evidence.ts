import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Evidence for the intermittent WebKit edit/delete failures (Quality Gate
// 40442636121, attempt 1): the UI never showed the edit or the removal. It
// separates "the server did not apply it" from "the page did not receive the
// room broadcast" without changing what the tests assert. Counts, booleans and
// coarse timings only: no message text, IDs, nonces, URLs or packet bodies.

const socketEvents = [
  'channel:join', 'userAuthenticated', 'message:send', 'message:ack', 'message:new',
  'message:edit', 'message:edited', 'message:delete', 'message:deleted',
  'error:message', 'error:ratelimit',
] as const;
type SocketEvent = typeof socketEvents[number];
type Kind = 'edit' | 'delete';

const bounded = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.floor(value))) : 0;
const boundedMs = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(600_000, Math.round(value))) : null;

/** Default-namespace Socket.IO event packets only; anything else is ignored. */
export function observedMutationSocketEvent(payload: string): SocketEvent | null {
  if (payload.length > 65_536 || !/^42\d*\[/.test(payload)) return null;
  try {
    const value: unknown = JSON.parse(payload.slice(payload.indexOf('[')));
    return Array.isArray(value) && (socketEvents as readonly unknown[]).includes(value[0]) ? value[0] as SocketEvent : null;
  } catch { return null; }
}

/**
 * The authoritative outcome, from an authorized read of the channel. Compares
 * text locally and returns booleans only.
 */
export function authoritativeMutationOutcome(data: unknown, kind: Kind, original: string, edited: string | null):
  { originalPresent: boolean; editedPresent: boolean | null } | null {
  const messages = Array.isArray(data) ? data : data && typeof data === 'object' ? (data as { messages?: unknown }).messages : null;
  if (!Array.isArray(messages)) return null;
  const contents = messages
    .filter(item => item && typeof item === 'object' && !(item as { deleted?: unknown }).deleted)
    .map(item => String((item as { content?: unknown }).content ?? ''));
  return {
    originalPresent: contents.includes(original),
    editedPresent: kind === 'edit' && edited !== null ? contents.includes(edited) : null,
  };
}

// Serialized by addInitScript: self-contained. Observes only; never replaces
// application callbacks, sockets or the operation log.
export function installMutationObservation(): void {
  const counts: Record<string, number> = {};
  (window as Window & { __bridgeMutationEvidence?: unknown }).__bridgeMutationEvidence = counts;
  const bump = (key: string): void => { counts[key] = Math.min(100, (counts[key] ?? 0) + 1); };
  for (const name of ['bridge:socket-ready', 'bridge:socket-reconnected', 'bridge:socket-disconnected']) {
    document.addEventListener(name, () => bump(name.slice('bridge:'.length)), true);
  }
  for (const stage of ['dispatched', 'queued', 'applied', 'rejected', 'timeout']) {
    document.addEventListener(`bridge:message-operation-${stage}`, event => {
      const kind = (event as CustomEvent).detail?.kind;
      if (kind === 'edit-message' || kind === 'delete-message') bump(`${kind}:${stage}`);
    }, true);
  }
}

const browserKeys = [
  'socket-ready', 'socket-reconnected', 'socket-disconnected',
  ...(['edit-message', 'delete-message'] as const).flatMap(kind =>
    ['dispatched', 'queued', 'applied', 'rejected', 'timeout'].map(stage => `${kind}:${stage}`)),
];

export function safeMutationBrowserCounts(value: unknown): Record<string, number> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(browserKeys.map(key => [key, bounded(source[key])]));
}

type SocketRecord = { openedMs: number | null; closedMs: number | null; first: Partial<Record<string, number>>; counts: Partial<Record<string, number>> };

export async function startMutationEvidence(page: Page, kind: Kind) {
  const started = Date.now();
  const sockets: SocketRecord[] = [];
  let pageErrors = 0;
  page.on('pageerror', () => { pageErrors = bounded(pageErrors + 1); });
  page.on('websocket', socket => {
    if (sockets.length >= 8) return;
    const record: SocketRecord = { openedMs: boundedMs(Date.now() - started), closedMs: null, first: {}, counts: {} };
    sockets.push(record);
    socket.on('close', () => { record.closedMs = boundedMs(Date.now() - started); });
    const observe = (direction: 'sent' | 'received') => ({ payload }: { payload: string | Buffer }): void => {
      if (payload.length > 65_536) return;
      const event = observedMutationSocketEvent(String(payload));
      if (!event) return;
      const key = `${direction} ${event}`;
      record.counts[key] = bounded((record.counts[key] ?? 0) + 1);
      record.first[key] ??= boundedMs(Date.now() - started) ?? undefined;
    };
    socket.on('framesent', observe('sent'));
    socket.on('framereceived', observe('received'));
  });
  await page.addInitScript(installMutationObservation);

  return async (info: TestInfo, request: APIRequestContext, token: string, channelId: string,
    original: string, edited: string | null): Promise<void> => {
    const unavailable: string[] = [];
    let browser: unknown = null;
    let readStatus: number | null = null;
    let outcome: ReturnType<typeof authoritativeMutationOutcome> = null;
    try {
      browser = await page.evaluate(() => (window as Window & { __bridgeMutationEvidence?: unknown }).__bridgeMutationEvidence);
      if (!browser || typeof browser !== 'object') unavailable.push('browser-observation');
    } catch { unavailable.push('browser-observation'); }
    try {
      // Authorized read only, after the original UI assertion. Never resend the
      // mutation or retry it to make the scenario pass.
      const response = await request.get(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 5_000,
      });
      readStatus = response.status();
      if (response.ok()) {
        outcome = authoritativeMutationOutcome(await response.json(), kind, original, edited);
        if (!outcome) unavailable.push('authoritative-messages');
      } else unavailable.push('authoritative-read');
    } catch { unavailable.push('authoritative-read'); }
    const report = {
      version: 1, kind,
      browser: safeMutationBrowserCounts(browser),
      sockets: sockets.map(s => ({ openedMs: s.openedMs, closedMs: s.closedMs, counts: s.counts, firstMs: s.first })),
      pageErrors, authoritative: { readStatus, ...(outcome ?? {}) }, unavailable,
      limits: 'Snapshot after the UI assertion; settlement may continue. Polling transports, other namespaces and frames over 64 KiB are not decoded. Server room membership is not directly observed. Times are ms since page setup.',
    };
    const text = JSON.stringify(report);
    // The CI job log is readable even where artifacts are not; one bounded line.
    console.log(`MUTATION-EVIDENCE ${text}`);
    const evidencePath = info.outputPath(`message-${kind}-evidence.json`);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, text, { encoding: 'utf8', mode: 0o600 });
    await info.attach(`message-${kind}-evidence`, { path: evidencePath, contentType: 'application/json' });
  };
}
