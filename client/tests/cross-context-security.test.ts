import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const CLIENT = path.resolve(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(CLIENT, ...parts), 'utf8');

describe('cross-context security boundaries', () => {
  it.each(['watch-together', 'chess', 'draw-together'])(
    '%s accepts Bridge control messages only from its same-origin parent',
    (activity) => {
      const src = read('activities', activity, 'index.html');
      expect(src).toContain('if (e.source !== parent || e.origin !== location.origin) return;');
      expect(src).toContain('parent.postMessage(message, location.origin);');
      expect(src).not.toMatch(/parent\.postMessage\([^;]*,\s*['"]\*['"]\s*\)/s);
    },
  );

  it('service worker constrains notification navigation and credential-bearing outbox URLs', () => {
    const src = read('sw.ts');
    expect(src).toContain('url.origin !== worker.location.origin');
    expect(src).toContain("url.protocol !== 'http:' && url.protocol !== 'https:'");
    expect(src).toContain("apiOnly && !url.pathname.startsWith('/api/')");
    expect(src).toContain('safeSameOriginUrl(data.url, { apiOnly: true })');
    expect(src).not.toMatch(/url:\s*data\.url\b/);
  });

  it('built service-worker runtime ignores legacy outbox injection and wakes only page replay owners', async () => {
    const runtime = read('sw.js');
    const handlers = new Map<string, (event: any) => void>();
    const opened: string[] = [];
    const clientMessages: unknown[] = [];
    let databaseOpens = 0;
    let windowClients: Array<{ postMessage(message: unknown): void }> = [];

    const indexedDB = {
      open: () => {
        databaseOpens++;
        const request: any = {};
        queueMicrotask(() => request.onerror?.());
        return request;
      },
    };
    const worker = {
      location: { origin: 'https://bridge.test' },
      addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
      clients: {
        matchAll: async () => windowClients,
        openWindow: async (url: string) => { opened.push(url); return null; },
        claim: async () => undefined,
      },
      registration: {
        getNotifications: async () => [],
        showNotification: async () => undefined,
      },
      skipWaiting: async () => undefined,
    };

    vm.runInNewContext(runtime, {
      self: worker,
      URL,
      indexedDB,
      queueMicrotask,
      setTimeout,
      clearTimeout,
    });

    const message = handlers.get('message');
    expect(message).toBeTypeOf('function');
    message?.({
      data: {
        type: 'OUTBOX_ADD',
        url: 'https://bridge.test/api/messages',
        body: { content: 'must not be queued' },
        token: 'secret',
      },
    });
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(databaseOpens).toBe(0);

    const sync = handlers.get('sync');
    expect(sync).toBeTypeOf('function');
    windowClients = [{ postMessage: (value: unknown) => { clientMessages.push(value); } }];
    let completion: Promise<unknown> = Promise.resolve();
    sync?.({
      tag: 'bridge-local-first-replay',
      waitUntil: (value: Promise<unknown>) => { completion = value; },
    });
    await completion;
    expect(clientMessages).toContainEqual({
      type: 'SW_LOCAL_FIRST_REPLAY',
      reason: 'background-sync',
    });

    windowClients = [];
    const notificationClick = handlers.get('notificationclick');
    expect(notificationClick).toBeTypeOf('function');
    const click = async (url: string): Promise<void> => {
      let clickCompletion: Promise<unknown> = Promise.resolve();
      notificationClick?.({
        action: '',
        notification: { data: { url }, close: () => undefined },
        waitUntil: (value: Promise<unknown>) => { clickCompletion = value; },
      });
      await clickCompletion;
    };
    await click('https://evil.example/phish');
    await click('https://bridge.test/channels/one?focus=2#message');
    expect(opened).toEqual(['/', '/channels/one?focus=2#message']);
  });

  it.each(['index.html', 'index.dist.html'])(
    '%s revalidates service-worker notification URLs before navigation',
    (name) => {
      const src = read(name);
      expect(src).toContain("target.origin !== window.location.origin");
      expect(src).toContain("target.protocol !== 'http:' && target.protocol !== 'https:'");
      expect(src).not.toContain('window.location.href = e.data.url');
    },
  );
});
