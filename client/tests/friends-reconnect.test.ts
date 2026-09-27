// client/tests/friends-reconnect.test.ts
// Faz 10.5 — Friends durum yakınsaması.
//
// MİMARİ NOTU: FriendsPanel tamamen REST-pull'dur, socket dinleyicisi YOKTUR.
// `load()` dizileri append etmez, DEĞİŞTİRİR — bu yüzden duplike üretimi
// yapısal olarak imkânsızdır. Testler bunu kanıtlar ve korur.
//
// Kapatılan iki boşluk:
//   P2  yeniden bağlanmada yenileme yoktu → durum bayat kalıyordu
//   P1  çıkışta sıfırlama yoktu; `friendsCache` modül seviyesi singleton
//       olduğu için bir sonraki kullanıcıya sızabiliyordu

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import FriendsPanel from '../js/core/FriendsPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { friendsCache } from '../js/core/globals.ts';

type Friend = { _id: string; username: string };
type Req = { _id: string; userId: string };

/** Sunucu gerçeği — testler arasında değiştirilebilir. */
let serverFriends: Friend[] = [];
let serverPending: Req[] = [];
let friendsCalls = 0;

function installApi(): void {
  BridgeRegistry.register('apiFetch', ((url: string) => {
    if (url.includes('/api/friends/pending')) {
      return Promise.resolve(new Response(JSON.stringify(serverPending), { status: 200 }));
    }
    if (url.includes('/api/friends')) {
      friendsCalls += 1;
      return Promise.resolve(new Response(JSON.stringify(serverFriends), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as AnyFn);
}

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

const rows = () => { flushSync(); return [...document.querySelectorAll('.friend-row, [data-friend-id]')]; };
const settle = () => new Promise(r => setTimeout(r, 0));

async function mountPanel(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(FriendsPanel, { target: host });
  flushSync();
  await settle();
  flushSync();
}

function reconnect(): void {
  document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
  flushSync();
}

beforeEach(() => {
  friendsCalls = 0;
  serverFriends = [{ _id: 'f1', username: 'ada' }];
  serverPending = [{ _id: 'r1', userId: 'u9' }];
  friendsCache.clear();
  installApi();
});

afterEach(() => {
  if (instance) { unmount(instance); instance = null; }
  host?.remove();
  BridgeRegistry.unregister('apiFetch');
  friendsCache.clear();
  vi.restoreAllMocks();
});

describe('Friends — ilk yükleme ve önbellek', () => {
  it('mount sunucu gerçeğini çeker ve önbelleği doldurur', async () => {
    await mountPanel();

    expect(friendsCalls).toBe(1);
    expect(friendsCache.size).toBe(1);
    expect(friendsCache.has('f1')).toBe(true);
  });
});

describe('Friends — yeniden bağlanma yakınsaması', () => {
  it('panel AÇIKKEN reconnect sunucu gerçeğine yakınsar', async () => {
    await mountPanel();
    BridgeRegistry.call('showFriendsPanel');
    await settle(); flushSync();
    const before = friendsCalls;

    // Kopukken sunucuda değişiklik: arkadaş eklendi, istek çözüldü.
    serverFriends = [{ _id: 'f1', username: 'ada' }, { _id: 'f2', username: 'linus' }];
    serverPending = [];

    reconnect();
    await settle(); flushSync();

    expect(friendsCalls).toBeGreaterThan(before);
    expect(friendsCache.size).toBe(2);
    expect(friendsCache.has('f2')).toBe(true);
  });

  it('silinen arkadaş reconnect sonrası KALMAZ (bayat kayıt yok)', async () => {
    await mountPanel();
    BridgeRegistry.call('showFriendsPanel');
    await settle(); flushSync();

    serverFriends = [];   // sunucuda arkadaşlık kaldırıldı
    reconnect();
    await settle(); flushSync();

    expect(friendsCache.size).toBe(0);
  });

  it('tekrarlı reconnect DUPLİKE üretmez (dizi değiştirilir, append edilmez)', async () => {
    await mountPanel();
    BridgeRegistry.call('showFriendsPanel');
    await settle(); flushSync();

    for (let i = 0; i < 5; i += 1) { reconnect(); await settle(); }
    flushSync();

    expect(friendsCache.size).toBe(1);          // hâlâ tek arkadaş
    expect([...friendsCache.keys()]).toEqual(['f1']);
  });

  it('panel KAPALIYKEN reconnect gereksiz istek atmaz', async () => {
    await mountPanel();          // mount açık değil (isVisible=false)
    const before = friendsCalls;

    reconnect();
    await settle();

    expect(friendsCalls).toBe(before);
  });
});

describe('Friends — çıkışta kullanıcı izolasyonu', () => {
  it('çıkış modül seviyesi friendsCache\'i TEMİZLER', async () => {
    await mountPanel();
    expect(friendsCache.size).toBe(1);

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();

    expect(friendsCache.size).toBe(0);
  });

  it('çıkış sonrası panel görünür durumdan çıkar ve liste boşalır', async () => {
    await mountPanel();
    BridgeRegistry.call('showFriendsPanel');
    await settle(); flushSync();

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();

    expect(document.querySelector('.friends-panel')).toBeNull();
  });

  it('A çıkışı → B girişi: B yalnız KENDİ sunucu gerçeğini görür', async () => {
    await mountPanel();                       // kullanıcı A
    expect(friendsCache.has('f1')).toBe(true);

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();

    // Kullanıcı B'nin sunucu gerçeği tamamen farklı
    serverFriends = [{ _id: 'b1', username: 'grace' }];
    serverPending = [];
    BridgeRegistry.call('showFriendsPanel');  // B paneli açıyor
    await settle(); flushSync();

    expect(friendsCache.has('f1')).toBe(false);   // A'nın verisi yok
    expect(friendsCache.has('b1')).toBe(true);
  });
});

describe('Friends — yaşam döngüsü temizliği', () => {
  it('unmount sonrası reconnect/logout olayları etki etmez', async () => {
    await mountPanel();
    unmount(instance!); instance = null;
    flushSync();
    const before = friendsCalls;

    reconnect();
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    await settle();

    expect(friendsCalls).toBe(before);   // yok edilmiş bileşen istek atmaz
  });
});
