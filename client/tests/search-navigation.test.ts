// client/tests/search-navigation.test.ts
//
// FAZ K/1 — ARAMA SONUCUNDAN HEDEFE GITME.
//
// ════════════════════════════════════════════════════════════════════════════
// NE KORUNUYOR
// ════════════════════════════════════════════════════════════════════════════
// Bu uygulamada arama sonuclari daha once OLU BAGLANTIYDI: `SearchPanel`
// korumasiz `BridgeRegistry.call('navigateToChannel', …)` cagiriyordu ve o ad
// HIC kayitli degildi. `call()` kayitsiz anahtarda sessizce `undefined`
// donerdi — tiklama paneli kapatiyor, hicbir yere GITMIYORDU.
//
// Bu paket iki yonu birden kilitler:
//   • yol varsa GERCEKTEN kanonik sahibe gidilir (uydurma gezinme yok)
//   • yol yoksa ACIKCA raporlanir (sessiz basarisizlik yok)
//
// Ayrica DM'in ince tuzagi: arama satirindaki `userId` GONDERENDIR, karsi
// taraf degil. Kendi mesajini bulan kullanici icin bu ikisi ayni degildir.

import { describe, it, expect, vi } from 'vitest';
import {
  navigateToHit, resolveDmPartner, FAILURE_MESSAGE, type RegistryLike,
} from '../js/core/search/search-navigation.ts';
import type { SearchHit } from '../js/core/search/unified-search-client.ts';

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  id: 'm1', source: 'channel', content: 'x', highlight: '',
  authorName: 'Ayse', authorId: 'u-other', createdAt: 1, score: 1, ...over,
});

/** Yalnizca verilen anahtarlari taniyan sahte registry. */
function registryOf(map: Record<string, unknown>): RegistryLike {
  return {
    has: (key) => key in map,
    call: <T,>(key: string, ...args: unknown[]) => {
      const value = map[key];
      return (typeof value === 'function' ? value(...args) : value) as T;
    },
  };
}

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response);

// ════════════════════════════════════════════════════════════════════════════
describe('kanal mesaji', () => {
  it('kanonik sahibe kanal + MESAJ kimligiyle gider', async () => {
    const navigate = vi.fn(() => true);
    const registry = registryOf({ navigateToChannel: navigate });

    const res = await navigateToHit(hit({ channelId: 'c1', id: 'm9' }), { registry });

    expect(res.status).toBe('ok');
    expect(navigate).toHaveBeenCalledWith('c1', 'm9', undefined);
  });

  it('BASKA sunucudaki sonuc icin hedef sunucu ozeti gecirilir', async () => {
    // Sunucular arasi gecisi `navigateToChannel` yonetir; ozet verilmezse
    // yalnizca acik sunucudaki kanallara gidebilir ve sonuc olu kalirdi.
    const navigate = vi.fn(() => true);
    const server = { _id: 's2', name: 'Digeri' };
    const registry = registryOf({
      navigateToChannel: navigate,
      getAvailableServers: () => [{ _id: 's1' }, server],
    });

    await navigateToHit(hit({ channelId: 'c1', serverId: 's2' }), { registry });

    expect(navigate).toHaveBeenCalledWith('c1', 'm1', server);
  });

  it('sahip KAYITLI DEGILSE sessizce basarili demez', async () => {
    const res = await navigateToHit(hit({ channelId: 'c1' }), { registry: registryOf({}) });
    expect(res).toEqual({ status: 'error', reason: 'unavailable' });
  });

  it('sahip false dondurunce "bulunamadi" raporlanir', async () => {
    const registry = registryOf({ navigateToChannel: () => false });
    const res = await navigateToHit(hit({ channelId: 'c1' }), { registry });
    expect(res).toEqual({ status: 'error', reason: 'not-found' });
  });

  it('kanal kimligi yoksa gidilmez', async () => {
    const navigate = vi.fn();
    const res = await navigateToHit(hit({ channelId: '' }), { registry: registryOf({ navigateToChannel: navigate }) });
    expect(res.status).toBe('error');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sunucu listesi bozuksa hedef ozeti olmadan guvenli bicimde gider', async () => {
    const navigate = vi.fn(() => true);
    const registry = registryOf({
      navigateToChannel: navigate,
      getAvailableServers: () => ({ _id: 's2' }),
    });

    expect((await navigateToHit(hit({ channelId: 'c1', serverId: 's2' }), { registry })).status)
      .toBe('ok');
    expect(navigate).toHaveBeenCalledWith('c1', 'm1', undefined);
  });

  it('sunucu listesindeki eksik kayitlari atlayip hedefi bulur', async () => {
    const navigate = vi.fn(() => true);
    const target = { _id: 's2', name: 'Hedef' };
    const registry = registryOf({
      navigateToChannel: navigate,
      getAvailableServers: () => [null, {}, target],
    });

    await navigateToHit(hit({ channelId: 'c1', serverId: 's2' }), { registry });
    expect(navigate).toHaveBeenCalledWith('c1', 'm1', target);
  });

  it('tanimsiz kanal kimligini bos kimlik olarak reddeder', async () => {
    const navigate = vi.fn();
    const res = await navigateToHit(hit({ channelId: undefined }), {
      registry: registryOf({ navigateToChannel: navigate }),
    });
    expect(res).toEqual({ status: 'error', reason: 'not-found' });
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('thread yaniti', () => {
  const threadHit = hit({ source: 'thread', threadId: 't1', channelId: 'c1' });

  it('UST MESAJI cozer, once kanala gider, sonra konuyu acar', async () => {
    // Arama satiri `threadId` tasir; `openThread` ise UST MESAJ kimligiyle
    // calisir. Ara cozumleme olmadan konu acilamaz.
    const navigate = vi.fn(() => true);
    const openThread = vi.fn();
    const registry = registryOf({ navigateToChannel: navigate, openThread });
    const apiFetch = jsonResponse({ parentMessageId: 'p1', channelId: 'c1', serverId: 's1', name: 'Konu' });

    const res = await navigateToHit(threadHit, { registry, apiFetch });

    expect(apiFetch.mock.calls[0]![0]).toBe('/api/threads/t1');
    expect(navigate).toHaveBeenCalledWith('c1', 'p1', undefined);
    expect(openThread).toHaveBeenCalledWith('p1', 'Konu');
    expect(res.status).toBe('ok');
  });

  it('thread ucu 404 verirse "bulunamadi"', async () => {
    const registry = registryOf({ navigateToChannel: () => true });
    const res = await navigateToHit(threadHit, { registry, apiFetch: jsonResponse({}, false, 404) });
    expect(res).toEqual({ status: 'error', reason: 'not-found' });
  });

  it('thread ucu 403 verirse yetki asilmaz — hata raporlanir', async () => {
    // Bu uc sunucu uyeligi dogrular; istemci onu ATLAMAZ.
    const registry = registryOf({ navigateToChannel: () => true });
    const res = await navigateToHit(threadHit, { registry, apiFetch: jsonResponse({}, false, 403) });
    expect(res).toEqual({ status: 'error', reason: 'failed' });
  });

  it('ag hatasi cokmeye yol acmaz', async () => {
    const registry = registryOf({ navigateToChannel: () => true });
    const apiFetch = vi.fn(async () => { throw new Error('offline'); });
    expect(await navigateToHit(threadHit, { registry, apiFetch }))
      .toEqual({ status: 'error', reason: 'failed' });
  });

  it('kanala varildiysa konu paneli yoksa da BASARILI sayilir', async () => {
    // Kullanici gercekten ilerledi; "basarisiz" demek yaniltici olurdu.
    const registry = registryOf({ navigateToChannel: () => true });
    const apiFetch = jsonResponse({ parentMessageId: 'p1', channelId: 'c1' });
    expect((await navigateToHit(threadHit, { registry, apiFetch })).status).toBe('ok');
  });

  it('kanala VARILAMADIYSA konu acilmaya calisilmaz', async () => {
    const openThread = vi.fn();
    const registry = registryOf({ navigateToChannel: () => false, openThread });
    const apiFetch = jsonResponse({ parentMessageId: 'p1', channelId: 'c1' });

    expect((await navigateToHit(threadHit, { registry, apiFetch })).status).toBe('error');
    expect(openThread).not.toHaveBeenCalled();
  });

  it('thread kimligi yoksa API cagrisi yapmaz', async () => {
    const apiFetch = jsonResponse({});
    const res = await navigateToHit(hit({ source: 'thread', threadId: undefined }), {
      registry: registryOf({}), apiFetch,
    });
    expect(res).toEqual({ status: 'error', reason: 'not-found' });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('thread API sahibi yoksa acikca kullanilamaz der', async () => {
    expect(await navigateToHit(threadHit, { registry: registryOf({}) }))
      .toEqual({ status: 'error', reason: 'unavailable' });
  });

  it('yanittaki eksik kanal ve adi arama sonucundan/guvenli varsayilandan tamamlar', async () => {
    const navigate = vi.fn(() => true);
    const openThread = vi.fn();
    const registry = registryOf({ navigateToChannel: navigate, openThread });
    const apiFetch = jsonResponse({ parentMessageId: 'p1' });

    expect((await navigateToHit(threadHit, { registry, apiFetch })).status).toBe('ok');
    expect(navigate).toHaveBeenCalledWith('c1', 'p1', undefined);
    expect(openThread).toHaveBeenCalledWith('p1', '');
  });

  it('ust mesaj kimligi eksik thread kaydini reddeder', async () => {
    const navigate = vi.fn();
    const registry = registryOf({ navigateToChannel: navigate });
    const apiFetch = jsonResponse({ channelId: 'c1' });
    expect(await navigateToHit(threadHit, { registry, apiFetch }))
      .toEqual({ status: 'error', reason: 'not-found' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('hem thread hem sonuc kanal kimligi eksikse reddeder', async () => {
    const navigate = vi.fn();
    const registry = registryOf({ navigateToChannel: navigate });
    const apiFetch = jsonResponse({ parentMessageId: 'p1' });
    const noChannel = hit({ source: 'thread', threadId: 't1', channelId: undefined });
    expect(await navigateToHit(noChannel, { registry, apiFetch }))
      .toEqual({ status: 'error', reason: 'not-found' });
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('DM', () => {
  it('KARSI TARAFI konusma listesinden cozer', () => {
    const registry = registryOf({
      getDmConversations: () => [{ _id: 'd1', other: { _id: 'u-karsi', displayName: 'Veli', avatarColor: '#123' } }],
    });
    expect(resolveDmPartner(registry, hit({ source: 'dm', conversationId: 'd1' })))
      .toEqual({ id: 'u-karsi', name: 'Veli', color: '#123' });
  });

  it('KENDI mesajimizi bulunca kendimizle DM ACMAZ', () => {
    // Arama satirindaki `userId` GONDERENDIR. Kendi mesajimizda bu BIZ'iz;
    // onu karsi taraf sanmak yanlis (ya da bos) bir konusma acardi.
    const registry = registryOf({ getMe: () => ({ _id: 'u-ben' }) });
    expect(resolveDmPartner(registry, hit({ source: 'dm', authorId: 'u-ben', conversationId: 'yok' })))
      .toBeNull();
  });

  it('konusma listesi yoksa GONDEREN kullanilir (bizden farkliysa)', () => {
    // Konusma listesi henuz yuklenmemis olabilir; gonderen bizden farkliysa
    // karsi taraf kesin odur.
    const registry = registryOf({ getMe: () => ({ _id: 'u-ben' }) });
    expect(resolveDmPartner(registry, hit({ source: 'dm', authorId: 'u-karsi', authorName: 'Veli' })))
      .toEqual({ id: 'u-karsi', name: 'Veli' });
  });

  it('kanonik sahibi MESAJ kimligiyle cagirir', async () => {
    const openDm = vi.fn();
    const registry = registryOf({
      openDm,
      getDmConversations: () => [{ _id: 'd1', other: { _id: 'u-karsi', displayName: 'Veli' } }],
    });

    const res = await navigateToHit(hit({ source: 'dm', id: 'dm-9', conversationId: 'd1' }), { registry });

    expect(openDm).toHaveBeenCalledWith('u-karsi', 'Veli', undefined, 'dm-9');
    expect(res.status).toBe('ok');
  });

  it('DM paneli mount degilse ACIKCA raporlanir', async () => {
    const res = await navigateToHit(hit({ source: 'dm', conversationId: 'd1' }), { registry: registryOf({}) });
    expect(res).toEqual({ status: 'error', reason: 'unavailable' });
  });

  it('karsi taraf cozulemezse gidilmez', async () => {
    const openDm = vi.fn();
    const registry = registryOf({ openDm, getMe: () => ({ _id: 'u-ben' }) });
    const res = await navigateToHit(hit({ source: 'dm', authorId: 'u-ben' }), { registry });

    expect(res).toEqual({ status: 'error', reason: 'not-found' });
    expect(openDm).not.toHaveBeenCalled();
  });

  it('displayName yoksa kanonik kullanici adina geri duser', () => {
    const registry = registryOf({
      getDmConversations: () => [{ _id: 'd1', other: { _id: 'u-karsi', username: 'veli' } }],
    });
    expect(resolveDmPartner(registry, hit({ source: 'dm', conversationId: 'd1' })))
      .toEqual({ id: 'u-karsi', name: 'veli', color: undefined });
  });

  it('bozuk konusma listesi ve getMe sahibi yokken gondereni guvenli yedekler', () => {
    const registry = registryOf({ getDmConversations: () => ({ _id: 'd1' }) });
    expect(resolveDmPartner(registry, hit({
      source: 'dm', conversationId: undefined, authorId: 'u-karsi', authorName: '',
    }))).toEqual({ id: 'u-karsi', name: undefined });
  });

  it('eksik konusma kayitlarini atlar ve getMe.id alanini tanir', () => {
    const registry = registryOf({
      getDmConversations: () => [null, {}],
      getMe: () => ({ id: 'u-ben' }),
    });
    expect(resolveDmPartner(registry, hit({
      source: 'dm', conversationId: undefined, authorId: 'u-ben',
    }))).toBeNull();
  });

  it('getMe null donerse bos kimlik olarak ele alir', () => {
    const registry = registryOf({ getMe: () => null });
    expect(resolveDmPartner(registry, hit({ source: 'dm', authorId: 'u-karsi' })))
      .toEqual({ id: 'u-karsi', name: 'Ayse' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('grup DM', () => {
  const group = { _id: 'g1', name: 'Takim' };
  const gdmHit = hit({ source: 'gdm', id: 'g-msg', conversationId: 'g1' });

  it('grubu kanonik listeden bulur ve mesaj kimligiyle acar', async () => {
    const openGroupDm = vi.fn(() => true);
    const registry = registryOf({
      'groupDmPanel:openGroupDm': openGroupDm,
      'groupDmPanel:getGroups': () => [group],
    });

    expect((await navigateToHit(gdmHit, { registry })).status).toBe('ok');
    expect(openGroupDm).toHaveBeenCalledWith(group, 'g-msg');
  });

  it('liste bosken kanonik yukleyiciyi cagirir — grup UYDURMAZ', async () => {
    // Sahte bir `{_id}` nesnesi gondermek paneli yanlis durumda acardi.
    let loaded = false;
    const openGroupDm = vi.fn(() => true);
    const registry = registryOf({
      'groupDmPanel:openGroupDm': openGroupDm,
      'groupDmPanel:loadList': () => { loaded = true; },
      'groupDmPanel:getGroups': () => (loaded ? [group] : []),
    });

    expect((await navigateToHit(gdmHit, { registry })).status).toBe('ok');
    expect(loaded).toBe(true);
    expect(openGroupDm).toHaveBeenCalledWith(group, 'g-msg');
  });

  it('yukleme sonrasi da bulunamazsa "bulunamadi"', async () => {
    const registry = registryOf({
      'groupDmPanel:openGroupDm': vi.fn(),
      'groupDmPanel:loadList': vi.fn(),
      'groupDmPanel:getGroups': () => [],
    });
    expect(await navigateToHit(gdmHit, { registry }))
      .toEqual({ status: 'error', reason: 'not-found' });
  });

  it('grup paneli mount degilse ACIKCA raporlanir', async () => {
    expect(await navigateToHit(gdmHit, { registry: registryOf({}) }))
      .toEqual({ status: 'error', reason: 'unavailable' });
  });

  it('grup kimligi yoksa listeyi acmaya calismaz', async () => {
    const openGroupDm = vi.fn();
    const registry = registryOf({ 'groupDmPanel:openGroupDm': openGroupDm });
    expect(await navigateToHit(hit({ source: 'gdm', conversationId: undefined }), { registry }))
      .toEqual({ status: 'error', reason: 'not-found' });
    expect(openGroupDm).not.toHaveBeenCalled();
  });

  it('listedeki eksik grup kayitlarini guvenli bicimde atlar', async () => {
    const openGroupDm = vi.fn();
    const registry = registryOf({
      'groupDmPanel:openGroupDm': openGroupDm,
      'groupDmPanel:getGroups': () => [null, {}],
    });
    expect(await navigateToHit(gdmHit, { registry }))
      .toEqual({ status: 'error', reason: 'not-found' });
    expect(openGroupDm).not.toHaveBeenCalled();
  });

  it('yeniden yuklenen listedeki eksik kayitlari atlayip grubu bulur', async () => {
    let loaded = false;
    const openGroupDm = vi.fn(() => true);
    const registry = registryOf({
      'groupDmPanel:openGroupDm': openGroupDm,
      'groupDmPanel:loadList': () => { loaded = true; },
      'groupDmPanel:getGroups': () => (loaded ? [null, group] : []),
    });
    expect((await navigateToHit(gdmHit, { registry })).status).toBe('ok');
    expect(openGroupDm).toHaveBeenCalledWith(group, 'g-msg');
  });

  it('kanonik grup sahibi false dondururse bulunamadi der', async () => {
    const registry = registryOf({
      'groupDmPanel:openGroupDm': () => false,
      'groupDmPanel:getGroups': () => [group],
    });
    expect(await navigateToHit(gdmHit, { registry }))
      .toEqual({ status: 'error', reason: 'not-found' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('hata mesajlari', () => {
  it('her basarisizlik turunun kullaniciya gosterilecek metni vardir', () => {
    for (const reason of ['unavailable', 'not-found', 'failed'] as const)
      expect(FAILURE_MESSAGE[reason].length).toBeGreaterThan(0);
  });

  it('bilinmeyen kaynak kanonik sahibi olmadigi icin acikca reddedilir', async () => {
    const unknown = hit({ source: 'channel' }) as SearchHit & { source: string };
    unknown.source = 'unknown';
    expect(await navigateToHit(unknown as SearchHit, { registry: registryOf({}) }))
      .toEqual({ status: 'error', reason: 'unavailable' });
  });
});
