// client/tests/command-palette.test.ts
// Faz 8.1 — Komut paleti (Ctrl/Cmd+K) davranış testleri.
//
// Kaybolan davranışın geri kazanımını korur: CommandPalettePanel.svelte 397
// satırlık GERÇEK bir implementasyondu, ancak `command-palette-svelte.ts`
// shim'i hiçbir yerden import edilmediği için kullanıcıya hiç ulaşmıyordu.
// app.ts artık shim'i import ediyor; bu testler bağlantının kopmasını engeller.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import CommandPalettePanel from '../js/core/CommandPalettePanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { clearPermsCache } from '../js/core/permissions/myPermissions.ts';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;

interface TestCommand { id: string; label: string; category: string; keywords: string[]; action: () => void }

/**
 * `extraCommands` registry'de DİZİ olarak tutulur (CommandPalettePanel.svelte:169
 * doğrudan spread eder). BridgeRegistry imzası fonksiyon beklediği için cast
 * gerekiyor — çalışma zamanı davranışı ürün koduyla birebir aynı.
 */
function registerExtraCommands(cmds: TestCommand[]): void {
  BridgeRegistry.register('extraCommands', cmds as unknown as AnyFn);
}

/** Paleti açıp arama kutusuna yazar; tek komuta filtrelenmiş listeyi döndürür. */
function openAndSearch(term: string): void {
  pressGlobal('k', { ctrlKey: true });
  const input = document.querySelector<HTMLInputElement>('.cp-input')!;
  input.value = term;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

/** Svelte 5 DOM'u mikrotaskta günceller; testte deterministik olsun diye flush. */
const panel = () => { flushSync(); return document.querySelector('.cp-panel'); };
const items = () => { flushSync(); return [...document.querySelectorAll('.cp-item')]; };

function pressGlobal(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(ev);
  flushSync();
  return ev;
}

/** Panel içi tuşlar: gerçekte odak input'tadır, olay panele bubble eder. */
function pressInPanel(key: string): void {
  const input = document.querySelector('.cp-input');
  (input ?? document.querySelector('.cp-panel'))!
    .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  flushSync();
}

beforeEach(() => {
  host = document.createElement('div');
  host.id = 'command-palette-root';
  document.body.appendChild(host);
  instance = mount(CommandPalettePanel, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  document.getElementById('command-palette-root')?.remove(); // shim'in kendi kökü
  for (const key of [
    'extraCommands', 'cycleTheme', 'openSettingsModal', 'openSearch',
    'showFriendsPanel', 'showInbox', 'showSaved', 'showDmPanel', 'showGroupDmPanel',
    'getCurrentServerChannels', 'navigateToChannel', 'getAvailableServers', 'selectServer',
    'getDmConversations', 'openDm', 'groupDmPanel:getGroups', 'groupDmPanel:openGroupDm',
    'getCurrentServerMembers', 'getMe', 'me', 'openMemberProfile', 'currentServer',
    'openInvitePanel', 'openCreateChannel', 'openServerSettings',
    'voicePanel:toggleMute', 'voicePanel:toggleDeafen', 'voicePanel:leaveVoice',
    'voicePanel:getControlState',
    'openVoiceCheck',
    'showOnboardingWizard', 'openGlobalSearch', 'openNotificationPrefs',
  ]) BridgeRegistry.unregister(key);
  clearPermsCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('command palette (CommandPalettePanel)', () => {
  it('varsayılan olarak KAPALIDIR (mount kullanıcıyı rahatsız etmez)', () => {
    expect(panel()).toBeNull();
  });

  it('mount olunca registry sözleşmesini kurar', () => {
    expect(BridgeRegistry.has('openCommandPalette')).toBe(true);
    expect(BridgeRegistry.has('closeCommandPalette')).toBe(true);
  });

  it('Ctrl+K paleti açar (kaybolan davranış)', () => {
    const ev = pressGlobal('k', { ctrlKey: true });

    expect(panel()).not.toBeNull();
    expect(ev.defaultPrevented).toBe(true); // tarayıcı arama çubuğuna gitmez
  });

  it('Cmd+K (macOS) da paleti açar', () => {
    pressGlobal('k', { metaKey: true });
    expect(panel()).not.toBeNull();
  });

  it('modifier olmadan "k" paleti açmaz (yazarken tetiklenmez)', () => {
    pressGlobal('k');
    expect(panel()).toBeNull();
  });

  it('Ctrl+K ikinci kez basıldığında kapatır (toggle)', () => {
    pressGlobal('k', { ctrlKey: true });
    expect(panel()).not.toBeNull();

    pressGlobal('k', { ctrlKey: true });
    expect(panel()).toBeNull();
  });

  it('Escape paleti kapatır', () => {
    pressGlobal('k', { ctrlKey: true });
    expect(panel()).not.toBeNull();

    pressInPanel('Escape');
    expect(panel()).toBeNull();
  });

  it('açılışta arama kutusu ODAKLANIR (tarayıcıda kaçan hata)', async () => {
    pressGlobal('k', { ctrlKey: true });
    await Promise.resolve(); // odak queueMicrotask ile veriliyor

    expect(document.activeElement).toBe(document.querySelector('.cp-input'));
  });

  it('kapanıp tekrar açılınca odak YİNE arama kutusuna gider', async () => {
    pressGlobal('k', { ctrlKey: true });
    await Promise.resolve();
    pressGlobal('k', { ctrlKey: true }); // kapat
    flushSync();

    pressGlobal('k', { ctrlKey: true }); // tekrar aç
    await Promise.resolve();

    // Regression: $effect yalnızca `query`'yi izlediği için ikinci açılışta
    // odak verilmiyordu (sorgu her iki açılışta da '' olduğundan effect
    // yeniden çalışmıyordu).
    expect(document.activeElement).toBe(document.querySelector('.cp-input'));
  });

  it('kapanınca odağı paleti açan denetime geri verir', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Paleti aç';
    document.body.appendChild(trigger);
    trigger.focus();

    pressGlobal('k', { ctrlKey: true });
    await Promise.resolve();
    expect(document.activeElement).toBe(document.querySelector('.cp-input'));

    pressInPanel('Escape');
    await Promise.resolve();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });

  it('Tab ve Shift+Tab odağı modalın içinde sarar', async () => {
    pressGlobal('k', { ctrlKey: true });
    await Promise.resolve();

    const p = panel() as HTMLElement;
    const focusable = [...p.querySelectorAll<HTMLElement>(
      'input:not([disabled]),button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])',
    )];
    const first = focusable[0];
    const last = focusable.at(-1)!;

    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
  });

  it('odak panel DIŞINDAYKEN de Escape kapatır (modal davranışı)', () => {
    pressGlobal('k', { ctrlKey: true });
    expect(panel()).not.toBeNull();

    // Gerçek tarayıcıda odak body'de kalabiliyor; olay window'a düşer.
    document.body.focus();
    pressGlobal('Escape');

    expect(panel()).toBeNull();
  });

  it('odak panel dışındayken Enter komutu YALNIZCA BİR KEZ çalıştırır', () => {
    const action = vi.fn();
    registerExtraCommands([
      { id: 'once', label: 'Zzz Tek', category: 'Test', keywords: ['zzzonce'], action },
    ]);

    openAndSearch('zzzonce');
    document.body.focus();
    pressGlobal('Enter'); // window handler → panel handler'a devreder

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('ArrowDown/ArrowUp seçimi taşır ve sınırların dışına çıkmaz', () => {
    registerExtraCommands([
      { id: 'first', label: 'Birinci', category: 'Test', keywords: ['bir'], action: vi.fn() },
      { id: 'second', label: 'İkinci', category: 'Test', keywords: ['iki'], action: vi.fn() },
    ]);
    pressGlobal('k', { ctrlKey: true });
    const selectedId = () => document.querySelector('.cp-item.selected')?.id;

    const first = selectedId();
    expect(first).toBeDefined();

    pressInPanel('ArrowDown');
    expect(selectedId()).not.toBe(first);

    pressInPanel('ArrowUp');
    expect(selectedId()).toBe(first);

    pressInPanel('ArrowUp'); // üst sınır — taşma yok
    expect(selectedId()).toBe(first);
  });

  it('Enter seçili komutu YALNIZCA BİR KEZ çalıştırır ve paleti kapatır', () => {
    const action = vi.fn();
    registerExtraCommands([
      { id: 'test-cmd', label: 'Zzz Test Komutu', category: 'Test', keywords: ['zzztest'], action },
    ]);

    openAndSearch('zzztest');
    expect(items()).toHaveLength(1); // filtre tek komuta indirdi

    pressInPanel('Enter');

    expect(action).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull(); // çalıştırma sonrası kapanır
  });

  it('tema komutu canonical cycleTheme registry eylemini kullanır', () => {
    const cycleTheme = vi.fn();
    BridgeRegistry.register('cycleTheme', cycleTheme);

    openAndSearch('Temayı Değiştir');
    pressInPanel('Enter');

    expect(cycleTheme).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  it('ayarlar komutu canonical settings modal owner\'ını açar', () => {
    const openSettings = vi.fn();
    BridgeRegistry.register('openSettingsModal', openSettings);

    openAndSearch('Ayarları Aç');
    pressInPanel('Enter');

    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('kanal araması kanonik navigateToChannel eylemine gider', () => {
    const navigate = vi.fn();
    BridgeRegistry.register('getCurrentServerChannels', () => [
      { _id: 'channel-general', name: 'general', type: 'text' },
      { _id: 'channel-voice', name: 'General Voice', type: 'voice' },
    ]);
    BridgeRegistry.register('navigateToChannel', navigate);

    openAndSearch('Kanala Git: General Voice');
    expect(items()).toHaveLength(1);
    pressInPanel('Enter');

    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('channel-voice');
  });

  it('sunucu araması kanonik selectServer eylemine tam sunucu nesnesini verir', () => {
    const select = vi.fn();
    const target = { _id: 'server-2', name: 'Design Guild' };
    BridgeRegistry.register('getAvailableServers', () => [{ _id: 'server-1', name: 'Bridge' }, target]);
    BridgeRegistry.register('selectServer', select);

    openAndSearch('Sunucuya Git: Design Guild');
    pressInPanel('Enter');

    expect(select).toHaveBeenCalledWith(target);
  });

  it('Friends / Inbox / Saved yalnız canlı sahipleri varsa görünür ve çalışır', () => {
    const friends = vi.fn();
    const inbox = vi.fn();
    const saved = vi.fn();
    BridgeRegistry.register('showFriendsPanel', friends);
    BridgeRegistry.register('showInbox', inbox);
    BridgeRegistry.register('showSaved', saved);

    openAndSearch('Gelen Kutusunu Aç');
    pressInPanel('Enter');
    expect(inbox).toHaveBeenCalledOnce();

    openAndSearch('Kaydedilenler / Takip');
    pressInPanel('Enter');
    expect(saved).toHaveBeenCalledOnce();

    BridgeRegistry.unregister('showFriendsPanel');
    openAndSearch('Arkadaşları Aç');
    expect(items()).toHaveLength(0);
  });

  it('DM ve GDM sonuçları mevcut konuşma sahiplerini yeniden kullanır', () => {
    const openDm = vi.fn();
    const openGdm = vi.fn();
    const group = { _id: 'gdm-1', name: 'Launch Crew' };
    BridgeRegistry.register('getDmConversations', () => [
      { _id: 'dm-1', other: { _id: 'user-2', displayName: 'Ada', avatarColor: '#123456' } },
    ]);
    BridgeRegistry.register('openDm', openDm);
    BridgeRegistry.register('groupDmPanel:getGroups', () => [group]);
    BridgeRegistry.register('groupDmPanel:openGroupDm', openGdm);

    openAndSearch('DM Aç: Ada');
    pressInPanel('Enter');
    expect(openDm).toHaveBeenCalledWith('user-2', 'Ada', '#123456');

    openAndSearch('Grup DM Aç: Launch Crew');
    pressInPanel('Enter');
    expect(openGdm).toHaveBeenCalledWith(group);
  });

  it('People komutları üyeyi mesaj/profil sahiplerine yollar; kendine DM önermez', () => {
    const openDm = vi.fn();
    const openProfile = vi.fn();
    BridgeRegistry.register('getMe', () => ({ _id: 'me', displayName: 'Ben' }));
    BridgeRegistry.register('getCurrentServerMembers', () => [
      { _id: 'me', displayName: 'Ben' },
      { _id: 'user-2', displayName: '<img src=x onerror=alert(1)>', username: 'safe-user' },
    ]);
    BridgeRegistry.register('openDm', openDm);
    BridgeRegistry.register('openMemberProfile', openProfile);

    openAndSearch('Mesaj Gönder: Ben');
    expect(items()).toHaveLength(0);

    pressGlobal('k', { ctrlKey: true }); // kapat
    openAndSearch('Mesaj Gönder: <img');
    expect(document.querySelector('.cp-item-label')?.textContent).toContain('<img src=x');
    expect(document.querySelector('.cp-item-label img')).toBeNull();
    pressInPanel('Enter');
    expect(openDm).toHaveBeenCalledWith('user-2', '<img src=x onerror=alert(1)>', undefined);

    openAndSearch('Profili Görüntüle: <img');
    pressInPanel('Enter');
    expect(openProfile).toHaveBeenCalledWith('user-2');
  });

  it('sunucu yönetim komutlarını yetki yanıtı gelmeden göstermez; MANAGE_CHANNELS ile açar', async () => {
    const createChannel = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ permissions: 1 << 1 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    BridgeRegistry.register('currentServer', () => ({ _id: 'server-1', name: 'Bridge' }));
    BridgeRegistry.register('openCreateChannel', createChannel);

    pressGlobal('k', { ctrlKey: true });
    const input = document.querySelector<HTMLInputElement>('.cp-input')!;
    input.value = 'Kanal Oluştur';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(items()).toHaveLength(0); // fail-closed while permission is unknown

    await vi.waitFor(() => expect(items()).toHaveLength(1));
    pressInPanel('Enter');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/servers/server-1/me/permissions'),
      expect.anything(),
    );
    expect(createChannel).toHaveBeenCalledOnce();
  });

  it('yetkisiz yönetim eylemlerini gizler; rol yöneticisini roles sekmesine yollar', async () => {
    const openSettings = vi.fn();
    let permissionBits = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ permissions: permissionBits }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    BridgeRegistry.register('currentServer', () => ({ _id: 'server-1', name: 'Bridge' }));
    BridgeRegistry.register('openServerSettings', openSettings);
    BridgeRegistry.register('openCreateChannel', vi.fn());

    openAndSearch('Sunucu Ayarları');
    await vi.waitFor(() => expect(items()).toHaveLength(0));
    expect(document.querySelector('.cp-empty')).not.toBeNull();
    pressGlobal('k', { ctrlKey: true }); // kapat

    clearPermsCache();
    permissionBits = 1 << 2; // MANAGE_ROLES
    openAndSearch('Sunucu Ayarları');
    await vi.waitFor(() => expect(items()).toHaveLength(1));
    pressInPanel('Enter');

    expect(openSettings).toHaveBeenCalledWith('roles');
  });

  it('ses kanalından ayrıl komutu yalnız bağlantı ve gerçek owner varken görünür', () => {
    const leave = vi.fn();
    BridgeRegistry.register('voicePanel:getControlState', () => ({ inVoice: true }));

    openAndSearch('Ses Kanalından Ayrıl');
    expect(items()).toHaveLength(0);

    BridgeRegistry.register('voicePanel:leaveVoice', leave);
    pressGlobal('k', { ctrlKey: true }); // kapat
    openAndSearch('Ses Kanalından Ayrıl');
    pressInPanel('Enter');

    expect(leave).toHaveBeenCalledOnce();
  });

  it('ulaşılamayan ses komutlarını sahte eylem olarak göstermez', () => {
    openAndSearch('Mikrofonu Aç/Kapat');
    expect(items()).toHaveLength(0);

    BridgeRegistry.register('voicePanel:toggleMute', vi.fn());
    BridgeRegistry.register('voicePanel:getControlState', () => ({ inVoice: true }));
    pressGlobal('k', { ctrlKey: true }); // close
    openAndSearch('Mikrofonu Aç/Kapat');
    expect(items()).toHaveLength(1);
  });

  it('Voice Check yalnız gerçek sahibi varken görünür ve o sahibi çağırır', () => {
    openAndSearch('Voice Check');
    expect(items()).toHaveLength(0);

    const openVoiceCheck = vi.fn();
    BridgeRegistry.register('openVoiceCheck', openVoiceCheck);
    pressGlobal('k', { ctrlKey: true }); // kapat
    openAndSearch('Voice Check');
    expect(items()).toHaveLength(1);
    pressInPanel('Enter');

    expect(openVoiceCheck).toHaveBeenCalledOnce();
  });

  it('komuta tıklamak eylemi bir kez çalıştırır', () => {
    const action = vi.fn();
    registerExtraCommands([
      { id: 'click-cmd', label: 'Zzz Tıklama', category: 'Test', keywords: ['zzzclick'], action },
    ]);

    openAndSearch('zzzclick');
    (items()[0] as HTMLElement).click();
    flushSync();

    expect(action).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  it('komut fırlatırsa palet yine kapanır (tek hata tüm UI\'yı kilitlemez)', () => {
    registerExtraCommands([
      {
        id: 'boom', label: 'Zzz Patlayan', category: 'Test', keywords: ['zzzboom'],
        action: () => { throw new Error('kasıtlı hata'); },
      },
    ]);

    openAndSearch('zzzboom');

    expect(() => (items()[0] as HTMLElement).click()).not.toThrow();
    expect(panel()).toBeNull();
  });

  it('eşleşme yoksa boş durum gösterilir (sessiz kalmaz)', () => {
    openAndSearch('qqqxyz-boyle-bir-komut-yok');

    expect(items()).toHaveLength(0);
    expect(document.querySelector('.cp-empty')).not.toBeNull();
  });

  it('erişilebilirlik sözleşmesi korunur (modal dialog + listbox)', () => {
    pressGlobal('k', { ctrlKey: true });

    const p = panel()!;
    expect(p.getAttribute('role')).toBe('dialog');
    expect(p.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('#cp-listbox')!.getAttribute('role')).toBe('listbox');
  });

  it('unmount sonrası kayıtlar ve klavye dinleyicisi kalmaz (leak yok)', () => {
    unmount(instance!);
    instance = null;
    flushSync();

    expect(BridgeRegistry.has('openCommandPalette')).toBe(false);
    expect(BridgeRegistry.has('closeCommandPalette')).toBe(false);

    // <svelte:window> dinleyicisi de kalkmış olmalı: kısayol artık panel açmaz
    pressGlobal('k', { ctrlKey: true });
    expect(document.querySelector('.cp-panel')).toBeNull();
  });

  it('malformed registry listelerini ve tehlikeli/çakışan extra komutları fail-closed eler', () => {
    const navigate = vi.fn();
    const canonicalSettings = vi.fn();
    const duplicateAction = vi.fn();
    BridgeRegistry.register('navigateToChannel', navigate);
    BridgeRegistry.register('openSettingsModal', canonicalSettings);
    BridgeRegistry.register('getCurrentServerChannels', (() => [
      null, 42, { _id: {} },
      { _id: 'safe-channel', name: 'Safe' },
      { _id: 'safe-channel', name: 'Duplicate' },
    ]) as AnyFn);
    BridgeRegistry.register('getCurrentServerMembers', (() => [null, 'bad', { _id: {} }]) as AnyFn);
    BridgeRegistry.register('extraCommands', [
      null,
      { id: 'no-action', label: 'No action' },
      { id: 'bad id with spaces', label: 'Unsafe id', action: vi.fn() },
      { id: 'bad-available', label: 'Bad available', action: vi.fn(), available: 'yes' },
      { id: 'open-settings', label: 'Shadow settings', action: duplicateAction },
      { id: 'throws-availability', label: 'Throws availability', action: vi.fn(), available: () => { throw new Error('bad owner'); } },
    ] as unknown as AnyFn);

    expect(() => openAndSearch('Kanala Git: Safe')).not.toThrow();
    expect(items()).toHaveLength(1);
    pressInPanel('Enter');
    expect(navigate).toHaveBeenCalledWith('safe-channel');

    openAndSearch('Shadow settings');
    expect(items()).toHaveLength(0); // canonical id wins; extra cannot shadow it
    expect(duplicateAction).not.toHaveBeenCalled();

    pressGlobal('k', { ctrlKey: true });
    openAndSearch('Throws availability');
    expect(items()).toHaveLength(0);
  });

  it('registry getter fırlatsa bile palet açılır ve bozuk kaynağı komut diye sunmaz', () => {
    BridgeRegistry.register('getCurrentServerChannels', (() => { throw new Error('stale owner'); }) as AnyFn);
    BridgeRegistry.register('navigateToChannel', vi.fn());
    BridgeRegistry.register('currentServer', (() => { throw new Error('stale server'); }) as AnyFn);

    expect(() => openAndSearch('Kanala Git')).not.toThrow();
    expect(panel()).not.toBeNull();
    expect(items()).toHaveLength(0);
  });

  it('logout veya sunucu değişimi eski tenant komut closurelarını kapatır', () => {
    const navigate = vi.fn();
    BridgeRegistry.register('getCurrentServerChannels', () => [{ _id: 'tenant-a-private', name: 'A Private' }]);
    BridgeRegistry.register('navigateToChannel', navigate);

    openAndSearch('A Private');
    expect(items()).toHaveLength(1);
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'tenant-b' } }));
    flushSync();
    expect(panel()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    openAndSearch('A Private');
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();
    expect(panel()).toBeNull();
  });

  it('izin isteğinde sunucu kimliğini tek URL segmenti olarak kodlar', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ permissions: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    BridgeRegistry.register('currentServer', () => ({ _id: 'srv/../other-tenant' }));

    pressGlobal('k', { ctrlKey: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/srv%2F..%2Fother-tenant/me/permissions');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('/srv/../other-tenant/');
  });

  it('async reddedilen komut unhandled rejection üretmeden kapanır', async () => {
    const rejection = new Error('async owner failed');
    BridgeRegistry.register('extraCommands', [{
      id: 'async-fail', label: 'Zzz Async Fail', category: 'Test', keywords: ['zzzasync'],
      action: () => Promise.reject(rejection),
    }] as unknown as AnyFn);

    openAndSearch('zzzasync');
    (items()[0] as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel()).toBeNull();
  });

  it('uygulama, sunucu ve ses komutları yalnız canlı sahiplerine delege edilir', () => {
    const invite = vi.fn();
    const onboarding = vi.fn();
    const globalSearch = vi.fn();
    const notificationPrefs = vi.fn();
    const serverSearch = vi.fn();
    const mute = vi.fn();
    const deafen = vi.fn();
    BridgeRegistry.register('currentServer', () => ({ _id: 'srv-1' }));
    BridgeRegistry.register('openInvitePanel', invite);
    BridgeRegistry.register('showOnboardingWizard', onboarding);
    BridgeRegistry.register('openGlobalSearch', globalSearch);
    BridgeRegistry.register('openNotificationPrefs', notificationPrefs);
    BridgeRegistry.register('openSearch', serverSearch);
    BridgeRegistry.register('voicePanel:getControlState', () => ({ inVoice: true }));
    BridgeRegistry.register('voicePanel:toggleMute', mute);
    BridgeRegistry.register('voicePanel:toggleDeafen', deafen);

    for (const [term, action, args] of [
      ['Kişileri Davet Et', invite, []],
      ['Tanıtım Turunu Göster', onboarding, []],
      ['Tüm Mesajlarda Ara', globalSearch, []],
      ['Bildirim Ayarları', notificationPrefs, []],
      ['Sunucuda Ara', serverSearch, ['srv-1']],
      ['Mikrofonu Aç/Kapat', mute, []],
      ['Hoparlörü Aç/Kapat', deafen, []],
    ] as const) {
      openAndSearch(term);
      expect(items()).toHaveLength(1);
      pressInPanel('Enter');
      expect(action).toHaveBeenLastCalledWith(...args);
    }
  });

  it('Friends, DM panel ve GDM panel gezinmeleri eski state kopyalamadan canlı sahiplerini çağırır', () => {
    const friends = vi.fn();
    const dms = vi.fn();
    const gdms = vi.fn();
    BridgeRegistry.register('showFriendsPanel', friends);
    BridgeRegistry.register('showDmPanel', dms);
    BridgeRegistry.register('showGroupDmPanel', gdms);

    for (const [term, action] of [
      ['Arkadaşları Aç', friends],
      ['Direkt Mesajları Aç', dms],
      ['Grup DM’leri Aç', gdms],
    ] as const) {
      openAndSearch(term);
      pressInPanel('Enter');
      expect(action).toHaveBeenCalledOnce();
    }
  });

  it('malformed server/DM/GDM satırlarını eler; adsız geçerli kimlikleri güvenli fallback ile açar', () => {
    const selectServer = vi.fn();
    const openDm = vi.fn();
    const openGroup = vi.fn();
    BridgeRegistry.register('getAvailableServers', (() => [null, 9, { _id: {} }, { _id: 'server-safe' }]) as AnyFn);
    BridgeRegistry.register('selectServer', selectServer);
    BridgeRegistry.register('getDmConversations', (() => [
      null, { other: null }, { other: { _id: {} } },
      { other: { id: 'person-safe', username: 'fallback-user' } },
      { other: { id: 'person-safe', username: 'duplicate' } },
    ]) as AnyFn);
    BridgeRegistry.register('openDm', openDm);
    BridgeRegistry.register('groupDmPanel:getGroups', (() => [null, { _id: {} }, { _id: 'group-safe' }]) as AnyFn);
    BridgeRegistry.register('groupDmPanel:openGroupDm', openGroup);

    openAndSearch('Sunucuya Git: server-safe');
    pressInPanel('Enter');
    expect(selectServer).toHaveBeenCalledWith({ _id: 'server-safe', name: 'server-safe' });

    openAndSearch('DM Aç: fallback-user');
    expect(items()).toHaveLength(1);
    pressInPanel('Enter');
    expect(openDm).toHaveBeenCalledWith('person-safe', 'fallback-user', undefined);

    openAndSearch('Grup DM Aç: group-safe');
    pressInPanel('Enter');
    expect(openGroup).toHaveBeenCalledWith({ _id: 'group-safe', name: 'group-safe' });
  });

  it('getMe sahibi fırladığında kişi komutları fail-closed kullanıcı kapsamıyla çalışmaya devam eder', () => {
    const openDm = vi.fn();
    BridgeRegistry.register('getMe', (() => { throw new Error('stale identity owner'); }) as AnyFn);
    BridgeRegistry.register('getCurrentServerMembers', () => [{ _id: 'member-1', nickname: 'Nora' }]);
    BridgeRegistry.register('openDm', openDm);

    expect(() => openAndSearch('Mesaj Gönder: Nora')).not.toThrow();
    pressInPanel('Enter');
    expect(openDm).toHaveBeenCalledWith('member-1', 'Nora', undefined);
  });

  it('mouse selection + Space activation works and optional/icon fallbacks remain keyboard reachable', () => {
    const actions = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    BridgeRegistry.register('extraCommands', [
      { id: 'copy-extra', label: 'Extra Copy', icon: 'copy', action: actions[0] },
      { id: 'bug-extra', label: 'Extra Bug', icon: 'bug', action: actions[1] },
      { id: 'keyboard-extra', label: 'Extra Keyboard', icon: 'keyboard', action: actions[2] },
      { id: 'status-extra', label: 'Extra Status', icon: 'status-idle', action: actions[3] },
      { id: 'fallback-extra', label: 'Extra Fallback', icon: 'custom', action: actions[4] },
      { id: 'hidden-extra', label: 'Must Stay Hidden', hidden: true, action: vi.fn() },
    ] as unknown as AnyFn);

    openAndSearch('Extra');
    expect(document.querySelector('.cp-category')?.textContent).toBe('Diğer');
    for (const cls of ['icon-copy', 'icon-bug', 'icon-keyboard', 'icon-status-idle', 'icon-custom']) {
      expect(document.querySelector(`.${cls}`)).not.toBeNull();
    }
    expect(document.body.textContent).not.toContain('Must Stay Hidden');

    const second = items()[1] as HTMLElement;
    second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    flushSync();
    expect(second.classList.contains('selected')).toBe(true);
    second.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    flushSync();
    expect(actions[1]).toHaveBeenCalledOnce();
    expect(panel()).toBeNull();
  });

  it('overlay tıklaması paleti kapatır ve normal kapanış odağı tetikleyiciye döndürür', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    pressGlobal('k', { ctrlKey: true });
    await Promise.resolve();

    (document.querySelector('.cp-overlay') as HTMLElement).click();
    flushSync();
    await Promise.resolve();

    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('sunucu izin yanıtı kapsam değiştikten sonra eski yönetim komutlarını yayınlamaz', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    vi.stubGlobal('fetch', vi.fn(() => pending));
    let serverId = 'server-a';
    BridgeRegistry.register('currentServer', () => ({ _id: serverId }));
    BridgeRegistry.register('openCreateChannel', vi.fn());

    openAndSearch('Kanal Oluştur');
    expect(items()).toHaveLength(0);
    serverId = 'server-b';
    resolve(new Response(JSON.stringify({ permissions: 1 << 1 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(items()).toHaveLength(0);
  });

  it('MANAGE_SERVER yetkisi ayarları general sekmesine yönlendirir', async () => {
    const settings = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ permissions: 1 << 3 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    BridgeRegistry.register('currentServer', () => ({ _id: 'server-general' }));
    BridgeRegistry.register('openServerSettings', settings);

    openAndSearch('Sunucu Ayarları');
    await vi.waitFor(() => expect(items()).toHaveLength(1));
    pressInPanel('Enter');
    expect(settings).toHaveBeenCalledWith('general');
  });

  it('compat identity and ID-only channel/member records keep safe, deterministic fallback labels', () => {
    const navigate = vi.fn();
    const profile = vi.fn();
    BridgeRegistry.register('me', () => ({ _id: 'self-id' }));
    BridgeRegistry.register('navigateToChannel', navigate);
    BridgeRegistry.register('getCurrentServerChannels', () => [{ _id: 'channel-id-only' }]);
    BridgeRegistry.register('getCurrentServerMembers', () => [{ id: 'member-id-only' }]);
    BridgeRegistry.register('openMemberProfile', profile);
    BridgeRegistry.register('getAvailableServers', (() => ({ not: 'an array' })) as AnyFn);
    BridgeRegistry.register('selectServer', vi.fn());

    openAndSearch('Kanala Git: channel-id-only');
    pressInPanel('Enter');
    expect(navigate).toHaveBeenCalledWith('channel-id-only');

    openAndSearch('Profili Görüntüle: member-id-only');
    pressInPanel('Enter');
    expect(profile).toHaveBeenCalledWith('member-id-only');

    openAndSearch('Sunucuya Git');
    expect(items()).toHaveLength(0);
  });

  it('non-command keys and empty Enter are inert; ESC closes safely when its original trigger disappeared', async () => {
    const noIcon = vi.fn();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    BridgeRegistry.register('extraCommands', [{
      id: 'no-icon-extra', label: 'No Icon Extra', action: noIcon,
    }] as unknown as AnyFn);

    openAndSearch('No Icon Extra');
    const row = items()[0] as HTMLElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    flushSync();
    expect(noIcon).not.toHaveBeenCalled();
    expect(row.querySelector('.cp-item-icon')).toBeNull();

    trigger.remove();
    (document.querySelector('.cp-esc') as HTMLButtonElement).click();
    flushSync();
    await Promise.resolve();
    expect(panel()).toBeNull();

    openAndSearch('definitely-empty-query');
    pressInPanel('Enter');
    expect(panel()).not.toBeNull();
    expect(noIcon).not.toHaveBeenCalled();
  });

  it('a search command rechecks server scope at execution and cannot navigate after a silent tenant loss', () => {
    let current: { _id: string } | null = { _id: 'tenant-a' };
    const search = vi.fn();
    BridgeRegistry.register('currentServer', () => current);
    BridgeRegistry.register('openSearch', search);

    openAndSearch('Sunucuda Ara');
    expect(items()).toHaveLength(1);
    current = null;
    (items()[0] as HTMLElement).click();
    flushSync();

    expect(search).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it('theme icon branch is rendered when the live theme owner is available', () => {
    BridgeRegistry.register('cycleTheme', vi.fn());
    openAndSearch('Temayı Değiştir');

    expect(items()).toHaveLength(1);
    expect(document.querySelector('.cp-item-icon.icon-theme svg')).not.toBeNull();
  });
});

describe('command palette shim (tek örnek garantisi)', () => {
  it('shim tekrar tekrar çağrılsa da TEK panel mount eder', async () => {
    // beforeEach'in mount ettiği örnek bu testte olmamalı: shim kendi örneğini
    // kuracak ve iki ayrı örnek iki <svelte:window> dinleyicisi demek olurdu.
    unmount(instance!);
    instance = null;
    host.remove();
    flushSync();

    // Shim modülü import anında kendini mount eder (DOM hazır durumda).
    // NOT: vi.resetModules() KULLANILMAZ — ikinci bir `svelte` runtime kopyası
    // oluşur ve bu dosyadaki flushSync o kopyanın kuyruğunu boşaltamaz.
    const shim = await import('../js/core/command-palette-svelte.ts');

    // Import sırasında bir kez mount oldu; ek çağrılar ve socket-ready olayı
    // ikinci bir panel/dinleyici oluşturmamalı.
    shim.mountCommandPalette();
    shim.mountCommandPalette();
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    flushSync();

    expect(document.querySelectorAll('#command-palette-root').length).toBe(1);

    // Tek dinleyici → Ctrl+K net "açık" durumu verir; çift dinleyici olsaydı
    // toggle iki kez çalışır ve panel kapalı kalırdı.
    pressGlobal('k', { ctrlKey: true });
    expect(document.querySelectorAll('.cp-panel').length).toBe(1);

    shim.unmountCommandPalette();
    flushSync();
    expect(document.querySelector('.cp-panel')).toBeNull();
  });
});
