// client/tests/user-isolation.test.ts
// Faz 10.7 — Kullanıcı A → çıkış → Kullanıcı B özel durum izolasyonu.
//
// Bu bileşenler çıkışta UNMOUNT EDİLMEZ; uygulama boyunca mount kalırlar.
// Bu yüzden "yeniden mount olur nasılsa" varsayımı geçersizdir — her sahip
// kendi özel durumunu `bridge:auth-logout` üzerinde temizlemek zorundadır.
//
// Bu turda bulunan iki GERÇEK sızıntı:
//   P1  DmPanel'de logout işleyicisi hiç yoktu → A'nın DM listesi, seçili
//       konuşması, ÖZEL MESAJ İÇERİĞİ ve taslağı B'ye taşınıyordu.
//   P1  MessageInputPanel.pendingSends yalnız onDestroy'da temizleniyordu →
//       A'nın uçuştaki ACK zamanlayıcıları B'nin oturumunda ateşlenebiliyordu.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import DmPanel from '../js/core/DmPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { friendsCache } from '../js/core/globals.ts';
import { readDraft, writeDraft } from '../js/core/draft-store.ts';

const A_CONV = { _id: 'dm-a', other: { _id: 'peer-a', username: 'ZZPEERA' }, unreadCount: 3 };
const A_MSG = { _id: 'm1', dmId: 'dm-a', userId: 'peer-a', content: 'GIZLI-A-MESAJI' };

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let serverConversations: unknown[] = [];
let serverMessages: unknown[] = [];

function installApi(): void {
  BridgeRegistry.register('apiFetch', ((url: string) => {
    if (url.includes('/messages')) return Promise.resolve(new Response(JSON.stringify(serverMessages), { status: 200 }));
    if (url.includes('/api/dm')) return Promise.resolve(new Response(JSON.stringify(serverConversations), { status: 200 }));
    return Promise.resolve(new Response('[]', { status: 200 }));
  }) as unknown as AnyFn);
}

const settle = () => new Promise(r => setTimeout(r, 0));
const logout = () => { document.dispatchEvent(new CustomEvent('bridge:auth-logout')); flushSync(); };
const panelText = () => { flushSync(); return host.textContent ?? ''; };

beforeEach(() => {
  serverConversations = [A_CONV];
  serverMessages = [A_MSG];
  friendsCache.clear();
  installApi();
  BridgeRegistry.register('getMe', () => ({ _id: 'user-a' }));
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (instance) { unmount(instance); instance = null; }
  host?.remove();
  BridgeRegistry.unregister('apiFetch');
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('socket');
  friendsCache.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mountAndLoadAsA(): Promise<void> {
  instance = mount(DmPanel, { target: host });
  flushSync();
  await settle(); flushSync();
  BridgeRegistry.call('openDm', 'peer-a');      // A konuşmayı açar
  await settle(); flushSync();
}

describe('DM özel durumu — A → çıkış → B', () => {
  it('A oturumunda DM listesi ve mesaj içeriği yüklenir (pozitif kontrol)', async () => {
    await mountAndLoadAsA();

    expect(panelText()).toContain('GIZLI-A-MESAJI');
  });

  it('çıkış A\'nın ÖZEL MESAJ İÇERİĞİNİ ekrandan kaldırır', async () => {
    await mountAndLoadAsA();
    expect(panelText()).toContain('GIZLI-A-MESAJI');

    logout();

    expect(panelText()).not.toContain('GIZLI-A-MESAJI');
  });

  it('çıkış A\'nın DM listesini ve karşı taraf adını kaldırır', async () => {
    await mountAndLoadAsA();

    logout();

    expect(panelText()).not.toContain('ZZPEERA');
  });

  it('B girişinde A\'nın konuşması GÖRÜNMEZ — yalnız B\'nin verisi', async () => {
    await mountAndLoadAsA();
    logout();

    // Kullanıcı B: sunucu gerçeği tamamen farklı
    BridgeRegistry.register('getMe', () => ({ _id: 'user-b' }));
    serverConversations = [{ _id: 'dm-b', other: { _id: 'peer-b', username: 'grace' }, unreadCount: 0 }];
    serverMessages = [];
    BridgeRegistry.call('showDmPanel');
    await settle(); flushSync();

    const text = panelText();
    expect(text).not.toContain('ZZPEERA');
    expect(text).not.toContain('GIZLI-A-MESAJI');
    expect(text).toContain('grace');
  });

  it('A\'nın okunmamış sayacı B\'ye MİRAS KALMAZ', async () => {
    await mountAndLoadAsA();
    logout();

    BridgeRegistry.register('getMe', () => ({ _id: 'user-b' }));
    serverConversations = [{ _id: 'dm-b', other: { _id: 'peer-b', username: 'grace' }, unreadCount: 0 }];
    BridgeRegistry.call('showDmPanel');
    await settle(); flushSync();

    // A'nın 3'lük rozeti hiçbir yerde olmamalı.
    expect(host.querySelector('.dm-unread')).toBeNull();
  });

  it('tekrarlı A→B→A geçişinde bayat durum BİRİKMEZ', async () => {
    await mountAndLoadAsA();

    for (let i = 0; i < 3; i += 1) {
      logout();
      BridgeRegistry.call('showDmPanel');
      await settle(); flushSync();
    }

    // Her turda liste sunucudan yeniden geliyor; kopya konuşma satırı yok.
    expect(host.querySelectorAll('.dm-conversation')).toHaveLength(serverConversations.length);
  });
});

describe('bayat socket kullanıcı değişiminden sonra', () => {
  function makeSocket() {
    const handlers = new Map<string, Array<(v: unknown) => void>>();
    return {
      on(e: string, fn: (v: unknown) => void) { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e)!.push(fn); },
      off(e: string, fn: (v: unknown) => void) { const l = handlers.get(e) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
      emit() {},
      fire(e: string, p: unknown) { for (const fn of [...(handlers.get(e) ?? [])]) fn(p); },
      count(e: string) { return (handlers.get(e) ?? []).length; },
    };
  }

  it('ESKİ sockete gelen A mesajı B durumunu DEĞİŞTİREMEZ', async () => {
    const socketA = makeSocket();
    BridgeRegistry.register('socket', socketA as unknown as AnyFn);
    await mountAndLoadAsA();

    logout();
    // Yeni oturum: SocketManager yeni nesne verir
    const socketB = makeSocket();
    BridgeRegistry.register('socket', socketB as unknown as AnyFn);
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    flushSync();

    // A'nın eski socketi hâlâ mesaj yollamaya çalışıyor
    socketA.fire('dm:message', { _id: 'stale', dmId: 'dm-a', userId: 'peer-a', content: 'BAYAT-A' });
    flushSync();

    expect(panelText()).not.toContain('BAYAT-A');
    expect(socketA.count('dm:message')).toBe(0);   // bayat nesnede dinleyici kalmadı
    expect(socketB.count('dm:message')).toBe(1);   // yeni nesnede tam bir tane
  });
});

describe('taslak izolasyonu (mevcut sözleşme korunur)', () => {
  it('A taslağı B tarafından OKUNAMAZ (anahtar kullanıcı kapsamlı)', () => {
    writeDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' }, 'A-TASLAGI');

    expect(readDraft({ userId: 'user-b', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' })).toBe('');
    expect(readDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' })).toBe('A-TASLAGI');
  });

  it('A geri döndüğünde KENDİ taslağı korunur (kasıtlı kalıcılık)', () => {
    writeDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' }, 'A-TASLAGI');
    logout();

    expect(readDraft({ userId: 'user-a', kind: 'channel', serverId: 'srv-1', conversationId: 'ch-1' })).toBe('A-TASLAGI');
  });
});

// NOT: `friendsCache` çıkış temizliği SAHİBİNE aittir (FriendsPanel) ve
// orada test edilir (friends-reconnect.test.ts). Burada tekrar edilmez —
// bu dosyada FriendsPanel mount değildir, dolayısıyla dinleyicisi de yoktur.
// Sahiplik kuralı: her bileşen kendi özel durumunu kendisi temizler.
