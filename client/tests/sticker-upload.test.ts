// client/tests/sticker-upload.test.ts
// FAZ C3 — STICKER PAKETİ OLUŞTURMA/YÜKLEME (gerçek sözleşme + güvenlik).
//
// ARKA UÇ SÖZLEŞMESİ (routes/sticker-packs.ts, kaynaktan okundu):
//   POST /api/servers/:sid/sticker-packs        yetki: MANAGE_SERVER
//   multipart alanları: name · description · sticker (1..50 dosya)
//   dosya başına 512 KB · image/png | image/webp | image/gif
//   hata: 415 (format) · 413 (boyut) · 400 (sayı/ad) · 403 (yetki)
//
// Ayrı dosyadır çünkü yükleme davranışı (dosya seçimi, FormData, hata eşlemesi,
// bayat sunucu) tarama/yönetim testlerinden belirgin biçimde farklı bir yüzey.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import StickerOpener from '../js/core/stickers/StickerOpener.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { clearPermsCache } from '../js/core/permissions/myPermissions.ts';
import {
  checkStickerFiles, STICKER_MAX_FILES, STICKER_MAX_FILE_SIZE, STICKER_FILE_FIELD,
} from '../js/core/stickers/stickerStore.ts';

const SID = 'srv-A';
const MANAGE_SERVER = 1 << 3;
const XSS = '<img src=x onerror="window.__pwned=1">';

let fetchMock: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));

const ok  = (b: unknown, status = 200) => ({ ok: true,  status, json: async () => b } as unknown as Response);
const bad = (status: number, e?: string) =>
  ({ ok: false, status, json: async () => (e ? { error: e } : {}) } as unknown as Response);

const PACK = (over: Record<string, unknown> = {}) => ({
  _id: 'pack-1', serverId: SID, name: 'Paket', description: '',
  authorId: 'u1', stickers: [], createdAt: 1, ...over,
});

function png(name = 'a.png', size = 1024): File {
  const f = new File([new Uint8Array(size)], name, { type: 'image/png' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

function makeFetch(perms = MANAGE_SERVER, onPost?: () => Response | Promise<Response>) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/me/permissions')) return ok({ permissions: perms });
    if (u.endsWith('/sticker-packs') && init?.method === 'POST') {
      return onPost ? onPost() : ok(PACK({ _id: 'yeni-pack', name: 'Yeni' }), 201);
    }
    if (u.endsWith('/sticker-packs')) return ok([PACK()]);
    return ok(null, 204);
  });
}

const doc      = () => host.ownerDocument;
const panel    = () => doc().querySelector('.sp-card');
const openBtn  = () => host.querySelector<HTMLButtonElement>('.sticker-opener');
const createBtn = () => [...doc().querySelectorAll<HTMLButtonElement>('.sp-btn')]
  .find(b => b.textContent?.includes('Yeni paket oluştur'));
const submitBtn = () => [...doc().querySelectorAll<HTMLButtonElement>('.sp-btn')]
  .find(b => b.textContent?.includes('Paketi oluştur') || b.textContent?.includes('Yükleniyor'));
const nameInput = () => doc().querySelector<HTMLInputElement>('.sp-form .sp-input');
const fileInput = () => doc().querySelector<HTMLInputElement>('.sp-file');
const rejectedItems = () => [...doc().querySelectorAll('.sp-rejected-item')].map(e => e.textContent ?? '');

const listUrls = () => fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.endsWith('/sticker-packs'));
const postCalls = () => fetchMock.mock.calls.filter(c => (c[1] as RequestInit)?.method === 'POST');

async function openPanel(): Promise<void> {
  openBtn()!.click();
  await vi.waitFor(() => { flushSync(); expect(panel()).not.toBeNull(); });
  await vi.waitFor(() => { flushSync(); expect(listUrls().length).toBeGreaterThan(0); });
  await vi.waitFor(() => {
    flushSync();
    expect(doc().querySelector('.sp-status')?.textContent ?? '').not.toMatch(/yükleniyor/i);
  });
}

/** Dosya seçimini jsdom'da taklit eder (input.files salt-okunurdur). */
function pickFiles(files: File[]): void {
  const input = fileInput()!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

async function openCreateForm(files: File[] = [png()], name = 'Paketim'): Promise<void> {
  await openPanel();
  await vi.waitFor(() => { flushSync(); expect(createBtn()).toBeDefined(); });
  createBtn()!.click();
  flushSync();
  if (name) {
    const input = nameInput()!;
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
  }
  if (files.length) pickFiles(files);
}

beforeEach(() => {
  clearPermsCache();
  fetchMock = makeFetch();
  BridgeRegistry.register('getCurrentServer', () => ({ _id: SID, id: SID }));
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(StickerOpener, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  BridgeRegistry.unregister('getCurrentServer');
  clearPermsCache();
  delete (window as unknown as Record<string, unknown>).__pwned;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
// Yetki
// ════════════════════════════════════════════════════════════════════════════
describe('C3 — GÜVENLİK: oluşturma yetkiye bağlı', () => {
  it('MANAGE_SERVER YOKSA oluşturma yüzeyi HİÇ görünmez', async () => {
    fetchMock = makeFetch(0);
    await openPanel();
    flushSync();

    expect(createBtn()).toBeUndefined();
    expect(fileInput()).toBeNull();
  });

  it('MANAGE_SERVER varsa oluşturma açılabilir', async () => {
    await openPanel();
    await vi.waitFor(() => { flushSync(); expect(createBtn()).toBeDefined(); });

    createBtn()!.click();
    flushSync();

    expect(fileInput()).not.toBeNull();
  });

  it('GÜVENLİK: yetki yanıtı sunucu DEĞİŞTİKTEN sonra gelirse oluşturma açılmaz', async () => {
    let release: ((v: Response) => void) | null = null;
    fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/me/permissions')) return new Promise<Response>(r => { release = r; });
      if (u.endsWith('/sticker-packs'))  return ok([PACK()]);
      return ok(null, 204);
    });

    openBtn()!.click();
    await vi.waitFor(() => expect(release).not.toBeNull());

    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-B' } }));
    flushSync();

    release!(ok({ permissions: MANAGE_SERVER }));
    await vi.waitFor(() => { flushSync(); expect(panel()).toBeNull(); });

    expect(createBtn()).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Sözleşme
// ════════════════════════════════════════════════════════════════════════════
describe('C3 — yükleme GERÇEK sözleşmeyi kullanır', () => {
  it('POST doğru uca gider ve FormData alan adları arka uçla aynıdır', async () => {
    await openCreateForm([png('kedi.png'), png('kopek.png')]);
    submitBtn()!.click();
    await vi.waitFor(() => expect(postCalls()).toHaveLength(1));

    const [url, init] = postCalls()[0]!;
    expect(String(url)).toBe(`http://test/api/servers/${SID}/sticker-packs`);
    expect((init as RequestInit).method).toBe('POST');

    const body = (init as RequestInit).body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('name')).toBe('Paketim');
    expect(body.getAll(STICKER_FILE_FIELD)).toHaveLength(2);
    expect((body.getAll(STICKER_FILE_FIELD)[0] as File).name).toBe('kedi.png');
  });

  it('Content-Type ELLE ayarlanmaz (boundary tarayıcıya bırakılır)', async () => {
    await openCreateForm();
    submitBtn()!.click();
    await vi.waitFor(() => expect(postCalls()).toHaveLength(1));

    const headers = (postCalls()[0]![1] as RequestInit).headers as Record<string, string> | undefined;
    const keys = headers ? Object.keys(headers).map(k => k.toLowerCase()) : [];
    expect(keys).not.toContain('content-type');
  });

  it('açıklama isteğe bağlıdır ve gönderilir', async () => {
    await openCreateForm();
    const desc = [...doc().querySelectorAll<HTMLInputElement>('.sp-form .sp-input')][1]!;
    desc.value = 'kedi paketi';
    desc.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    submitBtn()!.click();
    await vi.waitFor(() => expect(postCalls()).toHaveLength(1));

    expect(((postCalls()[0]![1] as RequestInit).body as FormData).get('description')).toBe('kedi paketi');
  });

  it('ad boşken gönderim DEVRE DIŞI ve istek atılmaz', async () => {
    await openCreateForm([png()], '');

    expect(submitBtn()!.disabled).toBe(true);
    submitBtn()!.click();
    flushSync();

    expect(postCalls()).toHaveLength(0);
  });

  it('dosya seçilmeden gönderim DEVRE DIŞI', async () => {
    await openCreateForm([], 'Paketim');

    expect(submitBtn()!.disabled).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Sınırlar — arka uç sınırlarının UX yansıması
// ════════════════════════════════════════════════════════════════════════════
describe('C3 — dosya sınırları (arka uç yetkili, istemci yalnız bilgilendirir)', () => {
  it('50 dosya sınırı aşılırsa fazlası SESSİZCE atılmaz, gerekçesiyle bildirilir', () => {
    const files = Array.from({ length: STICKER_MAX_FILES + 3 }, (_, i) => png(`s${i}.png`));
    const check = checkStickerFiles(files);

    expect(check.accepted).toHaveLength(STICKER_MAX_FILES);
    expect(check.rejected).toHaveLength(3);
    expect(check.rejected.every(r => r.reason === 'count')).toBe(true);
  });

  it('desteklenmeyen biçim elenir ve gerekçe "type" olur', () => {
    const jpg = new File([new Uint8Array(10)], 'a.jpg', { type: 'image/jpeg' });
    const check = checkStickerFiles([png(), jpg]);

    expect(check.accepted).toHaveLength(1);
    expect(check.rejected).toEqual([{ name: 'a.jpg', reason: 'type' }]);
  });

  it('512 KB üstü dosya elenir ve gerekçe "size" olur', () => {
    const check = checkStickerFiles([png('buyuk.png', STICKER_MAX_FILE_SIZE + 1)]);

    expect(check.accepted).toHaveLength(0);
    expect(check.rejected).toEqual([{ name: 'buyuk.png', reason: 'size' }]);
  });

  it('elenen dosyalar arayüzde GEREKÇESİYLE gösterilir', async () => {
    const jpg = new File([new Uint8Array(10)], 'kotu.jpg', { type: 'image/jpeg' });
    await openCreateForm([png(), jpg]);

    expect(rejectedItems().join(' ')).toContain('kotu.jpg');
    expect(rejectedItems().join(' ')).toMatch(/desteklenmeyen biçim/i);
  });

  it('yalnız KABUL EDİLEN dosyalar gönderilir', async () => {
    const jpg = new File([new Uint8Array(10)], 'kotu.jpg', { type: 'image/jpeg' });
    await openCreateForm([png('iyi.png'), jpg]);
    submitBtn()!.click();
    await vi.waitFor(() => expect(postCalls()).toHaveLength(1));

    const sent = ((postCalls()[0]![1] as RequestInit).body as FormData).getAll(STICKER_FILE_FIELD) as File[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe('iyi.png');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Hata yolları — sahte başarı YOK
// ════════════════════════════════════════════════════════════════════════════
describe('C3 — hata yolları dürüsttür', () => {
  it('403 yetkisiz: hata gösterilir, liste DEĞİŞMEZ, form AÇIK kalır', async () => {
    fetchMock = makeFetch(MANAGE_SERVER, () => bad(403, 'Sticker paketi oluşturma izniniz yok.'));
    await openCreateForm();
    submitBtn()!.click();
    await vi.waitFor(() => { flushSync(); expect(doc().querySelector('.sp-error')).not.toBeNull(); });

    expect(doc().querySelector('.sp-error')!.textContent).toContain('izniniz yok');
    expect(doc().querySelectorAll('.sp-pack')).toHaveLength(1);   // yeni paket EKLENMEDİ
    expect(fileInput()).not.toBeNull();                            // form kapanmadı
  });

  it('415 geçersiz format: arka uç mesajı gösterilir', async () => {
    fetchMock = makeFetch(MANAGE_SERVER, () => bad(415, 'Geçersiz sticker formatı. PNG, WebP veya GIF gerekli.'));
    await openCreateForm();
    submitBtn()!.click();
    await vi.waitFor(() => { flushSync(); expect(doc().querySelector('.sp-error')).not.toBeNull(); });

    expect(doc().querySelector('.sp-error')!.textContent).toMatch(/PNG, WebP veya GIF/);
  });

  it('gövdesiz 413: dürüst bir boyut mesajına düşülür', async () => {
    fetchMock = makeFetch(MANAGE_SERVER, () => bad(413));
    await openCreateForm();
    submitBtn()!.click();
    await vi.waitFor(() => { flushSync(); expect(doc().querySelector('.sp-error')).not.toBeNull(); });

    expect(doc().querySelector('.sp-error')!.textContent).toMatch(/çok büyük/i);
  });

  it('ağ hatası BAŞARI gibi gösterilmez', async () => {
    fetchMock = makeFetch(MANAGE_SERVER, () => { throw new Error('offline'); });
    await openCreateForm();
    submitBtn()!.click();
    await vi.waitFor(() => { flushSync(); expect(doc().querySelector('.sp-error')).not.toBeNull(); });

    expect(doc().querySelectorAll('.sp-pack')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Yarış / bayatlık / çift gönderim
// ════════════════════════════════════════════════════════════════════════════
describe('C3 — GÜVENLİK: çift gönderim, bayat sunucu', () => {
  it('GÜVENLİK: art arda tıklama TEK istek üretir', async () => {
    let release: ((v: Response) => void) | null = null;
    fetchMock = makeFetch(MANAGE_SERVER, () => new Promise<Response>(r => { release = r; }));
    await openCreateForm();

    submitBtn()!.click();
    await vi.waitFor(() => expect(postCalls()).toHaveLength(1));
    submitBtn()!.click();
    submitBtn()!.click();
    flushSync();

    expect(postCalls()).toHaveLength(1);

    release!(ok(PACK({ _id: 'yeni' }), 201));
    await vi.waitFor(() => { flushSync(); expect(postCalls()).toHaveLength(1); });
  });

  it('yükleme sırasında gönderim düğmesi DEVRE DIŞI ve durum gösterilir', async () => {
    fetchMock = makeFetch(MANAGE_SERVER, () => new Promise<Response>(() => {}));
    await openCreateForm();
    submitBtn()!.click();
    await vi.waitFor(() => { flushSync(); expect(submitBtn()!.disabled).toBe(true); });

    expect(submitBtn()!.textContent).toMatch(/yükleniyor/i);
  });

  it('GÜVENLİK: sunucu değiştiyse tamamlanan yükleme YENİ sunucunun listesini kirletmez', async () => {
    let release: ((v: Response) => void) | null = null;
    fetchMock = makeFetch(MANAGE_SERVER, () => new Promise<Response>(r => { release = r; }));
    await openCreateForm();

    submitBtn()!.click();
    await vi.waitFor(() => expect(postCalls()).toHaveLength(1));

    // Kullanıcı B sunucusuna geçti — panel kapanır.
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'srv-B' } }));
    flushSync();
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-B', id: 'srv-B' }));

    // A'nın yüklemesi ŞİMDİ bitiyor.
    release!(ok(PACK({ _id: 'A-paketi' }), 201));
    await vi.waitFor(() => { flushSync(); expect(panel()).toBeNull(); });

    // B'nin ekranında A'nın paketi görünmemeli.
    expect(doc().body.textContent).not.toContain('A-paketi');
  });

  it('başarılı yüklemeden sonra form kapanır ve yeni paket listede görünür', async () => {
    fetchMock = makeFetch(MANAGE_SERVER, () => ok(PACK({ _id: 'yeni', name: 'Yeni Paket' }), 201));
    await openCreateForm();
    submitBtn()!.click();

    await vi.waitFor(() => { flushSync(); expect(doc().querySelectorAll('.sp-pack')).toHaveLength(2); });
    expect(panel()!.textContent).toContain('Yeni Paket');
    expect(fileInput()).toBeNull();                 // form kapandı
  });
});

// ════════════════════════════════════════════════════════════════════════════
// XSS — dosya adı ve paket meta verisi
// ════════════════════════════════════════════════════════════════════════════
describe('C3 — GÜVENLİK: dosya adı ve meta veri HTML olarak render EDİLMEZ', () => {
  it('zararlı DOSYA ADI metin olarak listelenir', async () => {
    await openCreateForm([png(`${XSS}.png`)]);

    expect(doc().querySelector('.sp-picked-list img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(doc().querySelector('.sp-picked-item')!.textContent).toContain('onerror');
  });

  it('elenen zararlı dosya adı da metin olarak gösterilir', async () => {
    const evil = new File([new Uint8Array(10)], `${XSS}.jpg`, { type: 'image/jpeg' });
    await openCreateForm([evil]);

    expect(doc().querySelector('.sp-rejected img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(rejectedItems().join(' ')).toContain('onerror');
  });

  it('sunucudan dönen zararlı PAKET adı metin olarak render edilir', async () => {
    fetchMock = makeFetch(MANAGE_SERVER, () => ok(PACK({ _id: 'yeni', name: XSS }), 201));
    await openCreateForm();
    submitBtn()!.click();

    await vi.waitFor(() => { flushSync(); expect(doc().querySelectorAll('.sp-pack')).toHaveLength(2); });
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(panel()!.querySelectorAll('script, iframe')).toHaveLength(0);
    expect(panel()!.textContent).toContain('onerror');
  });

  it('zararlı HATA metni HTML üretmez', async () => {
    fetchMock = makeFetch(MANAGE_SERVER, () => bad(400, XSS));
    await openCreateForm();
    submitBtn()!.click();
    await vi.waitFor(() => { flushSync(); expect(doc().querySelector('.sp-error')).not.toBeNull(); });

    expect(doc().querySelector('.sp-error')!.querySelector('img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
