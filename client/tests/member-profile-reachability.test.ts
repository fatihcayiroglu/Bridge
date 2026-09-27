// client/tests/member-profile-reachability.test.ts
// UX/P1 — ÜYE PROFİLİ ERİŞİLEBİLİRLİĞİ.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `js/profile.ts` gerçek bir profil modali içeriyordu AMA üretimde HİÇ
// YÜKLENMİYORDU: `index.html` yalnız `app.js` çeker ve `profile.js` ayrı bir
// build girdisiydi; hiçbir sayfa ve hiçbir `import()` onu talep etmiyordu.
// Sonuç: `openProfileModal` kaydı üretimde HİÇ OLUŞMUYORDU — profil, kaynakta
// var olmasına rağmen normal bir kullanıcı için ERİŞİLEMEZDİ.
//
// "Kaynakta var" ≠ "ürün var". Bu dosya erişilebilirliği DAVRANIŞLA kanıtlar.
//
// ════════════════════════════════════════════════════════════════════════════
// KORUNAN DEĞİŞMEZLER
// ════════════════════════════════════════════════════════════════════════════
// 1. Üye satırına tıklamak profili açar (tek profil yüzeyi).
// 2. "Mesaj gönder" KANONİK `openDm` sahibine delege eder — ikinci bir DM
//    durumu/soketi kurulmaz.
// 3. Tekrarlanan açılışlar ikinci bir sahip/yüzey üretmez.
// 4. Moderasyon eylemi RENDER EDİLMEZ — istemci sunucu yetkisi taklit etmez.
// 5. Düşmanca profil alanları stil/HTML enjeksiyonuna dönüşmez.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { mountMemberProfile, unmountMemberProfile } from '../js/core/member-profile-svelte.ts';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USER = {
  _id: 'u-42', id: 'u-42',
  username: 'ayse', displayName: 'Ayşe',
  avatarColor: '#112233', avatarUrl: null,
  status: 'online', statusText: 'Kod yazıyor', statusEmoji: '💻',
  bio: 'Bridge kullanıcısı', pronouns: 'o/onlar',
};

const ok = (b: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => b } as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;
let profileBody: unknown = USER;
let friendsList: Array<{ _id: string }> = [];
let friendRequestStatus = 200;

const card = () => document.querySelector('.mp-card');
const msgBtn = () => document.querySelector<HTMLButtonElement>('.mp-msg');

beforeEach(() => {
  unmountMemberProfile();
  document.body.innerHTML = '';
  profileBody = USER;
  friendsList = [];
  friendRequestStatus = 200;
  fetchMock = vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    if (url.includes('/api/friends/request')) return ok({ ok: true }, friendRequestStatus);
    if (url.includes('/api/friends/') && init?.method === 'DELETE') return ok({ ok: true });
    if (url.endsWith('/api/friends')) return ok(friendsList);
    return ok(profileBody);
  });
  BridgeRegistry.register('apiFetch', (...a: unknown[]) => fetchMock(...a));
  BridgeRegistry.register('me', () => ({ id: 'me-1' }));
});

afterEach(() => {
  unmountMemberProfile();
  for (const k of ['apiFetch', 'me', 'openMemberProfile', 'closeMemberProfile', 'openDm']) {
    BridgeRegistry.unregister(k);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function boot() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountMemberProfile(root);
  flushSync();
}
/** Profili acar ve VERI DOM'a yansiyana kadar bekler (fetch async'tir). */
async function open(id = 'u-42') {
  (BridgeRegistry.get<(i: string) => void>('openMemberProfile'))!(id);
  flushSync();
  await vi.waitFor(() => { flushSync(); expect(msgBtn()).not.toBeNull(); });
}

// ════════════════════════════════════════════════════════════════════════════
describe('ÜYE PROFİLİ — erişilebilirlik', () => {
  it('üretim giriş noktası profil köprüsünü İMPORT EDER', () => {
    const app = fs.readFileSync(path.join(CLIENT, 'js/app.ts'), 'utf8');
    expect(app).toMatch(/core\/member-profile-svelte/);
  });

  it('üye satırı profili açar (satır artık EYLEMSİZ değil)', () => {
    const src = fs.readFileSync(path.join(CLIENT, 'js/core/MemberListPanel.svelte'), 'utf8');

    expect(src).toMatch(/onclick=\{\(\) => openProfile\(member\)\}/);
    expect(src).toMatch(/openMemberProfile/);
    // Sahip kayıtlı değilse DM'e düşer — çökme yok.
    expect(src).toMatch(/startDm\(member\)/);
  });

  it('POZİTİF KONTROL: KANONİK uca gider ve profili gösterir', async () => {
    boot(); await open();

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/users/u-42');
    expect(card()).not.toBeNull();
    expect(document.body.textContent).toContain('Ayşe');
    expect(document.body.textContent).toContain('@ayse');
  });

  it('"Mesaj gönder" KANONİK openDm sahibine delege eder', async () => {
    const openDm = vi.fn();
    BridgeRegistry.register('openDm', openDm);
    boot(); await open();

    msgBtn()!.click();
    flushSync();

    expect(openDm).toHaveBeenCalledTimes(1);
    expect(openDm.mock.calls[0][0]).toBe('u-42');
    // Profil kapanır — iki yüzey aynı anda açık kalmaz.
    expect(card()).toBeNull();
  });

  it('TEKRARLANAN açılış tek yüzey ve tek sahip bırakır', async () => {
    boot();
    await open('u-42');
    await open('u-42');
    await open('u-42');

    expect(document.querySelectorAll('.mp-card')).toHaveLength(1);
    expect(document.querySelectorAll('.mp-msg')).toHaveLength(1);
  });

  it('MODERASYON eylemi render EDİLMEZ (yetki taklit edilmez)', async () => {
    boot(); await open();

    const text = document.body.textContent ?? '';
    for (const word of ['At', 'Yasakla', 'Sustur', 'Kick', 'Ban', 'Mute', 'Rol']) {
      expect(text).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
  });

  it('HATA durumunda uydurma profil gösterilmez', async () => {
    fetchMock = vi.fn(async () => ok({}, 500));
    boot();
    (BridgeRegistry.get<(i: string) => void>('openMemberProfile'))!('u-42');
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.mp-error')).not.toBeNull();
    });
    expect(msgBtn()).toBeNull();
  });

  it('Escape profili kapatır', async () => {
    boot(); await open();
    expect(card()).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();

    expect(card()).toBeNull();
  });

  it('GİZLİ profil Escape\'i YUTMAZ', () => {
    boot();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.removeEventListener('keydown', spy);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
  });

  it('unmount sonrası kayıtlar bırakılır', () => {
    boot();
    expect(BridgeRegistry.has('openMemberProfile')).toBe(true);

    unmountMemberProfile();
    flushSync();

    expect(BridgeRegistry.has('openMemberProfile')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ÜYE PROFİLİ — düşmanca veri', () => {
  it('kötü niyetli avatarColor STİL enjeksiyonuna dönüşmez', async () => {
    profileBody = { ...USER, avatarColor: 'red;background-image:url(//evil.test/x)' };
    boot(); await open();

    const style = document.querySelector('.mp-avatar')?.getAttribute('style') ?? '';
    expect(style).not.toContain('evil.test');
    // Güvenli olmayan değer kanonik jetona düşer.
    expect(style).toContain('var(--brand)');
  });

  it('javascript: avatar URL\'i KULLANILMAZ', async () => {
    profileBody = { ...USER, avatarUrl: 'javascript:alert(1)' };
    boot(); await open();

    expect(document.querySelector('.mp-avatar img')).toBeNull();
    expect(document.body.innerHTML).not.toContain('javascript:');
  });

  it('profil metinleri HTML olarak yorumlanmaz', async () => {
    profileBody = { ...USER, bio: '<img src=x onerror=alert(1)>', displayName: '<b>kalın</b>' };
    boot(); await open();

    expect(document.querySelector('.mp-bio img')).toBeNull();
    expect(document.querySelector('.mp-name b')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('bileşende {@html} sinki YOKTUR', () => {
    const raw = fs.readFileSync(path.join(CLIENT, 'js/core/MemberProfilePopover.svelte'), 'utf8');
    const src = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/\{@html/);
    expect(src).not.toMatch(/innerHTML/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ÜYE PROFİLİ — arkadaşlık (KANONİK sistem)', () => {
  const friendBtn = () => document.querySelector<HTMLButtonElement>('.mp-friend');

  it('arkadaş DEĞİLKEN "Arkadaş ekle" gösterilir', async () => {
    friendsList = [];
    boot(); await open();
    await vi.waitFor(() => { flushSync(); expect(friendBtn()).not.toBeNull(); });

    expect(friendBtn()!.textContent).toMatch(/Arkadaş ekle/);
  });

  it('"Arkadaş ekle" KANONİK uca username ile gider', async () => {
    friendsList = [];
    boot(); await open();
    await vi.waitFor(() => { flushSync(); expect(friendBtn()).not.toBeNull(); });

    friendBtn()!.click();
    await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x => String(x[0]).includes('/api/friends/request'));
      expect(c).toBeDefined();
      expect(JSON.parse(String((c![1] as RequestInit).body))).toMatchObject({ username: 'ayse' });
    });
    await vi.waitFor(() => { flushSync(); expect(document.body.textContent).toMatch(/İstek gönderildi/); });
  });

  it('409 (zaten istek var) DÜRÜSTÇE gösterilir', async () => {
    friendsList = []; friendRequestStatus = 409;
    boot(); await open();
    await vi.waitFor(() => { flushSync(); expect(friendBtn()).not.toBeNull(); });

    friendBtn()!.click();
    await vi.waitFor(() => { flushSync(); expect(document.body.textContent).toMatch(/Zaten bir istek var/); });
  });

  it('ZATEN arkadaşsa çıkarma eylemi gösterilir', async () => {
    friendsList = [{ _id: 'u-42' }];
    boot(); await open();
    await vi.waitFor(() => { flushSync(); expect(friendBtn()).not.toBeNull(); });

    expect(friendBtn()!.textContent).toMatch(/Arkadaşlıktan çıkar/);
  });

  it('KENDİ profilinde arkadaşlık eylemi GÖSTERİLMEZ', async () => {
    BridgeRegistry.register('me', () => ({ id: 'u-42' }));   // goruntulenen kisi = ben
    boot(); await open('u-42');
    await vi.waitFor(() => { flushSync(); expect(msgBtn()).not.toBeNull(); });

    expect(friendBtn()).toBeNull();
  });

  it('durum OKUNAMAZSA eylem gösterilmez (fail-closed, ölü düğme yok)', async () => {
    fetchMock = vi.fn(async (u: string) =>
      String(u).endsWith('/api/friends') ? ok({}, 500) : ok(profileBody));
    boot(); await open();
    await vi.waitFor(() => { flushSync(); expect(msgBtn()).not.toBeNull(); });

    expect(friendBtn()).toBeNull();
  });

  it('SUNUCUDAN gelen presence gösterilir (uydurma yok)', async () => {
    profileBody = { ...USER, status: 'online' };
    boot(); await open();

    expect(document.querySelector('.mp-presence')?.textContent).toMatch(/Çevrimiçi/);
  });

  it('UYDURMA rol/karşılıklı sunucu alanı YOKTUR', () => {
    const raw = fs.readFileSync(path.join(CLIENT, 'js/core/MemberProfilePopover.svelte'), 'utf8');
    const src = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/mutual|Ortak sunucu|role-badge|roles\.map/i);
  });
});
