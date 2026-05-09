// client/tests/socket-events.test.js — Bridge v74
// Socket event wiring testleri (client tarafı)

'use strict';

describe('Socket stub', () => {
  let socketStub;

  beforeEach(() => {
    socketStub = global.io();
  });

  test('io() stub socket nesnesini döndürür', () => {
    expect(socketStub).toBeDefined();
    expect(typeof socketStub.on).toBe('function');
    expect(typeof socketStub.emit).toBe('function');
  });

  test('emit çağrısı kaydedilir', () => {
    socketStub.emit('message:send', { content: 'merhaba' });
    expect(socketStub.emit).toHaveBeenCalledWith('message:send', { content: 'merhaba' });
  });

  test('on ile kaydedilen handler _trigger ile tetiklenir', () => {
    const handler = jest.fn();
    socketStub.on('new-message', handler);
    socketStub._trigger('new-message', { content: 'test' });
    expect(handler).toHaveBeenCalledWith({ content: 'test' });
  });
});

// ── apiFetch stub ─────────────────────────────────────────────
describe('apiFetch() stub', () => {
  beforeEach(() => {
    global.apiFetch.mockClear();
  });

  test('başarılı yanıt döndürür', async () => {
    global.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: [], hasMore: false }),
      status: 200,
    });

    const res = await global.apiFetch('/api/channels/123/messages');
    const data = await res.json();
    expect(data.messages).toEqual([]);
  });

  test('hata durumunda ok: false döndürebilir', async () => {
    global.apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'Forbidden' }),
    });

    const res = await global.apiFetch('/api/channels/secret');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });
});
