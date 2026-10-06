// client/tests/draft-manager.test.ts
// Faz 8.2 — Taslak yöneticisinin ZAMANLAMA ve KAYIT sözleşmesi.
//
// draft-store.test.ts saf kalıcılığı ölçer; buradaki testler debounce,
// kanal geçişinde flush, oturum değişimi ve yaşam döngüsü temizliğini ölçer.
// Gerçek bileşen mount edilir — mock DraftManager yoktur.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import DraftManager from '../js/core/DraftManager.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { draftKey } from '../js/core/draft-store.ts';
import {
  peekLocalFirstDraft,
  resetLocalFirstDraftRuntimeForTests,
} from '../js/core/local-first/draft-runtime.ts';

const DEBOUNCE_MS = 400;

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

let me: { _id: string } | null = null;
let channel: { _id: string; type?: string; serverId?: string } | null = null;

const setDraft = (text: string) => BridgeRegistry.call('setDraft', text);
const getDraft = () => BridgeRegistry.call<string>('getDraft') ?? '';
const flushDraft = () => BridgeRegistry.call('flushDraft');
const clearDraft = (id?: string, kind?: string, serverId?: string) => BridgeRegistry.call('clearDraft', id, kind, serverId);
const channelDraft = (conversationId: string, serverId = 'srv-1') => ({
  userId: 'user-a', kind: 'channel' as const, serverId, conversationId,
});

/** Debounce penceresini geçir. */
const settle = () => { vi.advanceTimersByTime(DEBOUNCE_MS + 50); flushSync(); };

function mountManager(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(DraftManager, { target: host });
  flushSync();
}

function unmountManager(): void {
  if (instance) unmount(instance);
  instance = null;
  host?.remove();
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetLocalFirstDraftRuntimeForTests();
  me = { _id: 'user-a' };
  channel = { _id: 'ch-1', type: 'text', serverId: 'srv-1' };
  BridgeRegistry.register('getMe', () => me);
  BridgeRegistry.register('getCurrentChannel', () => channel);
  BridgeRegistry.register('getCurrentServer', () => ({ _id: channel?.serverId ?? 'srv-1' }));
  mountManager();
});

afterEach(() => {
  unmountManager();
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('getCurrentChannel');
  BridgeRegistry.unregister('getCurrentServer');
  resetLocalFirstDraftRuntimeForTests();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('kayıt sözleşmesi', () => {
  it('mount minimal API\'yi kaydeder', () => {
    for (const name of [
      'getDraft', 'setDraft', 'clearDraft', 'flushDraft',
      'getDraftAttachmentPending', 'setDraftAttachmentPending',
    ]) {
      expect(BridgeRegistry.has(name)).toBe(true);
    }
  });

  it('legacy global API diriltilmez', () => {
    expect((globalThis as Record<string, unknown>).saveDraft).toBeUndefined();
    expect((globalThis as Record<string, unknown>).restoreDraft).toBeUndefined();
    expect((globalThis as Record<string, unknown>)._bridgeDrafts).toBeUndefined();
  });

  it('unmount kayıtları bırakır', () => {
    unmountManager();

    for (const name of [
      'getDraft', 'setDraft', 'clearDraft', 'flushDraft',
      'getDraftAttachmentPending', 'setDraftAttachmentPending',
    ]) {
      expect(BridgeRegistry.has(name)).toBe(false);
    }
  });
});

describe('debounce', () => {
  it('yazma HEMEN diske inmez (her tuşta senkron yazma yok)', () => {
    setDraft('yarım');

    expect(localStorage.getItem(draftKey(channelDraft('ch-1'))!)).toBeNull();
  });

  it('bekleme dolunca diske iner', () => {
    setDraft('yarım mesaj');
    settle();

    expect(peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '').toBe('yarım mesaj');
  });

  it('hızlı ardışık yazmalar TEK yazma üretir (son değer kazanır)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');

    setDraft('a');
    setDraft('ab');
    setDraft('abc');
    settle();

    expect(spy).not.toHaveBeenCalled();
    expect(getDraft()).toBe('abc');
  });

  it('bekleme dolmadan da getDraft en güncel metni döndürür', () => {
    setDraft('henüz yazılmadı');

    // Depoda yok ama kullanıcı açısından taslak bu — kanal geçişinde kaybolmaz.
    expect(getDraft()).toBe('henüz yazılmadı');
  });

  it('flushDraft beklemeyi kısa keser', () => {
    setDraft('hemen yaz');
    flushDraft();

    expect(peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '').toBe('hemen yaz');
  });
});

describe('kanal geçişi — A → B → A', () => {
  it('taslaklar kanallar arasında korunur ve karışmaz', () => {
    setDraft('A taslağı');
    settle();

    channel = { _id: 'ch-2', type: 'text', serverId: 'srv-1' };
    expect(getDraft()).toBe('');           // B boş başlar
    setDraft('B taslağı');
    settle();

    channel = { _id: 'ch-1', type: 'text', serverId: 'srv-1' };
    expect(getDraft()).toBe('A taslağı');  // A geri geldi

    channel = { _id: 'ch-2', type: 'text', serverId: 'srv-1' };
    expect(getDraft()).toBe('B taslağı');  // B kendi içeriğini korudu
  });

  it('BEKLEYEN yazma kanal değişince ESKİ kanala iner (yenisini ezmez)', () => {
    setDraft('A için yazılıyor');   // debounce açık, henüz diske inmedi

    channel = { _id: 'ch-2', type: 'text', serverId: 'srv-1' };
    flushDraft();                    // composer kanal geçişinde bunu çağırır

    expect(peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '').toBe('A için yazılıyor');
    expect(peekLocalFirstDraft(channelDraft('ch-2'))?.text ?? '').toBe('');
  });

  it('bayat bekleyen yazma YENİ kanalın taslağını ezmez', () => {
    setDraft('A metni');             // ch-1 için bekliyor

    channel = { _id: 'ch-2', type: 'text', serverId: 'srv-1' };
    setDraft('B metni');             // ch-2 için — önceki otomatik flush olmalı
    settle();

    expect(peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '').toBe('A metni');
    expect(peekLocalFirstDraft(channelDraft('ch-2'))?.text ?? '').toBe('B metni');
  });
});

describe('DM izolasyonu', () => {
  it('aynı id\'li DM ve kanal taslakları birbirini ezmez', () => {
    channel = { _id: 'conv-1', type: 'text', serverId: 'srv-1' };
    setDraft('kanal metni');
    settle();

    channel = { _id: 'conv-1', type: 'dm' };
    expect(getDraft()).toBe('');     // DM ayrı kova
    setDraft('dm metni');
    settle();

    channel = { _id: 'conv-1', type: 'text', serverId: 'srv-1' };
    expect(getDraft()).toBe('kanal metni');

    channel = { _id: 'conv-1', type: 'dm' };
    expect(getDraft()).toBe('dm metni');
  });

  it('DM A → DM B → DM A içerikleri korunur', () => {
    channel = { _id: 'dm-a', type: 'dm' };
    setDraft('dm-a metni'); settle();

    channel = { _id: 'dm-b', type: 'dm' };
    setDraft('dm-b metni'); settle();

    channel = { _id: 'dm-a', type: 'dm' };
    expect(getDraft()).toBe('dm-a metni');
    channel = { _id: 'dm-b', type: 'dm' };
    expect(getDraft()).toBe('dm-b metni');
  });

  it('GDM aynı id\'li DM taslağından ayrı tutulur', () => {
    channel = { _id: 'shared-conv', type: 'dm' };
    setDraft('dm metni'); settle();
    channel = { _id: 'shared-conv', type: 'gdm' };
    expect(getDraft()).toBe('');
    setDraft('gdm metni'); settle();

    channel = { _id: 'shared-conv', type: 'dm' };
    expect(getDraft()).toBe('dm metni');
    channel = { _id: 'shared-conv', type: 'group-dm' };
    expect(getDraft()).toBe('gdm metni');
  });

  it('aynı kanal id farklı sunucularda taslak sızdırmaz', () => {
    channel = { _id: 'same-channel', type: 'text', serverId: 'srv-1' };
    setDraft('sunucu bir'); settle();
    channel = { _id: 'same-channel', type: 'text', serverId: 'srv-2' };
    expect(getDraft()).toBe('');
    setDraft('sunucu iki'); settle();

    channel = { _id: 'same-channel', type: 'text', serverId: 'srv-1' };
    expect(getDraft()).toBe('sunucu bir');
    channel = { _id: 'same-channel', type: 'text', serverId: 'srv-2' };
    expect(getDraft()).toBe('sunucu iki');
  });
});

describe('kullanıcı izolasyonu', () => {
  it('A kullanıcısının taslağı B kullanıcısına GÖRÜNMEZ', () => {
    setDraft('A kullanıcısının gizli metni');
    settle();

    me = { _id: 'user-b' };
    expect(getDraft()).toBe('');
  });

  it('kullanıcı geri dönünce KENDİ taslağını bulur', () => {
    setDraft('a metni'); settle();
    me = { _id: 'user-b' };
    setDraft('b metni'); settle();

    me = { _id: 'user-a' };
    expect(getDraft()).toBe('a metni');
    me = { _id: 'user-b' };
    expect(getDraft()).toBe('b metni');
  });

  it('oturum yokken taslak yazılmaz (anonim kovaya sızma yok)', () => {
    me = null;
    setDraft('oturumsuz metin');
    settle();

    expect(localStorage.length).toBe(0);
  });

  it('oturum yokken okuma boş döner', () => {
    setDraft('a metni'); settle();
    me = null;

    expect(getDraft()).toBe('');
  });

  it('çıkış bekleyen yazmayı İPTAL eder (eski kullanıcı anahtarına yazılmaz)', () => {
    setDraft('çıkarken yazılan');    // debounce açık

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    me = null;
    settle();

    expect(localStorage.length).toBe(0);
  });
});

describe('temizleme', () => {
  it('yalnız attachment recovery hint saklar ve açıkça temizler', () => {
    BridgeRegistry.call('setDraftAttachmentPending', true);
    expect(BridgeRegistry.call('getDraftAttachmentPending')).toBe(true);
    expect(getDraft()).toBe('');

    BridgeRegistry.call('setDraftAttachmentPending', false);
    expect(BridgeRegistry.call('getDraftAttachmentPending')).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('clearDraft mevcut konuşmanın taslağını siler', () => {
    setDraft('gidecek'); settle();

    clearDraft();

    expect(getDraft()).toBe('');
  });

  it('clearDraft bekleyen yazmayı da iptal eder (silinen taslak geri gelmez)', () => {
    setDraft('gidecek');   // henüz diske inmedi
    clearDraft();
    settle();

    expect(getDraft()).toBe('');
    expect(localStorage.length).toBe(0);
  });

  it('BELİRTİLEN kanalın taslağı silinir — kullanıcı başka kanaldayken bile', () => {
    setDraft('ch-1 metni'); settle();
    channel = { _id: 'ch-2', type: 'text', serverId: 'srv-1' };
    setDraft('ch-2 metni'); settle();

    // ACK ch-1 için geldi (kullanıcı bu arada ch-2'ye geçti)
    clearDraft('ch-1', 'channel', 'srv-1');

    expect(peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '').toBe('');
    expect(peekLocalFirstDraft(channelDraft('ch-2'))?.text ?? '').toBe('ch-2 metni');
  });

  it('yanlış kanalın ACK\'i mevcut kanalın taslağını SİLMEZ', () => {
    setDraft('korunmalı'); settle();

    clearDraft('baska-kanal', 'channel', 'srv-1');

    expect(getDraft()).toBe('korunmalı');
  });
});

describe('yaşam döngüsü', () => {
  it('unmount bekleyen taslağı KAYBETMEZ (diske indirir)', () => {
    setDraft('unmount öncesi metin');   // debounce açık

    unmountManager();

    expect(peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '').toBe('unmount öncesi metin');
  });

  it('unmount sonrası bekleyen zamanlayıcı ateşlenmez', () => {
    setDraft('metin');
    unmountManager();

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });

  it('depolama arızası taslak API\'sini çökertmez', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(() => { setDraft('metin'); settle(); }).not.toThrow();
    expect(() => getDraft()).not.toThrow();
  });
});

describe('çift yönetici', () => {
  it('ikinci DraftManager mount edilirse durum bozulmaz', () => {
    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    const second = mount(DraftManager, { target: host2 });
    flushSync();

    // Registry son kaydı kullanır; taslak yine tek anahtara yazılır.
    setDraft('tek metin');
    settle();

    expect(peekLocalFirstDraft(channelDraft('ch-1'))?.text ?? '').toBe('tek metin');

    unmount(second);
    host2.remove();
    flushSync();
  });
});
