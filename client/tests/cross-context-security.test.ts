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

  it('built service-worker runtime enforces notification and credential-bearing URL authority', async () => {
    const runtime = read('sw.js');
    const handlers = new Map<string, (event: any) => void>();
    const opened: string[] = [];
    const queued: Array<{ url: string }> = [];
    let databaseOpens = 0;

    const database = {
      transaction: () => {
        const transaction: any = {};
        transaction.objectStore = () => ({
          add: (item: { url: string }) => {
            queued.push(item);
            queueMicrotask(() => transaction.oncomplete?.());
          },
        });
        return transaction;
      },
    };
    const indexedDB = {
      open: () => {
        databaseOpens++;
        const request: any = {};
        queueMicrotask(() => {
          request.result = database;
          request.onsuccess?.();
        });
        return request;
      },
    };
    const worker = {
      location: { origin: 'https://bridge.test' },
      addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
      clients: {
        matchAll: async () => [],
        openWindow: async (url: string) => { opened.push(url); return null; },
      },
      registration: {
        sync: { register: async () => undefined },
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
    const outboxBody = { content: 'hello' };
    for (const url of [
      'https://evil.example/api/messages',
      'javascript:alert(1)',
      '/not-api/messages',
    ]) {
      message?.({ data: { type: 'OUTBOX_ADD', url, body: outboxBody, token: 'secret' } });
    }
    expect(databaseOpens).toBe(0);

    message?.({
      data: {
        type: 'OUTBOX_ADD',
        url: 'https://bridge.test/api/messages?channel=1#fragment',
        body: outboxBody,
        token: 'secret',
      },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(databaseOpens).toBe(1);
    expect(queued).toEqual([expect.objectContaining({ url: '/api/messages?channel=1#fragment' })]);

    const notificationClick = handlers.get('notificationclick');
    expect(notificationClick).toBeTypeOf('function');
    const click = async (url: string): Promise<void> => {
      let completion: Promise<unknown> = Promise.resolve();
      notificationClick?.({
        action: '',
        notification: { data: { url }, close: () => undefined },
        waitUntil: (value: Promise<unknown>) => { completion = value; },
      });
      await completion;
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
