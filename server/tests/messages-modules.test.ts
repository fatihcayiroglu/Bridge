// server/tests/messages-modules.test.ts
// Sprint 107: messages.ts modülarizasyon — barrel export doğrulaması + tip testleri
// Bu dosya modüllerin doğru dışa aktarıldığını ve tiplerin uyumlu olduğunu doğrular.

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../socket/handlers/messages-send', () => ({ registerSendHandlers: jest.fn() }));
jest.mock('../socket/handlers/messages-edit', () => ({ registerEditHandlers: jest.fn() }));

import { systemMsg, formatDuration, registerMessageHandlers, registerThreadSocketEvents } from '../socket/handlers/messages';
import type { AuthUser, SendMessagePayload, SocketUser } from '../socket/handlers/messages-types';

// ── Barrel export doğrulaması ────────────────────────────────
describe('messages barrel export', () => {
  test('systemMsg export edilmiş', () => {
    expect(typeof systemMsg).toBe('function');
  });

  test('formatDuration export edilmiş', () => {
    expect(typeof formatDuration).toBe('function');
  });

  test('registerMessageHandlers export edilmiş', () => {
    expect(typeof registerMessageHandlers).toBe('function');
  });

  test('registerThreadSocketEvents export edilmiş', () => {
    expect(typeof registerThreadSocketEvents).toBe('function');
  });
});

// ── systemMsg ────────────────────────────────────────────────
describe('systemMsg', () => {
  test('doğru alanları döndürür', () => {
    const msg = systemMsg('ch1', 'srv1', 'Test mesajı');
    expect(msg.channelId).toBe('ch1');
    expect(msg.serverId).toBe('srv1');
    expect(msg.content).toBe('Test mesajı');
    expect(msg.type).toBe('system');
    expect(msg.userId).toBe('system');
    expect(msg.username).toBe('Bridge Bot');
    expect(typeof msg._id).toBe('string');
    expect(typeof msg.createdAt).toBe('number');
  });

  test('her çağrıda benzersiz _id üretir', () => {
    const msg1 = systemMsg('ch1', 'srv1', 'A');
    const msg2 = systemMsg('ch1', 'srv1', 'A');
    expect(msg1._id).not.toBe(msg2._id);
  });
});

// ── formatDuration ───────────────────────────────────────────
describe('formatDuration', () => {
  test('0 saniye → ?:??', () => {
    expect(formatDuration(0)).toBe('?:??');
  });

  test('90 saniye → 1:30', () => {
    expect(formatDuration(90)).toBe('1:30');
  });

  test('65 saniye → 1:05 (sıfır dolgu)', () => {
    expect(formatDuration(65)).toBe('1:05');
  });

  test('3600 saniye → 60:00', () => {
    expect(formatDuration(3600)).toBe('60:00');
  });

  test('59 saniye → 0:59', () => {
    expect(formatDuration(59)).toBe('0:59');
  });
});

// ── Tip uyumluluk testleri (derleme zamanı doğrulaması) ──────
describe('type compatibility', () => {
  test('AuthUser tipi doğru alanları içeriyor', () => {
    const user: AuthUser = {
      _id: 'u1',
      username: 'testuser',
      displayName: 'Test User',
      avatarColor: '#2d9cdb',
    };
    expect(user._id).toBeDefined();
    expect(user.username).toBeDefined();
    expect(user.displayName).toBeDefined();
    expect(user.avatarColor).toBeDefined();
  });

  test('SendMessagePayload zorunlu alanlar', () => {
    const payload: SendMessagePayload = {
      channelId: 'ch1',
      content: 'merhaba',
      serverId: 'srv1',
    };
    expect(payload.channelId).toBeDefined();
    expect(payload.serverId).toBeDefined();
  });

  test('SendMessagePayload E2EE opsiyonel alanlar', () => {
    const payload: SendMessagePayload = {
      channelId: 'ch1',
      serverId: 'srv1',
      type: 'e2ee',
      encryptedContent: 'base64data',
      iv: 'base64iv',
      ackId: 'ack-123',
      _tmpId: 'tmp-456',
    };
    expect(payload.type).toBe('e2ee');
    expect(payload.encryptedContent).toBeDefined();
    expect(payload.iv).toBeDefined();
  });
});
