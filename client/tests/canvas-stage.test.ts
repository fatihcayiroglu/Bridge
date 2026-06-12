// client/tests/canvas-stage.test.ts
// Sprint 69 — Client canvas & stage modülleri için ilk test kapsamı
// Ortam: vitest + happy-dom (vitest.config.ts'de environment:'happy-dom')

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── canvas.ts mock kurulumu ───────────────────────────────────────────────────
// canvas.ts global bir SocketLike'a ve BridgeRegistry'ye bağımlı;
// bunları stub ederek modülü izole ediyoruz.

const mockSocketEmit = vi.fn();
const mockSocketOn   = vi.fn();

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: { get: vi.fn(() => null) },
}));

vi.mock('../js/core/globals.js', () => ({
  getSocket:        vi.fn(() => ({ emit: mockSocketEmit, on: mockSocketOn })),
  getMe:            vi.fn(() => ({ _id: 'user-1', displayName: 'Tester' })),
  getCurrentServer: vi.fn(() => ({ _id: 'server-1' })),
}));

// Canvas API mock (jsdom / happy-dom doesn't implement canvas 2D)
class MockCanvasRenderingContext2D {
  clearRect = vi.fn();
  beginPath = vi.fn();
  moveTo    = vi.fn();
  lineTo    = vi.fn();
  stroke    = vi.fn();
  fill      = vi.fn();
  arc       = vi.fn();
  rect      = vi.fn();
  fillText  = vi.fn();
  save      = vi.fn();
  restore   = vi.fn();
  strokeStyle = '';
  lineWidth   = 1;
  lineCap     = 'butt';
  lineJoin    = 'miter';
  globalAlpha = 1;
  font        = '';
  fillStyle   = '';
}

// Patch HTMLCanvasElement.getContext
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: vi.fn(() => new MockCanvasRenderingContext2D()),
  configurable: true,
});

// ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────────

/** Minimal Canvas socket event payload oluşturur */
function strokePayload(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 'ch-1',
    stroke: {
      id:     'stroke-abc',
      tool:   'pen',
      color:  '#ff0000',
      width:  3,
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      userId: 'user-1',
      ...overrides,
    },
    ...overrides,
  };
}

// ── validateSocketPayload integration tests ───────────────────────────────────
// Bu testler validate.ts'i doğrudan import ederek yeni schema'ları denetler.

import { validateSocketPayload, socketSchemas } from '../../server/middleware/validate';

describe('socketSchemas — canvas', () => {
  describe('canvasChannelId', () => {
    it('accepts valid channelId', () => {
      expect(validateSocketPayload({ channelId: 'ch-1' }, socketSchemas.canvasChannelId).valid).toBe(true);
    });

    it('rejects missing channelId', () => {
      const r = validateSocketPayload({}, socketSchemas.canvasChannelId);
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => /channelId/i.test(e))).toBe(true);
    });

    it('rejects empty string channelId', () => {
      expect(validateSocketPayload({ channelId: '' }, socketSchemas.canvasChannelId).valid).toBe(false);
    });

    it('rejects channelId longer than 64 chars', () => {
      expect(validateSocketPayload({ channelId: 'x'.repeat(65) }, socketSchemas.canvasChannelId).valid).toBe(false);
    });
  });

  describe('canvasDraw', () => {
    it('accepts valid draw payload', () => {
      expect(validateSocketPayload({ channelId: 'ch-1', stroke: { id: 's1', tool: 'pen' } }, socketSchemas.canvasDraw).valid).toBe(true);
    });

    it('rejects missing stroke field', () => {
      expect(validateSocketPayload({ channelId: 'ch-1' }, socketSchemas.canvasDraw).valid).toBe(false);
    });

    it('rejects non-object stroke', () => {
      // stroke must be an object; a string should fail
      expect(validateSocketPayload({ channelId: 'ch-1', stroke: 'bad' }, socketSchemas.canvasDraw).valid).toBe(false);
    });
  });

  describe('canvasStrokeDelete', () => {
    it('accepts valid stroke-delete payload', () => {
      expect(validateSocketPayload({ channelId: 'ch-1', strokeId: 'sid-1' }, socketSchemas.canvasStrokeDelete).valid).toBe(true);
    });

    it('rejects missing strokeId', () => {
      expect(validateSocketPayload({ channelId: 'ch-1' }, socketSchemas.canvasStrokeDelete).valid).toBe(false);
    });
  });
});

describe('socketSchemas — stage', () => {
  describe('stageChannelId', () => {
    it('accepts valid channelId', () => {
      expect(validateSocketPayload({ channelId: 'ch-2' }, socketSchemas.stageChannelId).valid).toBe(true);
    });

    it('rejects missing channelId', () => {
      expect(validateSocketPayload({}, socketSchemas.stageChannelId).valid).toBe(false);
    });
  });

  describe('stageSetRole', () => {
    it('accepts speaker role', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', role: 'speaker' }, socketSchemas.stageSetRole).valid).toBe(true);
    });

    it('accepts listener role', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', role: 'listener' }, socketSchemas.stageSetRole).valid).toBe(true);
    });

    it('rejects invalid role', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', role: 'moderator' }, socketSchemas.stageSetRole).valid).toBe(false);
    });

    it('rejects missing role', () => {
      expect(validateSocketPayload({ channelId: 'ch-2' }, socketSchemas.stageSetRole).valid).toBe(false);
    });
  });

  describe('stageUpdateMute', () => {
    it('accepts true muted value', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', muted: true }, socketSchemas.stageUpdateMute).valid).toBe(true);
    });

    it('accepts false muted value', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', muted: false }, socketSchemas.stageUpdateMute).valid).toBe(true);
    });

    it('rejects string muted value', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', muted: 'yes' }, socketSchemas.stageUpdateMute).valid).toBe(false);
    });

    it('rejects missing muted field', () => {
      expect(validateSocketPayload({ channelId: 'ch-2' }, socketSchemas.stageUpdateMute).valid).toBe(false);
    });
  });

  describe('stageSpeaking', () => {
    it('accepts boolean speaking', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', speaking: true }, socketSchemas.stageSpeaking).valid).toBe(true);
    });

    it('rejects non-boolean speaking', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', speaking: 1 }, socketSchemas.stageSpeaking).valid).toBe(false);
    });
  });

  describe('stageHandRaise', () => {
    it('accepts boolean raised', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', raised: false }, socketSchemas.stageHandRaise).valid).toBe(true);
    });
  });

  describe('stageTarget (promote/demote)', () => {
    it('accepts valid promote payload', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', targetUserId: 'u-99' }, socketSchemas.stageTarget).valid).toBe(true);
    });

    it('rejects missing targetUserId', () => {
      expect(validateSocketPayload({ channelId: 'ch-2' }, socketSchemas.stageTarget).valid).toBe(false);
    });
  });

  describe('stageSetTopic', () => {
    it('accepts topic up to 200 chars', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', topic: 'Hello stage' }, socketSchemas.stageSetTopic).valid).toBe(true);
    });

    it('rejects topic over 200 chars', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', topic: 'x'.repeat(201) }, socketSchemas.stageSetTopic).valid).toBe(false);
    });

    it('accepts missing topic (optional field)', () => {
      expect(validateSocketPayload({ channelId: 'ch-2' }, socketSchemas.stageSetTopic).valid).toBe(true);
    });
  });

  describe('stageSetLive', () => {
    it('accepts boolean live', () => {
      expect(validateSocketPayload({ channelId: 'ch-2', live: true }, socketSchemas.stageSetLive).valid).toBe(true);
    });

    it('rejects missing live field', () => {
      expect(validateSocketPayload({ channelId: 'ch-2' }, socketSchemas.stageSetLive).valid).toBe(false);
    });
  });
});

// ── DM socket schemas ─────────────────────────────────────────────────────────

describe('socketSchemas — dm', () => {
  describe('dmSend', () => {
    it('accepts valid DM payload', () => {
      expect(validateSocketPayload({ toUserId: 'u-2', content: 'Hello!' }, socketSchemas.dmSend).valid).toBe(true);
    });

    it('rejects missing toUserId', () => {
      expect(validateSocketPayload({ content: 'Hello!' }, socketSchemas.dmSend).valid).toBe(false);
    });

    it('rejects missing content', () => {
      expect(validateSocketPayload({ toUserId: 'u-2' }, socketSchemas.dmSend).valid).toBe(false);
    });

    it('rejects content over 20000 chars', () => {
      expect(validateSocketPayload({ toUserId: 'u-2', content: 'x'.repeat(20_001) }, socketSchemas.dmSend).valid).toBe(false);
    });
  });

  describe('dmReact', () => {
    it('accepts valid reaction payload', () => {
      expect(validateSocketPayload({ messageId: 'm-1', dmId: 'dm-1', emoji: '👍' }, socketSchemas.dmReact).valid).toBe(true);
    });

    it('rejects emoji over 16 chars', () => {
      expect(validateSocketPayload({ messageId: 'm-1', dmId: 'dm-1', emoji: '👍'.repeat(10) }, socketSchemas.dmReact).valid).toBe(false);
    });
  });

  describe('dmCallStart', () => {
    it('accepts voice call', () => {
      expect(validateSocketPayload({ toUserId: 'u-2', type: 'voice' }, socketSchemas.dmCallStart).valid).toBe(true);
    });

    it('accepts video call', () => {
      expect(validateSocketPayload({ toUserId: 'u-2', type: 'video' }, socketSchemas.dmCallStart).valid).toBe(true);
    });

    it('rejects invalid call type', () => {
      expect(validateSocketPayload({ toUserId: 'u-2', type: 'screen' }, socketSchemas.dmCallStart).valid).toBe(false);
    });

    it('accepts missing type (optional — defaults to voice in handler)', () => {
      expect(validateSocketPayload({ toUserId: 'u-2' }, socketSchemas.dmCallStart).valid).toBe(true);
    });
  });

  describe('dmCallId', () => {
    it('accepts valid callId', () => {
      expect(validateSocketPayload({ callId: 'call-xyz' }, socketSchemas.dmCallId).valid).toBe(true);
    });

    it('rejects missing callId', () => {
      expect(validateSocketPayload({}, socketSchemas.dmCallId).valid).toBe(false);
    });
  });

  describe('gdmSend', () => {
    it('accepts valid group DM payload', () => {
      expect(validateSocketPayload({ groupId: 'g-1', content: 'Hi group' }, socketSchemas.gdmSend).valid).toBe(true);
    });

    it('rejects content over 2000 chars', () => {
      expect(validateSocketPayload({ groupId: 'g-1', content: 'x'.repeat(2001) }, socketSchemas.gdmSend).valid).toBe(false);
    });
  });

  describe('gdmCallState', () => {
    it('accepts valid state with both flags', () => {
      expect(validateSocketPayload({ groupId: 'g-1', muted: true, video: false }, socketSchemas.gdmCallState).valid).toBe(true);
    });

    it('rejects non-boolean muted', () => {
      expect(validateSocketPayload({ groupId: 'g-1', muted: 'yes', video: false }, socketSchemas.gdmCallState).valid).toBe(false);
    });
  });
});

// ── validateSocketPayload — genel edge-case'ler ───────────────────────────────

describe('validateSocketPayload — generic edge cases', () => {
  it('rejects null payload', () => {
    expect(validateSocketPayload(null, socketSchemas.stageChannelId).valid).toBe(false);
  });

  it('rejects non-object payload (string)', () => {
    expect(validateSocketPayload('bad', socketSchemas.stageChannelId).valid).toBe(false);
  });

  it('rejects non-object payload (number)', () => {
    expect(validateSocketPayload(42, socketSchemas.stageChannelId).valid).toBe(false);
  });

  it('returns errors array with descriptive messages', () => {
    const result = validateSocketPayload({}, socketSchemas.stageTarget);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every(e => typeof e === 'string')).toBe(true);
  });
});
