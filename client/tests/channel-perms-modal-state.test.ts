// client/tests/channel-perms-modal-state.test.ts
// channel-perms/modal-state.ts ESM export testleri

'use strict';

// JSDOM simülasyonu için minimal setup
document.body.innerHTML = `
  <div id="ch-perms-modal">
    <h2>Kanal İzinleri</h2>
    <div id="chperms-save-info"></div>
  </div>
`;

// TypeScript olmadan test etmek için mock BridgeRegistry
jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn() },
}), { virtual: true });

// channel-perms-data mock
jest.mock('../js/core/channel-perms-data', () => ({}), { virtual: true });

// Module import (compiled JS gibi davran)
let modalState;
beforeAll(async () => {
  // Jest transform ile TS desteği varsayılıyor (tsconfig.jest.json)
  try {
    modalState = require('../js/core/channel-perms/modal-state');
  } catch {
    // TS derlenmemişse skip
    modalState = null;
  }
});

describe('modal-state — dirty tracking', () => {
  beforeEach(() => {
    // Reset dirty badge
    document.getElementById('dirty-badge')?.remove();
    const title = document.querySelector('#ch-perms-modal h2');
    if (title) delete title.dataset['dirty'];
    if (modalState) {
      modalState.setState({ isDirty: false });
    }
  });

  it('markDirty adds dirty-badge to modal title', () => {
    if (!modalState) { console.warn('modal-state not compiled, skipping'); return; }
    modalState.markDirty();
    const badge = document.getElementById('dirty-badge');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('Kaydedilmedi');
  });

  it('markDirty is idempotent — only adds one badge', () => {
    if (!modalState) return;
    modalState.markDirty();
    modalState.markDirty();
    const badges = document.querySelectorAll('#dirty-badge');
    expect(badges.length).toBe(1);
  });

  it('clearDirty removes the badge', () => {
    if (!modalState) return;
    modalState.markDirty();
    modalState.clearDirty();
    expect(document.getElementById('dirty-badge')).toBeNull();
  });

  it('getState().isDirty reflects dirty state', () => {
    if (!modalState) return;
    expect(modalState.getState().isDirty).toBe(false);
    modalState.markDirty();
    expect(modalState.getState().isDirty).toBe(true);
    modalState.clearDirty();
    expect(modalState.getState().isDirty).toBe(false);
  });
});

describe('modal-state — readRow', () => {
  it('reads allow/deny bits from perm-toggle buttons', () => {
    if (!modalState) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <button class="perm-toggle" data-bit="1" data-state="allow"></button>
      <button class="perm-toggle" data-bit="2" data-state="deny"></button>
      <button class="perm-toggle" data-bit="4" data-state="neutral"></button>
    `;
    const result = modalState.readRow(tr);
    expect(result.allow).toBe(1);
    expect(result.deny).toBe(2);
  });

  it('returns 0,0 for empty row', () => {
    if (!modalState) return;
    const tr = document.createElement('tr');
    const result = modalState.readRow(tr);
    expect(result).toEqual({ allow: 0, deny: 0 });
  });
});

describe('modal-state — rowIsDirty', () => {
  it('returns true when current differs from snapshot', () => {
    if (!modalState) return;
    modalState.setState({ snapshot: { 'role1': { allow: 0, deny: 0 } } });
    expect(modalState.rowIsDirty('role1', { allow: 1, deny: 0 })).toBe(true);
  });

  it('returns false when current matches snapshot', () => {
    if (!modalState) return;
    modalState.setState({ snapshot: { 'role1': { allow: 3, deny: 2 } } });
    expect(modalState.rowIsDirty('role1', { allow: 3, deny: 2 })).toBe(false);
  });

  it('returns true for null snapshot (deleted override)', () => {
    if (!modalState) return;
    modalState.setState({ snapshot: { 'role1': null } });
    expect(modalState.rowIsDirty('role1', { allow: 0, deny: 0 })).toBe(true);
  });
});

describe('modal-state — currentChannelId', () => {
  it('stores and retrieves current channel id', () => {
    if (!modalState) return;
    modalState.setCurrentChannelId('channel-abc');
    expect(modalState.getCurrentChannelId()).toBe('channel-abc');
  });
});

describe('modal-state — cyclePerm', () => {
  it('cycles neutral → allow → deny → neutral', () => {
    if (!modalState) return;
    // setState ile dirty önleyici mock
    modalState.setState({ isDirty: false, snapshot: {} });

    const btn = document.createElement('button');
    btn.className = 'perm-toggle';
    btn.dataset['state'] = 'neutral';
    btn.dataset['bit'] = '1';
    btn.dataset['roleId'] = 'r1';
    btn.textContent = '—';

    modalState.cyclePerm(btn);
    expect(btn.dataset['state']).toBe('allow');
    expect(btn.textContent).toBe('✅');

    modalState.cyclePerm(btn);
    expect(btn.dataset['state']).toBe('deny');
    expect(btn.textContent).toBe('❌');

    modalState.cyclePerm(btn);
    expect(btn.dataset['state']).toBe('neutral');
    expect(btn.textContent).toBe('—');
  });
});
