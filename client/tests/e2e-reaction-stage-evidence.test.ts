import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installReactionObservation, observedSocketEvent, persistedReaction, safeBrowserCounts, startReactionEvidence } from '../../e2e/helpers/reaction-stage-evidence';
type EvidencePage = Parameters<typeof startReactionEvidence>[0];
type FinishEvidence = Awaited<ReturnType<typeof startReactionEvidence>>;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.replaceChildren(); });
const snapshot = () => safeBrowserCounts((window as Window & { __bridgeReactionEvidence?: unknown }).__bridgeReactionEvidence);

describe('reaction evidence privacy and negative controls', () => {
  it('counts genuine quick-reaction clicks and existing reaction lifecycle events without altering callbacks', () => {
    cleanup = installReactionObservation();
    document.body.innerHTML = '<div class="msg-emoji-row"><button><span>emoji</span></button></div><button id="other">unrelated</button>';
    let productClicks = 0;
    document.querySelector('.msg-emoji-row button')!.addEventListener('click', () => productClicks++);
    (document.querySelector('.msg-emoji-row span') as HTMLElement).click();
    document.getElementById('other')!.click();
    for (const stage of ['dispatched', 'queued', 'applied', 'rejected', 'timeout']) {
      document.dispatchEvent(new CustomEvent(`bridge:message-operation-${stage}`, { detail: { kind: 'reaction-state', targetId: 'private-message', token: 'private-token' } }));
      document.dispatchEvent(new CustomEvent(`bridge:message-operation-${stage}`, { detail: { kind: 'delete-message' } }));
    }
    document.dispatchEvent(new Event('bridge:socket-ready'));
    document.dispatchEvent(new Event('bridge:socket-reconnected'));
    expect(productClicks).toBe(1);
    expect(snapshot()).toEqual({ quickReactionClicks: 1, dispatched: 1, queued: 1, applied: 1, rejected: 1, timeout: 1, socketReady: 1, socketReconnected: 1 });
    expect(JSON.stringify(snapshot())).not.toMatch(/private-message|private-token/);
    cleanup(); cleanup = undefined;
    document.dispatchEvent(new CustomEvent('bridge:message-operation-dispatched', { detail: { kind: 'reaction-state' } }));
    expect(snapshot().dispatched).toBe(1);
  });

  it('bounds counters and never exports extra browser fields or arbitrary values', () => {
    const report = safeBrowserCounts({ dispatched: 9999, queued: -1, timeout: Infinity, applied: NaN, rejected: 'private-token', socketReady: 1.9, privateToken: 'secret', nested: { user: 'private-user' } });
    expect(report).toEqual({ quickReactionClicks: 0, dispatched: 100, queued: 0, applied: 0, rejected: 0, timeout: 0, socketReady: 1, socketReconnected: 0 });
    expect(JSON.stringify(report)).not.toMatch(/private|secret|nested/);
    expect(safeBrowserCounts(null)).toEqual(safeBrowserCounts(undefined));
  });

  it('retains only allowlisted Socket.IO event names from real event-shaped frames', () => {
    expect(observedSocketEvent('42["message:react",{"messageId":"private","token":"secret"}]')).toBe('message:react');
    expect(observedSocketEvent('42123["message:reaction",{"reactions":{"emoji":["private-user"]}}]')).toBe('message:reaction');
    for (const input of ['42["private-event","secret"]', '43["message:react"]', '42/private,["message:react"]', '42{}', '42[broken', 'ping', '42["message:react","' + 'x'.repeat(65_536) + '"]']) {
      expect(observedSocketEvent(input)).toBeNull();
    }
  });

  it('checks only the target message and represents absent or malformed state as unknown', () => {
    expect(persistedReaction([{ _id: 'target', reactions: {} }, { _id: 'other', reactions: { emoji: ['private-user'] } }], 'target')).toBe(false);
    expect(persistedReaction({ messages: [{ _id: 'target', reactions: { emoji: ['private-user'] } }] }, 'target')).toBe(true);
    expect(persistedReaction([{ id: 'target', reactions: '{"emoji":["private-user"]}' }], 'target')).toBe(true);
    for (const data of [null, {}, [], { messages: [] }, [{ _id: 'other', reactions: {} }], [{ _id: 'target', reactions: 'broken' }], [{ _id: 'target', reactions: [] }]]) {
      expect(persistedReaction(data, 'target')).toBeNull();
    }
  });

  it('attaches a bounded report with authorized persisted state and no packet, token or identifier contents', async () => {
    const page = Object.assign(new EventEmitter(), {
      addInitScript: vi.fn(async () => { cleanup = installReactionObservation(); }),
      evaluate: vi.fn(async () => snapshot()),
    });
    const attach = await startReactionEvidence(page as unknown as EvidencePage);
    const socket = new EventEmitter();
    page.emit('websocket', socket);
    socket.emit('framesent', { payload: '42["message:react",{"messageId":"private-message","token":"private-token"}]' });
    socket.emit('framereceived', { payload: '42["message:reaction",{"messageId":"private-message","reactions":{"emoji":["private-user"]}}]' });
    socket.emit('framereceived', { payload: '42["private-event","private-content"]' });
    page.emit('pageerror', new Error('private-error'));
    const request = { get: vi.fn(async () => ({ status: () => 200, ok: () => true, json: async () => [{ _id: 'private-message', reactions: { emoji: ['private-user'] } }] })) };
    const info = { attach: vi.fn() };
    const target = { count: async () => 1, getAttribute: async () => 'private-message' };
    await attach(info as unknown as Parameters<FinishEvidence>[0], request as unknown as Parameters<FinishEvidence>[1], 'private-token', 'private-channel', target as unknown as Parameters<FinishEvidence>[4]);
    expect(request.get).toHaveBeenCalledExactlyOnceWith('/api/channels/private-channel/messages', { headers: { Authorization: 'Bearer private-token' }, timeout: 5000 });
    const serialized = info.attach.mock.calls[0][1].body as string;
    expect(serialized).not.toMatch(/private-|private-content|private-error/);
    const report = JSON.parse(serialized);
    expect(report.authoritative).toEqual({ readStatus: 200, persistedReaction: true });
    expect(report.websocket.packets['message:react'].sent).toBe(1);
    expect(report.websocket.packets['message:reaction'].received).toBe(1);
    expect(report.pageErrors).toBe(1);
    expect(report.unavailable).toEqual([]);

    request.get.mockRejectedValueOnce(new Error('private-read-error'));
    page.evaluate.mockRejectedValueOnce(new Error('private-browser-error'));
    await attach(info as unknown as Parameters<FinishEvidence>[0], request as unknown as Parameters<FinishEvidence>[1], 'private-token', 'private-channel', target as unknown as Parameters<FinishEvidence>[4]);
    const unavailable = info.attach.mock.calls[1][1].body as string;
    expect(unavailable).not.toMatch(/private-/);
    expect(JSON.parse(unavailable).authoritative.persistedReaction).toBeNull();
    expect(JSON.parse(unavailable).unavailable).toEqual(['browser-observation', 'authoritative-read']);
  });
});
