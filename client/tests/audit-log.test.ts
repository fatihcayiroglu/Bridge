// client/tests/audit-log.test.ts — Sprint 52
// audit-log.ts için unit testler
// Kapsam: _actionLabel, _relTime, _aesc, render entries, pagination, export

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../js/core/api-fetch', () => ({
  apiFetch: jest.fn(),
}), { virtual: true });

jest.mock('../js/core/globals', () => ({
  getAPI: jest.fn(() => 'http://localhost:3000'),
}), { virtual: true });

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(() => null),
    call:     jest.fn(),
    has:      jest.fn(() => false),
  },
}), { virtual: true });

import { apiFetch } from '../js/core/api-fetch';

// ── Sample data ────────────────────────────────────────────────────────────────

const sampleLogs = [
  { _id: 'l1', action: 'BAN',            actorName: 'Admin', targetName: 'Kullanıcı1', createdAt: Date.now() - 30_000 },
  { _id: 'l2', action: 'CHANNEL_CREATE', actorName: 'Mod',   targetName: '#genel',     createdAt: Date.now() - 3_600_000 },
  { _id: 'l3', action: 'KICK',           actorName: 'Admin', targetName: '<script>xss</script>', createdAt: Date.now() - 86_400_000 },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildDOM() {
  document.body.innerHTML = `
    <div id="audit-log-list"></div>
    <div id="audit-log-total"></div>
    <button id="audit-load-more"></button>
    <input id="audit-filter-action" value="">
    <input id="audit-filter-actor"  value="">
    <button id="audit-export-csv">CSV</button>
    <button id="audit-export-json">JSON</button>
  `;
}

function loadModule() {
  jest.resetModules();
  return require('../js/core/audit-log');
}

// ── Tests: loadAuditLog ────────────────────────────────────────────────────────

describe('loadAuditLog()', () => {
  beforeEach(() => {
    buildDOM();
    apiFetch.mockClear();
  });

  test('API\'ye doğru endpoint ile istek atar', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: [], total: 0 }) });
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/servers/srv1/audit'));
  });

  test('log kayıtları DOM\'a render edilir', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: sampleLogs, total: 3 }) });
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    expect(document.getElementById('audit-log-list').children.length).toBe(3);
  });

  test('log yokken boş durum gösterilir', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: [], total: 0 }) });
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    expect(document.getElementById('audit-log-list').innerHTML).toMatch(/log yok|boş|kayıt/i);
  });

  test('targetName XSS içeriyorsa escape edilir', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: [sampleLogs[2]], total: 1 }) });
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    const list = document.getElementById('audit-log-list');
    expect(list.innerHTML).not.toContain('<script>xss</script>');
    expect(list.innerHTML).toContain('&lt;script&gt;');
  });

  test('API hatası durumunda hata mesajı gösterilir', async () => {
    apiFetch.mockRejectedValue(new Error('Ağ hatası'));
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    expect(document.getElementById('audit-log-list').innerHTML).toMatch(/hata|yüklenemedi|error/i);
  });

  test('total sayısını günceller', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: sampleLogs, total: 42 }) });
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    const totalEl = document.getElementById('audit-log-total');
    if (totalEl) expect(totalEl.textContent).toContain('42');
  });
});

describe('Action ikonları ve etiketleri', () => {
  beforeEach(() => buildDOM());

  test('BAN aksiyonu doğru ikon içerir', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: [sampleLogs[0]], total: 1 }) });
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    const list = document.getElementById('audit-log-list');
    expect(list.innerHTML).toContain('🔨');
  });

  test('KICK aksiyonu doğru ikon içerir', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: [sampleLogs[2]], total: 1 }) });
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    const list = document.getElementById('audit-log-list');
    expect(list.innerHTML).toContain('👢');
  });

  test('CHANNEL_CREATE aksiyonu doğru ikon içerir', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: [sampleLogs[1]], total: 1 }) });
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    const list = document.getElementById('audit-log-list');
    expect(list.innerHTML).toContain('📁');
  });
});

describe('Filtreler', () => {
  beforeEach(() => buildDOM());

  test('action filtresi API isteğine eklenir', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: [], total: 0 }) });
    document.getElementById('audit-filter-action').value = 'BAN';
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('BAN'));
  });

  test('actor filtresi API isteğine eklenir', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: [], total: 0 }) });
    document.getElementById('audit-filter-actor').value = 'Admin';
    const { loadAuditLog } = loadModule();
    await loadAuditLog('srv1');
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('Admin'));
  });
});

describe('BridgeRegistry.register', () => {
  test('modül yüklenince register çağırılır', () => {
    const { BridgeRegistry } = require('../js/core/bridge-registry');
    buildDOM();
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ logs: [], total: 0 }) });
    loadModule();
    expect(BridgeRegistry.register).toHaveBeenCalled();
  });
});
