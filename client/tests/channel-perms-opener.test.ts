// client/tests/channel-perms-opener.test.ts
import { t } from '../js/core/i18n/index.ts';
// FAZ C2 — AÇICI + ENTEGRASYON.
//
// ════════════════════════════════════════════════════════════════════════════
// NE KANITLAR
// ════════════════════════════════════════════════════════════════════════════
// 1. `openChannelMenu` registry sahibi GERÇEKTEN kurulur — bu kayıt olmadan
//    `ChannelItem.svelte:66` üç nokta butonunu hiç çizmez ve C2 ürüne
//    erişilemez kalır (kayıt sayısı 0 idi).
// 2. Yetki KANITLANAMIYORSA menü açılmaz (fail-closed görünürlük).
// 3. Açılışta yakalanan serverId/channelId kontrolcüye AYNEN geçer —
//    sonradan "şu an hangi kanal seçili?" diye SORULMAZ (§13).
// 4. Tarihsel `{@html}` kabuğu üretim yoluna geri bağlanamaz.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// ── KAYNAK TARAMASI G/Ç BAĞLIDIR ────────────────────────────────────────────
// Bu dosyadaki testler istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik
// VARSAYILAN zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir
// makinede aşılabilir; ölçüm bitmeden test kırmızıya döner ve bu, ürün hakkında
// HİÇBİR ŞEY söylemeyen bir kırılganlıktır. Sözleşme taramanın SONUCUNDA
// olduğu için bu dosyaya açık ve cömert bir zaman aşımı verilir. Hiçbir iddia
// gevşetilmemiştir; yalnızca zamanlama gürültüsü kaldırılmıştır.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mount, unmount, flushSync } from 'svelte';
import ChannelActionMenu from '../js/core/channel-perms/ChannelActionMenu.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { clearPermsCache, hasPerm, PERM_MANAGE_CHANNELS, PERM_ADMINISTRATOR }
  from '../js/core/permissions/myPermissions.ts';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SID = 'srv-A';
const CID = 'chan-A';
const MANAGE = 1 << 1;

let fetchMock: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));

const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b } as unknown as Response);

/** Varsayılan: yetki VAR, izinler boş. */
function defaultFetch(perms = MANAGE) {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/me/permissions')) return ok({ permissions: perms });
    if (u.endsWith('/permissions'))    return ok({ roles: [{ _id: 'role-1', name: 'Moderatör' }], overrides: [] });
    return ok({ ok: true });
  });
}

function openEvent(): MouseEvent {
  return new MouseEvent('click', { clientX: 120, clientY: 80 });
}

/** Kayıtlı sahibi çağırır — üretimdeki tek yol budur. */
async function openMenu(cid = CID, name = 'genel'): Promise<void> {
  await BridgeRegistry.call('openChannelMenu', cid, name, openEvent());
  flushSync();
}

const menu     = () => host.ownerDocument.querySelector('.cam-menu');
const menuItem = () => host.ownerDocument.querySelector<HTMLButtonElement>('.cam-item');
const editor   = () => host.ownerDocument.querySelector('.cp-card');

/** İzin YÜKLEME isteği. Dikkat: `/me/permissions` de `/permissions` ile biter. */
const loadUrls = () => fetchMock.mock.calls
  .map(c => String(c[0]))
  .filter(u => /\/channels\/[^/]+\/permissions$/.test(u));

const explainUrls = () => fetchMock.mock.calls
  .map(c => String(c[0]))
  .filter(u => u.endsWith('/permissions/explain/me'));

const rolePreviewUrls = () => fetchMock.mock.calls
  .map(c => String(c[0]))
  .filter(u => /\/roles\/[^/]+\/preview$/.test(u));

/** Editör açıldıktan SONRA yükleme çözülür; veri gelene kadar beklenir. */
async function openEditor(): Promise<void> {
  menuItem()!.click();
  await vi.waitFor(() => { flushSync(); expect(loadUrls().length).toBeGreaterThan(0); });
  await vi.waitFor(() => { flushSync(); expect(editor()?.querySelector('.cp-role')).not.toBeNull(); });
}

beforeEach(() => {
  clearPermsCache();
  fetchMock = defaultFetch();
  BridgeRegistry.register('getCurrentServer', () => ({ _id: SID, id: SID }));
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(ChannelActionMenu, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  BridgeRegistry.unregister('getCurrentServer');
  clearPermsCache();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
describe('C2 — açıcı gerçekten bağlı', () => {
  it('`openChannelMenu` sahibi KURULUR (yoksa üç nokta butonu hiç çizilmez)', () => {
    expect(BridgeRegistry.has('openChannelMenu')).toBe(true);
  });

  it('unmount sonrası sahiplik BIRAKILIR (ölü kontrol kalmaz)', () => {
    unmount(instance!);
    instance = null;
    expect(BridgeRegistry.has('openChannelMenu')).toBe(false);
  });

  it('yetki varsa menü açılır ve TEK çalışan eylemi gösterir', async () => {
    await openMenu();

    expect(menu()).not.toBeNull();
    expect(menuItem()?.textContent).toContain('Kanal İzinleri');
    expect(host.ownerDocument.querySelectorAll('.cam-item')).toHaveLength(1);
  });

  it('KAPSAM: menüde sahibi olmayan ölü eylemler YOKTUR', async () => {
    await openMenu();

    expect(menu()?.textContent).not.toMatch(/yeniden adlandır|sil|taşı|davet/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C2 — GÜVENLİK: yetki kanıtlanamıyorsa açılmaz', () => {
  it('MANAGE_CHANNELS yoksa menü AÇILMAZ', async () => {
    fetchMock = defaultFetch(0);
    await openMenu();

    expect(menu()).toBeNull();
  });

  it('yetki ucu HATA verirse menü AÇILMAZ (ağ hatasında yetki varsayılmaz)', async () => {
    fetchMock = vi.fn(async () => { throw new Error('offline'); });
    await openMenu();

    expect(menu()).toBeNull();
  });

  it('yetki ucu 403 dönerse menü AÇILMAZ', async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) } as unknown as Response));
    await openMenu();

    expect(menu()).toBeNull();
  });

  it('sunucu çözülemiyorsa menü AÇILMAZ ve İSTEK ATILMAZ', async () => {
    BridgeRegistry.unregister('getCurrentServer');
    await openMenu();

    expect(menu()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('kanal kimliği boşsa menü AÇILMAZ ve İSTEK ATILMAZ', async () => {
    await openMenu('');

    expect(menu()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ADMINISTRATOR biti MANAGE_CHANNELS’i kapsar; 1<<3 (MANAGE_SERVER) KAPSAMAZ', () => {
    expect(hasPerm(PERM_ADMINISTRATOR, PERM_MANAGE_CHANNELS)).toBe(true);
    expect(hasPerm(1 << 3, PERM_MANAGE_CHANNELS)).toBe(false);
    expect(PERM_ADMINISTRATOR).toBe(1 << 30);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C2 — bağlam açılışta YAKALANIR (§13)', () => {
  it('düzenleyici, açılışta yakalanan serverId/channelId ile yükler', async () => {
    await openMenu(CID);
    await openEditor();

    expect(loadUrls()).toEqual([`http://test/api/servers/${SID}/channels/${CID}/permissions`]);
  });

  it('GÜVENLİK: menü açıldıktan sonra etkin kanal değişse bile YAKALANAN kanal kullanılır', async () => {
    await openMenu(CID);

    // Kullanıcı başka bir kanala geçti — düzenleme yine de açıldığı kanala aittir.
    BridgeRegistry.register('getCurrentChannel', () => ({ _id: 'chan-B' }));

    await openEditor();

    expect(loadUrls().some(u => u.includes('/channels/chan-B/'))).toBe(false);
    expect(loadUrls().some(u => u.includes(`/channels/${CID}/`))).toBe(true);

    BridgeRegistry.unregister('getCurrentChannel');
  });

  it('düzenleyici GERÇEK rol verisini gösterir ve kanal adı METİN olarak basılır', async () => {
    await openMenu(CID, '<img src=x onerror="window.__pwned=1">');
    await openEditor();

    expect(host.ownerDocument.querySelector('.cp-card img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(editor()!.textContent).toContain('onerror');   // metin olarak basıldı
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('Permission Explainability — yönetici açıklama entegrasyonu', () => {
  it('Açıkla eylemi yakalanan sunucu/kanal için kanonik açıklama ucunu çağırır', async () => {
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/me/permissions')) return ok({ permissions: MANAGE });
      if (u.endsWith('/permissions')) {
        return ok({ roles: [{ _id: 'role-1', name: 'Developer' }], overrides: [] });
      }
      if (u.endsWith('/permissions/explain/me')) {
        return ok({
          channelId: CID,
          subject: 'current-user',
          permissions: [{
            key: 'SEND_MESSAGES',
            label: 'Mesaj gönder',
            allowed: false,
            effective: 'denied',
            reasonCode: 'CHANNEL_OVERRIDE_DENIED',
            message: 'Bu kanal sunucu rol izinleriyle kısıtlanmış.',
            base: { state: 'allowed', sources: ['Developer rolü izin veriyor'] },
            overrides: [{ scope: 'role', label: 'Developer kanal kuralı', state: 'denied' }],
          }],
        });
      }
      return ok({ ok: true });
    });

    await openMenu(CID);
    await openEditor();
    host.ownerDocument.querySelector<HTMLButtonElement>('.cp-explain button')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(editor()).toHaveTextContent('Developer kanal kuralı: reddediyor');
    });
    expect(explainUrls()).toEqual([
      `http://test/api/servers/${SID}/channels/${CID}/permissions/explain/me`,
    ]);
  });

  it('403 ayrıntı sızdırmaz ve yönetici sınırını açıkça bildirir', async () => {
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/me/permissions')) return ok({ permissions: MANAGE });
      if (u.endsWith('/permissions')) {
        return ok({ roles: [{ _id: 'role-1', name: 'Developer' }], overrides: [] });
      }
      if (u.endsWith('/permissions/explain/me')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: 'Forbidden' }),
        } as unknown as Response;
      }
      return ok({ ok: true });
    });

    await openMenu(CID);
    await openEditor();
    host.ownerDocument.querySelector<HTMLButtonElement>('.cp-explain button')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(editor()).toHaveTextContent('yalnız yetkili yöneticilere açıktır');
    });
    expect(editor()?.textContent).not.toContain('Forbidden');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('View as Role — üretim köprüsü', () => {
  it('seçilen rolü salt-okunur önizleme ucuna gönderir ve kanal sonucunu render eder', async () => {
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/me/permissions')) return ok({ permissions: MANAGE });
      if (u.endsWith('/permissions')) {
        return ok({ roles: [{ _id: 'role-1', name: 'Moderator' }], overrides: [] });
      }
      if (u.endsWith('/roles/role-1/preview')) {
        return ok({
          simulation: true,
          role: { id: 'role-1', name: 'Moderator' },
          summary: {
            totalChannels: 2, visibleChannels: 1, sendableChannels: 1,
            attachableChannels: 1, manageableChannels: 0,
          },
          channels: [{
            channelId: 'staff', name: 'staff', type: 'text', categoryId: null, visible: false,
            capabilities: {
              sendMessages: false, attachFiles: false, manageMessages: false, connect: false, speak: false,
            },
          }],
        });
      }
      return ok({ ok: true });
    });

    await openMenu(CID);
    await openEditor();
    const select = host.ownerDocument.querySelector<HTMLSelectElement>('#cp-preview-role')!;
    select.value = 'role-1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    host.ownerDocument.querySelector<HTMLButtonElement>('.cp-preview button')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(editor()).toHaveTextContent('# staff');
      expect(editor()).toHaveTextContent('Gizli');
    });
    expect(rolePreviewUrls()).toEqual([
      `http://test/api/servers/${SID}/roles/role-1/preview`,
    ]);
  });

  it('403 yanıtında hassas sunucu metnini değil yönetici sınırını gösterir', async () => {
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/me/permissions')) return ok({ permissions: MANAGE });
      if (u.endsWith('/permissions')) {
        return ok({ roles: [{ _id: 'role-1', name: 'Moderator' }], overrides: [] });
      }
      if (u.endsWith('/roles/role-1/preview')) {
        return { ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) } as unknown as Response;
      }
      return ok({ ok: true });
    });

    await openMenu(CID);
    await openEditor();
    const select = host.ownerDocument.querySelector<HTMLSelectElement>('#cp-preview-role')!;
    select.value = 'role-1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    host.ownerDocument.querySelector<HTMLButtonElement>('.cp-preview button')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(editor()).toHaveTextContent('yalnız yetkili yöneticilere açıktır');
    });
    expect(editor()?.textContent).not.toContain('Forbidden');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Yarış ve bayat yüzey
// ════════════════════════════════════════════════════════════════════════════
describe('C2 — açılış yarışı ve bayat yüzey', () => {
  it('GÜVENLİK: kullanıcı sunucudan AYRILDIKTAN sonra dönen yetki yanıtı menüyü AÇAMAZ', async () => {
    // Yetki sorgusu asenkrondur. Yanıt gelmeden kullanıcı başka bir sunucuya
    // geçerse, geç gelen "yetkin var" cevabı ARTIK GEÇERSİZDİR ve terk edilmiş
    // bağlam için menü açmamalıdır.
    let release: ((v: Response) => void) | null = null;
    fetchMock = vi.fn((url: unknown) => {
      if (String(url).endsWith('/me/permissions')) {
        return new Promise<Response>(r => { release = r; });
      }
      return Promise.resolve(ok({ roles: [], overrides: [] }));
    });

    const pending = BridgeRegistry.call('openChannelMenu', CID, 'genel', openEvent());
    await vi.waitFor(() => expect(release).not.toBeNull());

    // Kullanıcı sunucu değiştirdi.
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-B' } }));
    flushSync();

    // Eski sunucunun yetki yanıtı ŞİMDİ geliyor.
    release!(ok({ permissions: MANAGE }));
    await pending;
    flushSync();

    expect(menu()).toBeNull();
  });

  it('GÜVENLİK: sunucu değişince AÇIK editör kapanır (bayat yüzey kalmaz)', async () => {
    await openMenu(CID);
    await openEditor();
    expect(editor()).not.toBeNull();

    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-B' } }));
    flushSync();

    expect(editor()).toBeNull();
    expect(menu()).toBeNull();
  });

  it('GÜVENLİK: sunucu değişince yetki önbelleği bayat kullanılmaz', async () => {
    await openMenu(CID);
    expect(menu()).not.toBeNull();

    // Sunucu değişti; artık yetki YOK.
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-B' } }));
    flushSync();
    fetchMock = defaultFetch(0);

    await openMenu(CID);

    expect(menu()).toBeNull();   // önbellekten "yetkili" diye açılmadı
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('C2 — tarihsel `{@html}` kabuğu üretime bağlanamaz', () => {
  it('hiçbir canlı modül ChannelPermsModal / eski shim’i import ETMEZ', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|js|svelte)$/.test(e.name)) continue;
        // Kabuğun kendisi ve eski shim'i hariç.
        const rel = path.relative(CLIENT_ROOT, full).replace(/\\/g, '/');
        if (rel === 'js/core/channel-perms/ChannelPermsModal.svelte') continue;
        if (rel === 'js/core/channel-perms/channel-perms-svelte.ts') continue;

        const src = fs.readFileSync(full, 'utf8');
        if (/import\s[^\n]*ChannelPermsModal|import\s*\([^)]*channel-perms-svelte/.test(src)) {
          offenders.push(rel);
        }
      }
    };
    walk(path.join(CLIENT_ROOT, 'js'));

    expect(offenders).toEqual([]);
  });

  it('yeni editör HİÇ `{@html}` kullanmaz', () => {
    const src = fs.readFileSync(
      path.join(CLIENT_ROOT, 'js/core/channel-perms/ChannelPermsEditor.svelte'), 'utf8');
    // Başlık yorumu eski sözleşmeyi ADIYLA anlatır; kod aranır, yorum değil.
    const code = src.replace(/<!--[\s\S]*?-->/g, '');

    expect(code).not.toMatch(/\{@html/);
  });
});

describe('C2 — menü yaşam döngüsü ve tam düzenleme akışı', () => {
  it('geçersiz yeni bağlam eski menüyü kapatır ve kopmuş eski düğme editör açamaz', async () => {
    await openMenu();
    const staleButton = menuItem()!;

    await BridgeRegistry.call('openChannelMenu', null as unknown as string, 'invalid', openEvent());
    flushSync();
    expect(menu()).toBeNull();

    staleButton.click();
    await Promise.resolve();
    flushSync();
    expect(editor()).toBeNull();
  });

  it('geçersiz yeni bağlam açık editörü de fail-closed kapatır', async () => {
    await openMenu();
    await openEditor();
    expect(editor()).not.toBeNull();

    BridgeRegistry.unregister('getCurrentServer');
    await BridgeRegistry.call('openChannelMenu', CID, 'invalid', openEvent());
    flushSync();

    expect(editor()).toBeNull();
    expect(menu()).toBeNull();
  });

  it('aynı click capture fazında bağlam geçersizleşirse kuyruktaki menü eylemi editör açamaz', async () => {
    await openMenu();
    const invalidateBeforeDelegatedHandler = () => {
      void BridgeRegistry.call('openChannelMenu', null as unknown as string, 'invalid', openEvent());
    };
    document.addEventListener('click', invalidateBeforeDelegatedHandler, { capture: true, once: true });

    menuItem()!.click();
    await Promise.resolve();
    flushSync();

    expect(menu()).toBeNull();
    expect(editor()).toBeNull();
    expect(loadUrls()).toHaveLength(0);
  });

  it('yeni kanalın yetki kanıtı beklenirken önceki yetkili menüyü hemen gizler', async () => {
    await openMenu();
    expect(menu()).not.toBeNull();
    clearPermsCache();

    let release: (response: Response) => void = () => {};
    fetchMock = vi.fn((url: unknown) => {
      if (String(url).endsWith('/me/permissions')) {
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return Promise.resolve(ok({ roles: [], overrides: [] }));
    });
    const pending = BridgeRegistry.call('openChannelMenu', 'chan-B', 'başka', openEvent());
    flushSync();
    expect(menu()).toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    release(ok({ permissions: MANAGE }));
    await pending;
    flushSync();
    expect(menu()).not.toBeNull();
  });

  it('server.id fallback’ini, boş kanal adını ve tıklama koordinatlarını korur', async () => {
    BridgeRegistry.register('getCurrentServer', () => ({ id: SID }));
    await BridgeRegistry.call(
      'openChannelMenu', CID, null as unknown as string,
      new MouseEvent('click', { clientX: 120.4, clientY: 80.6 }),
    );
    flushSync();

    expect(menu()?.getAttribute('style')).toContain('left: 120px');
    expect(menu()?.getAttribute('style')).toContain('top: 81px');
    await openEditor();
    expect(editor()).toHaveTextContent('Kanal İzinleri — #');
  });

  it('menü içi mousedown ve ilgisiz tuşu yok sayar; dış tık ve Escape kapatır', async () => {
    await openMenu();
    menu()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSync();
    expect(menu()).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    flushSync();
    expect(menu()).toBeNull();

    // Kapalıyken dış olay no-op'tur; sonra yeniden açıp Escape yolunu doğrula.
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await openMenu();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(menu()).toBeNull();
  });

  it.each(['bridge:auth-success', 'bridge:auth-logout'])('%s açık menüyü ve yetki önbelleğini kapatır', async eventName => {
    await openMenu();
    expect(menu()).not.toBeNull();
    document.dispatchEvent(new Event(eventName));
    flushSync();
    expect(menu()).toBeNull();

    fetchMock = defaultFetch(0);
    await openMenu();
    expect(menu()).toBeNull();
  });

  it('rol seçimi, üç durum mutasyonu ve geri alma gerçek kontrolcüye ulaşır', async () => {
    await openMenu();
    await openEditor();

    const roles = [...editor()!.querySelectorAll<HTMLButtonElement>('.cp-role')];
    roles[0]!.click();
    flushSync();
    expect(roles[0]).toHaveAttribute('aria-current', 'true');

    const allow = editor()!.querySelector<HTMLButtonElement>('.cp-state[data-state="allow"]')!;
    allow.click();
    flushSync();
    const footer = [...editor()!.querySelectorAll<HTMLButtonElement>('.cp-footer button')];
    expect(footer.every(button => !button.disabled)).toBe(true);

    footer[0]!.click();
    flushSync();
    expect([...editor()!.querySelectorAll<HTMLButtonElement>('.cp-footer button')]
      .every(button => button.disabled)).toBe(true);
  });

  it('başarılı kayıtta kapanır ve doğru PUT gövdesini yollar', async () => {
    await openMenu();
    await openEditor();
    editor()!.querySelector<HTMLButtonElement>('.cp-state[data-state="allow"]')!.click();
    flushSync();
    editor()!.querySelector<HTMLButtonElement>('.cp-footer .btn-primary')!.click();

    await vi.waitFor(() => { flushSync(); expect(editor()).toBeNull(); });
    const write = fetchMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'PUT');
    expect(write).toBeDefined();
    expect(JSON.parse(String((write![1] as RequestInit).body))).toEqual({ allow: 1, deny: 0 });
  });

  it('başarısız kayıtta editörü ve taslağı açık tutup hatayı gösterir', async () => {
    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/me/permissions')) return ok({ permissions: MANAGE });
      if (u.endsWith('/permissions')) return ok({ roles: [{ _id: 'role-1', name: 'Mod' }], overrides: [] });
      if (init?.method === 'PUT') {
        return { ok: false, status: 409, json: async () => ({ error: 'Çakışma' }) } as unknown as Response;
      }
      return ok({});
    });
    await openMenu();
    await openEditor();
    editor()!.querySelector<HTMLButtonElement>('.cp-state[data-state="deny"]')!.click();
    flushSync();
    editor()!.querySelector<HTMLButtonElement>('.cp-footer .btn-primary')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(editor()).toHaveTextContent(t('error_conflict'));
    });
    expect(editor()).not.toBeNull();
    expect(editor()!.querySelector<HTMLButtonElement>('.cp-footer .btn-primary')!.disabled).toBe(false);
  });

  it('kapat düğmesi ve Escape açık editörü kapatır', async () => {
    await openMenu();
    await openEditor();
    editor()!.querySelector<HTMLButtonElement>('.cp-close')!.click();
    flushSync();
    expect(editor()).toBeNull();

    await openMenu();
    await openEditor();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(editor()).toBeNull();
  });

  it('kapanmış editörün kopmuş asenkron eylemleri kontrolcü olmadan güvenli no-op kalır', async () => {
    await openMenu();
    await openEditor();
    const oldEditor = editor()!;
    const explain = oldEditor.querySelector<HTMLButtonElement>('.cp-explain button')!;
    const preview = oldEditor.querySelector<HTMLButtonElement>('.cp-preview button')!;
    const save = oldEditor.querySelector<HTMLButtonElement>('.cp-footer .btn-primary')!;
    oldEditor.querySelector<HTMLButtonElement>('.cp-close')!.click();
    flushSync();
    expect(editor()).toBeNull();

    explain.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    preview.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(editor()).toBeNull();
  });

  it.each([
    ['açıklama', '.cp-explain button'],
    ['rol önizleme', '.cp-preview button'],
    ['kaydetme', '.cp-footer .btn-primary'],
  ])('aynı click capture fazındaki oturum kaybı kuyruktaki %s eylemini güvenli no-op yapar', async (_label, selector) => {
    await openMenu();
    await openEditor();
    const action = editor()!.querySelector<HTMLButtonElement>(selector)!;
    const logoutBeforeDelegatedHandler = () => {
      document.dispatchEvent(new Event('bridge:auth-logout'));
    };
    document.addEventListener('click', logoutBeforeDelegatedHandler, { capture: true, once: true });

    action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    flushSync();

    expect(editor()).toBeNull();
    expect(menu()).toBeNull();
  });
});
