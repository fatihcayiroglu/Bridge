// server/tests/plugin-registry-isolation.test.ts — Sprint 79
// plugins/registry.ts cross-plugin event izolasyon testleri
//
// Test senaryosu:
//   plugin-A bir event emit eder.
//   plugin-B aynı event'e wildcard (*) ile dinliyorsa ÇAĞRILMAMALI.
//   Ama tam eşleşme (exact event) varsa plugin-B çağrılmalı.

'use strict';

process.env.NODE_ENV = 'test';

import { register, unregister, emit, _getListeners } from '../../plugins/registry';

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function makePlugin(id: string) {
  return { id, name: `Plugin ${id}`, version: '1.0.0' };
}

function cleanup(...ids: string[]) {
  ids.forEach(id => unregister(id));
}

// ── A — Wildcard izolasyonu ───────────────────────────────────────────────────

describe('cross-plugin wildcard izolasyonu', () => {
  afterEach(() => cleanup('plugin-a', 'plugin-b', 'plugin-c'));

  it('plugin-A emit → plugin-B wildcard listener ÇAĞRILMAZ', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));

    const cbB = jest.fn();
    hooksB.on('*', cbB); // plugin-B wildcard dinliyor

    await hooksA.emit('custom:event', { payload: 'hello' }); // plugin-A emit

    expect(cbB).not.toHaveBeenCalled();
  });

  it('plugin-A emit → plugin-A wildcard listener ÇAĞRILIR', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));

    const cbA = jest.fn();
    hooksA.on('*', cbA);

    await hooksA.emit('custom:event', { payload: 'hello' });

    expect(cbA).toHaveBeenCalledWith({ payload: 'hello' });
  });

  it('üç plugin — yalnızca kaynak plugin wildcard alır', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));
    const hooksC = register('plugin-c', makePlugin('plugin-c'));

    const cbA = jest.fn();
    const cbB = jest.fn();
    const cbC = jest.fn();
    hooksA.on('*', cbA);
    hooksB.on('*', cbB);
    hooksC.on('*', cbC);

    await hooksB.emit('my:event', 42);

    expect(cbB).toHaveBeenCalledWith(42);
    expect(cbA).not.toHaveBeenCalled();
    expect(cbC).not.toHaveBeenCalled();
  });
});

// ── B — Tam eşleşme (exact event) cross-plugin çağrısı ───────────────────────

describe('exact event cross-plugin çağrısı', () => {
  afterEach(() => cleanup('plugin-a', 'plugin-b'));

  it('plugin-B "message:new" dinliyorsa plugin-A "message:new" emit ettiğinde ÇAĞRILIR', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));

    const cbB = jest.fn();
    hooksB.on('message:new', cbB);

    await hooksA.emit('message:new', { content: 'merhaba' });

    expect(cbB).toHaveBeenCalledWith({ content: 'merhaba' });
  });

  it('exact listener + wildcard — exact çağrılır, farklı plugin wildcard çağrılmaz', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));

    const exactCb    = jest.fn();
    const wildcardCb = jest.fn();
    hooksB.on('user:join', exactCb);   // exact — çağrılmalı
    hooksB.on('*', wildcardCb);         // wildcard — plugin-A emit ettiğinde çağrılmamalı

    await hooksA.emit('user:join', { userId: 'u1' });

    expect(exactCb).toHaveBeenCalledWith({ userId: 'u1' });
    expect(wildcardCb).not.toHaveBeenCalled();
  });
});

// ── C — Global emit() (server infrastructure) ────────────────────────────────

describe('global emit() — tüm plugin wildcard listener\'larına ulaşır', () => {
  afterEach(() => cleanup('plugin-a', 'plugin-b'));

  it('emit("event", data) plugin-A ve plugin-B wildcard listener\'larını çağırır', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));

    const cbA = jest.fn();
    const cbB = jest.fn();
    hooksA.on('*', cbA);
    hooksB.on('*', cbB);

    // Server infrastructure global broadcast
    await emit('system:shutdown', { reason: 'maintenance' });

    expect(cbA).toHaveBeenCalledWith({ reason: 'maintenance' });
    expect(cbB).toHaveBeenCalledWith({ reason: 'maintenance' });
  });

  it('global emit exact event — tüm listener\'lar tetiklenir', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));

    const cbA = jest.fn();
    const cbB = jest.fn();
    hooksA.on('deploy', cbA);
    hooksB.on('deploy', cbB);

    await emit('deploy', { version: '79' });

    expect(cbA).toHaveBeenCalledWith({ version: '79' });
    expect(cbB).toHaveBeenCalledWith({ version: '79' });
  });
});

// ── D — Unregister temizliği ──────────────────────────────────────────────────

describe('unregister', () => {
  it('unregister sonrası plugin listener\'ları çağrılmaz', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const cb = jest.fn();
    hooksA.on('some:event', cb);
    unregister('plugin-a');
    await emit('some:event', {});
    expect(cb).not.toHaveBeenCalled();
  });

  it('unregister sonrası _getListeners temizlenir', () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    hooksA.on('custom', jest.fn());
    unregister('plugin-a');
    const listeners = _getListeners().get('custom') ?? [];
    expect(listeners.filter(l => l.pluginId === 'plugin-a')).toHaveLength(0);
  });
});

// ── E — on/off ────────────────────────────────────────────────────────────────

describe('hooks.off', () => {
  afterEach(() => cleanup('plugin-a'));

  it('off ile listener kaldırılır', async () => {
    const hooks = register('plugin-a', makePlugin('plugin-a'));
    const cb = jest.fn();
    hooks.on('evt', cb);
    hooks.off('evt', cb);
    await emit('evt', {});
    expect(cb).not.toHaveBeenCalled();
  });

  it('olmayan event için off hata fırlatmaz', () => {
    const hooks = register('plugin-a', makePlugin('plugin-a'));
    expect(() => hooks.off('nonexistent', jest.fn())).not.toThrow();
  });
});

// ── F — Hata yalıtımı ────────────────────────────────────────────────────────

describe('listener hata yalıtımı', () => {
  afterEach(() => cleanup('plugin-a', 'plugin-b'));

  it('bir listener hata fırlatırsa diğerleri çalışmaya devam eder', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));

    const throwingCb = jest.fn().mockRejectedValue(new Error('plugin-a patladı'));
    const goodCb     = jest.fn();

    hooksA.on('event', throwingCb);
    hooksB.on('event', goodCb);

    await expect(emit('event', {})).resolves.not.toThrow();
    expect(goodCb).toHaveBeenCalled();
  });
});

// ── G — emitToAll opt-in cross-plugin broadcast (Sprint 80) ──────────────────

describe('emitToAll — opt-in cross-plugin broadcast', () => {
  afterEach(() => cleanup('plugin-a', 'plugin-b', 'plugin-c'));

  it('emitToAll diğer plugin\'lerin wildcard listener\'larını da tetikler', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));

    const cbB = jest.fn();
    hooksB.on('*', cbB);

    // Normal emit → cbB tetiklenmez (izolasyon)
    await hooksA.emit('my:event', { from: 'a' });
    expect(cbB).not.toHaveBeenCalled();

    // emitToAll → cbB tetiklenir (cross-plugin broadcast)
    await hooksA.emitToAll('my:event', { from: 'a', broadcast: true });
    expect(cbB).toHaveBeenCalledTimes(1);
  });

  it('emitToAll exact event listener\'larını da çağırır', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));

    const cbExact = jest.fn();
    hooksB.on('shared:event', cbExact);

    await hooksA.emitToAll('shared:event', { payload: 42 });
    expect(cbExact).toHaveBeenCalledWith({ payload: 42 });
  });

  it('emitToAll kaynağın kendi listener\'larını da çağırır', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));

    const cbOwn = jest.fn();
    hooksA.on('*', cbOwn);

    await hooksA.emitToAll('own:event', {});
    expect(cbOwn).toHaveBeenCalledTimes(1);
  });

  it('emitToAll üç plugin senaryosunda hepsine ulaşır', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));
    const hooksC = register('plugin-c', makePlugin('plugin-c'));

    const cbB = jest.fn();
    const cbC = jest.fn();
    hooksB.on('*', cbB);
    hooksC.on('*', cbC);

    await hooksA.emitToAll('broadcast:event', { all: true });
    expect(cbB).toHaveBeenCalledTimes(1);
    expect(cbC).toHaveBeenCalledTimes(1);
  });

  it('emit ile emitToAll tutarlı bir şekilde ayrışır', async () => {
    const hooksA = register('plugin-a', makePlugin('plugin-a'));
    const hooksB = register('plugin-b', makePlugin('plugin-b'));

    const scopedCb    = jest.fn();  // sadece emitToAll'a tepki vermeli
    const isolatedCb  = jest.fn();  // emit'te tetiklenmemeli
    hooksB.on('*', scopedCb);

    await hooksA.emit('test', {});
    expect(scopedCb).not.toHaveBeenCalled();

    await hooksA.emitToAll('test', {});
    expect(scopedCb).toHaveBeenCalledTimes(1);
  });
});
