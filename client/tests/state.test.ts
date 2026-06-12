// client/tests/state.test.ts — Sprint 79
// core/state.ts için unit testler
// Kapsam: BridgeState.state (Proxy), setState, subscribe, initState, wildcard

'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetCurrentUser = jest.fn(() => null);

jest.mock('../js/core/logger.js', () => ({
  createLogger: () => ({
    log:   jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}), { virtual: true });

jest.mock('../js/core/globals.js', () => ({
  getMe:           mockGetCurrentUser,
  getCurrentUser:  mockGetCurrentUser,
}), { virtual: true });

// ── Module loader ─────────────────────────────────────────────────────────────

function loadModule() {
  jest.resetModules();
  jest.mock('../js/core/logger.js', () => ({
    createLogger: () => ({
      log:   jest.fn(),
      info:  jest.fn(),
      warn:  jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  }), { virtual: true });
  jest.mock('../js/core/globals.js', () => ({
    getMe:          mockGetCurrentUser,
    getCurrentUser: mockGetCurrentUser,
  }), { virtual: true });
  return require('../js/core/state');
}

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function freshModule() {
  // localStorage temizle
  localStorage.clear();
  // window globals sıfırla
  delete (window as Record<string,unknown>).token;
  delete (window as Record<string,unknown>).currentUser;
  delete (window as Record<string,unknown>).currentServer;
  delete (window as Record<string,unknown>).currentChannel;
  return loadModule();
}

// ── state Proxy ───────────────────────────────────────────────────────────────

describe('state Proxy', () => {
  test('doğrudan atama yapılamaz — Proxy engeller', () => {
    const { state } = freshModule();
    // Proxy'nin set trap'i false döndürür — strict modda TypeError fırlatır
    // ama jest jsdom ortamı strict olmayabilir; kontrol şöyle:
    const before = state.currentUser;
    try {
      // @ts-expect-error — test amacıyla
      state.currentUser = { id: 'hack' };
    } catch { /* bekleniyor */ }
    // Değer değişmemiş olmalı (proxy engelledi)
    expect(state.currentUser).toEqual(before);
  });

  test('setState ile güncelleme yapılabilir', () => {
    const { state, setState } = freshModule();
    setState({ sidebarCollapsed: true });
    expect(state.sidebarCollapsed).toBe(true);
  });

  test('mevcut olmayan alan setState ile eklenmez', () => {
    const { setState, state } = freshModule();
    // TypeScript tipi bunu engeller; runtime'da uyarı üretir
    setState({ unknownField: 'x' } as never);
    expect((state as Record<string,unknown>).unknownField).toBeUndefined();
  });
});

// ── setState ──────────────────────────────────────────────────────────────────

describe('setState', () => {
  test('token güncellenince window.token de güncellenir', () => {
    const { setState } = freshModule();
    setState({ token: 'abc123' });
    expect((window as Record<string,unknown>).token).toBe('abc123');
  });

  test('token güncellenince localStorage\'a yazılır', () => {
    const { setState } = freshModule();
    setState({ token: 'mytoken' });
    expect(localStorage.getItem('token')).toBe('mytoken');
  });

  test('aynı değer tekrar set edilince subscriber tetiklenmez', () => {
    const { setState, subscribe } = freshModule();
    setState({ mobileView: false });
    const cb = jest.fn();
    subscribe('mobileView', cb);
    setState({ mobileView: false }); // aynı değer
    expect(cb).not.toHaveBeenCalled();
  });

  test('farklı değer set edilince subscriber tetiklenir', () => {
    const { setState, subscribe } = freshModule();
    const cb = jest.fn();
    subscribe('mobileView', cb);
    setState({ mobileView: true });
    expect(cb).toHaveBeenCalledWith(true, false);
  });

  test('çoklu alan tek çağrıda güncellenir', () => {
    const { setState, state } = freshModule();
    setState({ sidebarCollapsed: true, mobileView: true });
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.mobileView).toBe(true);
  });
});

// ── subscribe ─────────────────────────────────────────────────────────────────

describe('subscribe', () => {
  test('unsubscribe fonksiyonu döndürür', () => {
    const { subscribe, setState } = freshModule();
    const cb = jest.fn();
    const unsub = subscribe('sidebarCollapsed', cb);
    expect(typeof unsub).toBe('function');
    unsub();
    setState({ sidebarCollapsed: true });
    expect(cb).not.toHaveBeenCalled();
  });

  test('aynı key için birden fazla subscriber desteklenir', () => {
    const { subscribe, setState } = freshModule();
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    subscribe('voiceConnected', cb1);
    subscribe('voiceConnected', cb2);
    setState({ voiceConnected: true });
    expect(cb1).toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
  });

  test('subscriber içindeki hata diğer subscriber\'ları etkilemez', () => {
    const { subscribe, setState } = freshModule();
    const cb1 = jest.fn().mockImplementation(() => { throw new Error('boom'); });
    const cb2 = jest.fn();
    subscribe('mobileView', cb1);
    subscribe('mobileView', cb2);
    // Hata yutulur, cb2 çağrılır
    expect(() => setState({ mobileView: true })).not.toThrow();
    expect(cb2).toHaveBeenCalled();
  });
});

// ── wildcard subscribe ────────────────────────────────────────────────────────

describe('wildcard subscribe (*)', () => {
  test('herhangi bir alan değişince çağrılır', () => {
    const { subscribe, setState } = freshModule();
    const cb = jest.fn();
    subscribe('*', cb);
    setState({ sidebarCollapsed: true });
    expect(cb).toHaveBeenCalledWith('sidebarCollapsed', true, false);
  });

  test('her değişiklik için ayrı çağrı alır', () => {
    const { subscribe, setState } = freshModule();
    const cb = jest.fn();
    subscribe('*', cb);
    setState({ sidebarCollapsed: true, mobileView: true });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

// ── initState ─────────────────────────────────────────────────────────────────

describe('initState', () => {
  test('localStorage\'daki token yüklenir', () => {
    localStorage.setItem('token', 'saved-token');
    const { initState, state } = loadModule();
    initState();
    expect(state.token).toBe('saved-token');
    localStorage.clear();
  });

  test('window.currentUser varsa state\'e yüklenir', () => {
    (window as Record<string,unknown>).currentUser = { id: 'u1', username: 'ali' };
    const { initState, state } = loadModule();
    initState();
    expect((state.currentUser as Record<string,unknown>)?.id).toBe('u1');
    delete (window as Record<string,unknown>).currentUser;
  });

  test('window.currentServer varsa state\'e yüklenir', () => {
    (window as Record<string,unknown>).currentServer = { _id: 's1', name: 'test' };
    const { initState, state } = loadModule();
    initState();
    expect((state.currentServer as Record<string,unknown>)?._id).toBe('s1');
    delete (window as Record<string,unknown>).currentServer;
  });

  test('localStorage boşsa token null kalır', () => {
    localStorage.clear();
    const { initState, state } = loadModule();
    initState();
    expect(state.token).toBeNull();
  });
});

// ── BridgeState namespace export ──────────────────────────────────────────────

describe('BridgeState namespace', () => {
  test('state, setState, subscribe, initState export edilir', () => {
    const { BridgeState } = freshModule();
    expect(typeof BridgeState.state).toBe('object');
    expect(typeof BridgeState.setState).toBe('function');
    expect(typeof BridgeState.subscribe).toBe('function');
    expect(typeof BridgeState.initState).toBe('function');
  });

  test('window.BridgeState köprüsü artık kurulmaz (Sprint 80: kaldırıldı)', () => {
    freshModule();
    // Köprü kaldırıldı — window.BridgeState undefined olmalı
    expect((window as Record<string,unknown>).BridgeState).toBeUndefined();
  });
});
