// client/tests/DmCallPanel.test.ts
// Sprint 115 — DmCallPanel birim testleri
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import DmCallPanel from '../js/core/DmCallPanel.svelte';
import { BridgeRegistry as _BridgeRegistry } from '../js/core/bridge-registry.js';

// Faz 12 — CJS `require()` KALDIRILDI.
//
// Bu dosya mock'lanmış modüle `require('../js/core/bridge-registry.js')` ile
// erişiyordu. Vite `import` ifadelerini çözümleyip `.js` → `.ts` eşler, ancak
// çalışma zamanındaki `require()` dönüştürülmez: Node'un CJS çözümleyicisi
// literal `bridge-registry.js` arar ve kaynak `.ts` olduğu için bulamaz.
// Sonuç: dosyadaki 9 test "Cannot find module" ile düşüyordu.
//
// `vi.mock` derleme sırasında hoist edildiğinden, aşağıdaki STATİK import
// zaten mock'lanmış modülü alır. Sahte bir `.js` dosyası eklenmedi.
const BridgeRegistry = _BridgeRegistry as unknown as {
  get: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
};

// Mock BridgeRegistry
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    get: vi.fn((key: string) => {
      if (key === 'socket') return {
        on: vi.fn(), off: vi.fn(), emit: vi.fn(),
      };
      return null;
    }),
    call: vi.fn(),
    register: vi.fn(),
    // Completed against the canonical BridgeRegistry surface (register /
    // unregister / call / get / has); a missing member throws before any
    // assertion runs.
    unregister: vi.fn(),
    has: vi.fn(() => false),
  },
}));

// Mock getUserMedia
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn().mockResolvedValue({
      getTracks: () => [{ kind: 'audio', enabled: true, stop: vi.fn() }],
      getAudioTracks: () => [{ enabled: true, stop: vi.fn() }],
      getVideoTracks: () => [],
    }),
    getDisplayMedia: vi.fn(),
  },
  configurable: true,
});

// Mock RTCPeerConnection
globalThis.RTCPeerConnection = vi.fn().mockImplementation(() => ({
  addTrack: vi.fn(),
  createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-sdp' }),
  setLocalDescription: vi.fn().mockResolvedValue(undefined),
  setRemoteDescription: vi.fn().mockResolvedValue(undefined),
  createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-sdp' }),
  addIceCandidate: vi.fn().mockResolvedValue(undefined),
  getSenders: vi.fn().mockReturnValue([]),
  close: vi.fn(),
  ontrack: null,
  onicecandidate: null,
})) as unknown as typeof RTCPeerConnection;

globalThis.RTCSessionDescription = vi.fn().mockImplementation((d: RTCSessionDescriptionInit) => d) as unknown as typeof RTCSessionDescription;
globalThis.RTCIceCandidate = vi.fn().mockImplementation((c: RTCIceCandidateInit) => c) as unknown as typeof RTCIceCandidate;

describe('DmCallPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('başlangıçta görünmez (idle state)', () => {
    const { container } = render(DmCallPanel);
    expect(container.querySelector('.dm-call-overlay')).toBeNull();
  });

  it('onMount BridgeRegistry kayıtları yapılır', () => {
    render(DmCallPanel);
    expect(BridgeRegistry.register).toHaveBeenCalledWith('startDmCall', expect.any(Function));
    expect(BridgeRegistry.register).toHaveBeenCalledWith('hangUpDmCall', expect.any(Function));
  });

  it('socket listener\'lar bağlanır', () => {
    const mockSocket = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
    BridgeRegistry.get.mockImplementation((key: string) => key === 'socket' ? mockSocket : null);
    render(DmCallPanel);
    // FAZ 8/1 — `dm:call:answered` BEKLENTISI KALDIRILDI.
    // Sunucu boyle bir olay HIC YAYMAZ (`socket/handlers/dm.ts`); onu
    // dinlemek, kabul akisinin sessizce olmesinin ta kendisiydi. Panel artik
    // sunucunun GERCEKTEN yaydigi olaylari dinler.
    for (const event of [
      'dm:call:incoming', 'dm:call:outgoing', 'dm:call:accepted', 'dm:call:ready',
      'dm:call:offer', 'dm:call:answer', 'dm:call:ice', 'dm:call:declined',
      'dm:call:missed', 'dm:call:ended',
    ]) {
      expect(mockSocket.on).toHaveBeenCalledWith(event, expect.any(Function));
    }
    expect(mockSocket.on).not.toHaveBeenCalledWith('dm:call:answered', expect.any(Function));
  });

  it('onDestroy socket listener\'lar kaldırılır', () => {
    const mockSocket = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
    BridgeRegistry.get.mockImplementation((key: string) => key === 'socket' ? mockSocket : null);
    const { unmount } = render(DmCallPanel);
    unmount();
    expect(mockSocket.off).toHaveBeenCalledWith('dm:call:incoming', expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith('dm:call:ended', expect.any(Function));
  });

  it('gelen arama overlay\'i gösterir', async () => {
    let incomingHandler: Function;
    const mockSocket = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'dm:call:incoming') incomingHandler = handler;
      }),
      off: vi.fn(), emit: vi.fn(),
    };
    BridgeRegistry.get.mockImplementation((key: string) => key === 'socket' ? mockSocket : null);
    const { container } = render(DmCallPanel);
    incomingHandler!({ callId: 'test-1', callerId: 'user-2', type: 'voice', callerName: 'Alice' });
    await waitFor(() => {
      expect(container.querySelector('.dm-call-overlay')).not.toBeNull();
    });
  });

  it('gelen arama "kabul et" ve "reddet" butonlarını gösterir', async () => {
    let incomingHandler: Function;
    const mockSocket = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'dm:call:incoming') incomingHandler = handler;
      }),
      off: vi.fn(), emit: vi.fn(),
    };
    BridgeRegistry.get.mockImplementation((key: string) => key === 'socket' ? mockSocket : null);
    const { container } = render(DmCallPanel);
    incomingHandler!({ callId: 'test-1', callerId: 'user-2', type: 'voice', callerName: 'Alice' });
    await waitFor(() => {
      expect(container.querySelector('.dm-btn-accept')).not.toBeNull();
      expect(container.querySelector('.dm-btn-reject')).not.toBeNull();
    });
  });

  it('reddet butonuna tıklayınca socket event emit edilir ve overlay kapanır', async () => {
    let incomingHandler: Function;
    const mockSocket = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'dm:call:incoming') incomingHandler = handler;
      }),
      off: vi.fn(), emit: vi.fn(),
    };
    BridgeRegistry.get.mockImplementation((key: string) => key === 'socket' ? mockSocket : null);
    const { container } = render(DmCallPanel);
    incomingHandler!({ callId: 'call-xyz', callerId: 'user-2', type: 'voice', callerName: 'Bob' });
    await waitFor(() => container.querySelector('.dm-btn-reject'));
    fireEvent.click(container.querySelector('.dm-btn-reject')!);
    // FAZ 8/1 — REDDETME kendi olayidir. `dm:call:end` KURULMUS bir gorusmeyi
    // kapatir; henuz kabul edilmemis bir cagri icin arayan tarafta hicbir
    // geri bildirim uretmezdi. `dm:call:decline` arayana `declined` yayar.
    expect(mockSocket.emit).toHaveBeenCalledWith('dm:call:decline', { callId: 'call-xyz' });
    await waitFor(() => {
      expect(container.querySelector('.dm-call-overlay')).toBeNull();
    }, { timeout: 3000 });
  });

  it('video aramasında video elementleri render edilir', async () => {
    let incomingHandler: Function;
    const mockSocket = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'dm:call:incoming') incomingHandler = handler;
      }),
      off: vi.fn(), emit: vi.fn(),
    };
    BridgeRegistry.get.mockImplementation((key: string) => key === 'socket' ? mockSocket : null);
    const { container } = render(DmCallPanel);
    incomingHandler!({ callId: 'call-v', callerId: 'user-3', type: 'video', callerName: 'Charlie' });
    await waitFor(() => {
      expect(container.querySelectorAll('video').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('voice aramasında avatar gösterilir, video elementi yok', async () => {
    let incomingHandler: Function;
    const mockSocket = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'dm:call:incoming') incomingHandler = handler;
      }),
      off: vi.fn(), emit: vi.fn(),
    };
    BridgeRegistry.get.mockImplementation((key: string) => key === 'socket' ? mockSocket : null);
    const { container } = render(DmCallPanel);
    incomingHandler!({ callId: 'call-v2', callerId: 'user-4', type: 'voice', callerName: 'Dave' });
    await waitFor(() => {
      expect(container.querySelector('.dm-call-avatar-wrap')).not.toBeNull();
      expect(container.querySelector('.dm-call-video-wrap')).toBeNull();
    });
  });

  it('ARIA dialog attribute\'ları doğru', async () => {
    let incomingHandler: Function;
    const mockSocket = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'dm:call:incoming') incomingHandler = handler;
      }),
      off: vi.fn(), emit: vi.fn(),
    };
    BridgeRegistry.get.mockImplementation((key: string) => key === 'socket' ? mockSocket : null);
    const { container } = render(DmCallPanel);
    incomingHandler!({ callId: 'call-a11y', callerId: 'user-5', type: 'voice', callerName: 'Eve' });
    await waitFor(() => {
      const dialog = container.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
    });
  });
});
