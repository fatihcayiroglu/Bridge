// client/tests/composer-attachments.test.ts
import { t } from '../js/core/i18n/index.ts';
// UX/P0 — COMPOSER DOSYA EKİ (istemcide giriş HİÇ YOKTU).
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Sunucu tarafı dosya gönderimi TAM kuruluydu:
//   · POST /api/upload  — auth + CSRF, hız sınırı, magic-bytes doğrulaması,
//     zararlı yazılım taraması, SVG sanitizasyonu, boost katmanı sınırı
//   · socket `file:send` — path traversal koruması, üyelik, timeout ve
//     SEND_MESSAGES yetkisi; `message:new` yalnız `channel:<id>` odasına
//   · `MessageRenderer.svelte` — görsel/video/ses/dosya render'ı ZATEN vardı
//
// Ama composer'da HİÇBİR giriş yoktu: `input[type=file]` sayısı SIFIRDI ve
// yapıştırma yolu "Faz 5'e ait" diyerek dosyayı sessizce yok sayıyordu.
// Yani kullanıcı dosya gönderemiyordu — kozmetik değil, çekirdek akış eksiği.
//
// ════════════════════════════════════════════════════════════════════════════
// KORUNAN DEĞİŞMEZLER
// ════════════════════════════════════════════════════════════════════════════
// 1. İKİNCİ bir yükleme sistemi kurulmaz: kanonik uç + kanonik soket olayı.
// 2. Sunucunun REDDİ (415/413/422/403) dürüstçe gösterilir; istemci taklit etmez.
// 3. Gönderim GERÇEKLEŞMEDEN başarı gösterilmez; ek sessizce DÜŞÜRÜLMEZ.
// 4. Yükleme `apiFetch` üzerinden gider (auth + CSRF kanonik istemcide).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import MessageInputPanel from '../js/core/MessageInputPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { resetOutboxMemory } from '../js/core/outbox-store.ts';
import {
  readLocalFirstOutbox as readOutbox,
  resetLocalFirstOutboxRuntimeForTests,
} from '../js/core/local-first/outbox-runtime.ts';

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
let emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
let fetchMock: ReturnType<typeof vi.fn>;
let uploadResponse: () => Response;
let renderedMessages: Array<Record<string, unknown>> = [];

const ok = (b: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => b } as unknown as Response);

const input      = () => document.getElementById('msg-input') as HTMLTextAreaElement;
const fileInput  = () => document.getElementById('msg-file-input') as HTMLInputElement;
const attachBtn  = () => document.getElementById('btn-attach') as HTMLButtonElement;
const preview    = () => document.querySelector('.composer-attach');
const attachErr  = () => document.querySelector('.attach-error')?.textContent?.trim() ?? null;
const removeBtn  = () => document.querySelector<HTMLButtonElement>('.composer-attach button');

/** Gercek bir dosya secimini taklit eder (jsdom'da `files` yazilamaz). */
function chooseFile(file: File): void {
  Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true });
  fileInput().dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}
const mkFile = (name = 'not.txt', type = 'text/plain', size = 12) => {
  const f = new File(['merhaba dünya'], name, { type });
  Object.defineProperty(f, 'size', { value: size, configurable: true });
  return f;
};
const uploads = () => fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/upload'));
const fileSends = () => emitted.filter(e => e.event === 'message:send' && e.payload.type === 'file');

beforeEach(() => {
  emitted = [];
  renderedMessages = [];
  localStorage.clear();
  resetOutboxMemory();
  resetLocalFirstOutboxRuntimeForTests();
  uploadResponse = () => ok({ url: '/uploads/abc123.txt', fileName: 'not.txt', fileType: 'text/plain', size: 12 });

  host = document.createElement('div');
  host.innerHTML = `
    <div id="msg-input-wrap">
      <input type="file" id="msg-file-input" hidden />
      <button type="button" id="btn-attach" aria-label="Dosya ekle"></button>
      <textarea id="msg-input"></textarea>
      <button type="button" data-bridge-action="sendMessage"></button>
    </div>`;
  document.body.appendChild(host);

  fetchMock = vi.fn(async () => uploadResponse());
  BridgeRegistry.register('apiFetch', ((...a: unknown[]) => fetchMock(...a)) as AnyFn);
  BridgeRegistry.register('getCurrentChannel', () => ({ _id: 'ch-1', type: 'text', name: 'genel', serverId: 'srv-1' }));
  BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-1' }));
  BridgeRegistry.register('getSocketConnected', () => true);
  BridgeRegistry.register('getMe', () => ({ _id: 'user-a' }));
  BridgeRegistry.register('appendMessage', (message: Record<string, unknown>) => { renderedMessages.push(message); });
  BridgeRegistry.register('updateMessage', (patch: Record<string, unknown>) => {
    const index = renderedMessages.findIndex(message => message._id === patch._id);
    if (index >= 0) renderedMessages[index] = { ...renderedMessages[index], ...patch };
  });
  BridgeRegistry.register('socket', {
    emit: (event: string, payload: Record<string, unknown>) => {
      emitted.push({ event, payload });
    },
  } as unknown as AnyFn);

  instance = mount(MessageInputPanel, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  for (const k of ['apiFetch', 'getCurrentChannel', 'getCurrentServer', 'getSocketConnected',
                   'getMe', 'appendMessage', 'updateMessage', 'socket']) {
    BridgeRegistry.unregister(k);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  resetOutboxMemory();
  resetLocalFirstOutboxRuntimeForTests();
});

// ════════════════════════════════════════════════════════════════════════════
describe('EK SEÇİMİ', () => {
  it('kabukta GERÇEK bir ek girişi vardır (regresyon kapısı)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');

    expect(html).toMatch(/id="msg-file-input"[^>]*type="file"|type="file"[^>]*id="msg-file-input"/);
    expect(html).toMatch(/id="btn-attach"/);
  });

  it('ek düğmesi dosya seçiciyi AÇAR', () => {
    const spy = vi.spyOn(fileInput(), 'click');
    attachBtn().click();
    flushSync();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('seçilen dosya ÖNİZLEMEDE ad ve boyutla görünür', () => {
    chooseFile(mkFile('rapor.pdf', 'application/pdf', 2048));

    expect(preview()).not.toBeNull();
    expect(preview()!.textContent).toContain('rapor.pdf');
    expect(preview()!.textContent).toContain('2 KB');
  });

  it('ek GÖNDERİMDEN ÖNCE kaldırılabilir', () => {
    chooseFile(mkFile());
    expect(preview()).not.toBeNull();

    removeBtn()!.click();
    flushSync();

    expect(preview()).toBeNull();
    expect(uploads()).toHaveLength(0);
  });

  it('ÇOK BÜYÜK dosya için istek ATILMAZ ve dürüst uyarı verilir', () => {
    chooseFile(mkFile('dev.zip', 'application/zip', 40 * 1024 * 1024));

    expect(attachErr()).toMatch(/çok büyük/i);
    expect(uploads()).toHaveLength(0);
  });
});

describe('EK GÖNDERİMİ — kanonik uç ve olay', () => {
  it('POZİTİF KONTROL: upload → idempotent message:send zinciri kanoniktir', async () => {
    chooseFile(mkFile());
    document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!.click();

    await vi.waitFor(() => { flushSync(); expect(fileSends()).toHaveLength(1); });

    // 1) Kanonik uca multipart POST
    expect(uploads()).toHaveLength(1);
    const init = uploads()[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
    // multipart sinirini tarayici yazar — elle Content-Type verilmez
    expect(init.headers).toBeUndefined();

    // 2) Kanonik outbox soket olayı ve idempotency alanları
    expect(fileSends()[0].payload).toMatchObject({
      channelId: 'ch-1', serverId: 'srv-1',
      type: 'file', fileName: 'not.txt', fileUrl: '/uploads/abc123.txt', fileType: 'text/plain',
    });
    expect(fileSends()[0].payload.ackId).toBeTruthy();
    expect(fileSends()[0].payload._tmpId).toBe(fileSends()[0].payload.ackId);

    // 3) Gonderim sonrasi ek temizlenir
    flushSync();
    expect(preview()).toBeNull();
  });

  it('İKİNCİ bir yükleme sahibi yoktur (tek istek, tek olay)', async () => {
    chooseFile(mkFile());
    document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(fileSends()).toHaveLength(1); });

    expect(uploads()).toHaveLength(1);
    expect(fileSends()).toHaveLength(1);
  });

  it('metin + ek birlikte: dosya gönderilir, METİN KAYBOLMAZ', async () => {
    chooseFile(mkFile());
    input().value = 'ekteki dosyaya bak';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(fileSends()).toHaveLength(1); });
    await vi.waitFor(() => {
      expect(emitted.filter(e => e.event === 'message:send')).toHaveLength(2);
    });

    const textSend = emitted.find(e => e.event === 'message:send' && e.payload.type !== 'file');
    expect(textSend?.payload.content).toBe('ekteki dosyaya bak');
  });
});

describe('EK HATA DURUMLARI — sunucunun kararı dürüstçe gösterilir', () => {
  // `uploadErrorText(status)` YALNIZCA durum koduna bakar; sunucunun `error`
  // govdesi ("max 25 MB", "dangerous content") kullaniciya ASLA gosterilmez.
  const cases: Array<[number, unknown, () => string]> = [
    [415, { error: 'File type not allowed' },                          () => t('upload_type_unsupported')],
    [413, { error: 'File too large. max 25 MB', code: 'BOOST_LIMIT' }, () => t('error_upload_size')],
    [422, { error: 'SVG contains dangerous content', code: 'SVG_UNSAFE' }, () => t('upload_security_failed')],
    [403, { error: 'forbidden' },                                      () => t('upload_forbidden')],
  ];

  for (const [status, body, expected] of cases) {
    it(`HTTP ${status} → dürüst mesaj, ek DÜŞÜRÜLMEZ, olay YAYILMAZ`, async () => {
      uploadResponse = () => ok(body, status);
      chooseFile(mkFile());
      document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!.click();

      await vi.waitFor(() => { flushSync(); expect(attachErr()).not.toBeNull(); });

      expect(attachErr()).toBe(expected());
      expect(attachErr()).not.toContain('25 MB');
      expect(attachErr()).not.toContain('dangerous');
      expect(fileSends()).toHaveLength(0);
      // Kullanici tekrar deneyebilsin diye ek KORUNUR.
      expect(preview()).not.toBeNull();
    });
  }

  it('yükleme 200 ama yanıt geçersizse başarı GÖSTERİLMEZ', async () => {
    uploadResponse = () => ok({ fileName: 'x' });   // url YOK
    chooseFile(mkFile());
    document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!.click();

    await vi.waitFor(() => { flushSync(); expect(attachErr()).not.toBeNull(); });

    expect(fileSends()).toHaveLength(0);
    expect(preview()).not.toBeNull();
  });

  it('ağ hatası ek KAYBETMEZ', async () => {
    fetchMock = vi.fn(async () => { throw new Error('network'); });
    chooseFile(mkFile());
    document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!.click();

    await vi.waitFor(() => { flushSync(); expect(attachErr()).not.toBeNull(); });

    expect(fileSends()).toHaveLength(0);
    expect(preview()).not.toBeNull();
  });
});

describe('YAPIŞTIRMA', () => {
  it('panodaki dosya EK olarak alınır (eski "Faz 5" yok sayması bitti)', () => {
    const file = mkFile('ekran.png', 'image/png', 4096);
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', { value: { files: [file] }, configurable: true });
    input().dispatchEvent(ev);
    flushSync();

    expect(preview()).not.toBeNull();
    expect(preview()!.textContent).toContain('ekran.png');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('panoda dosya YOKSA metin yapıştırma davranışı DEĞİŞMEZ', () => {
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', { value: { files: [] }, configurable: true });
    input().dispatchEvent(ev);
    flushSync();

    expect(ev.defaultPrevented).toBe(false);
    expect(preview()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('GÖNDERİM HATASI YAYILIMI — sessiz kayıp yok', () => {
  // CANLI KUSUR HATIRLATMASI: `file:send` sunucuda `createdAt` eksikliginden
  // HER ZAMAN patliyordu; hata `isolate()` tarafindan yakalanip yalnizca genel
  // bir `error:message` olarak donuyordu. Istemci ise `emit` eder etmez BASARI
  // sayiyordu. Iki kusur birlesince: yukleme olur, mesaj OLUSMAZ, kullanici
  // hicbir sey anlamaz. Asagidaki testler bu birlesimi imkansiz kilar.

  it('sunucu HATA dönerse outbox kaydı başarısız ve retry edilebilir kalır', async () => {
    chooseFile(mkFile());
    document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!.click();
    await vi.waitFor(() => expect(fileSends()).toHaveLength(1));
    const ackId = String(fileSends()[0].payload.ackId);
    BridgeRegistry.call('failPendingSend', ackId, 'Mesaj işlenemedi. Lütfen tekrar dene.');
    flushSync();

    expect(readOutbox('user-a')[0]).toMatchObject({ ackId, state: 'failed', fileUrl: '/uploads/abc123.txt' });
    expect(renderedMessages.find(message => message.ackId === ackId)).toMatchObject({ failed: true, pending: false });
    expect(uploads()).toHaveLength(1);
  });

  it('sunucu HİÇ yanıt vermezse outbox zaman aşımı BAŞARISIZLIK sayılır', async () => {
    vi.useFakeTimers();
    chooseFile(mkFile());
    document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!.click();

    // Do NOT use vi.waitFor with fake timers here: waitFor advances virtual
    // time and can consume the very 10s ACK timeout this test is proving.
    // Upload + JSON parsing are promise work, so drain microtasks without moving
    // the virtual clock until the canonical socket emit appears.
    for (let turn = 0; turn < 20 && fileSends().length === 0; turn += 1) {
      await Promise.resolve();
      flushSync();
    }
    expect(fileSends()).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10_001);
    flushSync();

    expect(readOutbox('user-a')[0]?.state).toBe('failed');
    expect(renderedMessages[0]).toMatchObject({ failed: true, pending: false });
  });

  it('hata sonrası retry AYNI ackId/fileUrl ile gider ve dosya yeniden yüklenmez', async () => {
    chooseFile(mkFile());
    const send = document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!;
    send.click();
    await vi.waitFor(() => expect(fileSends()).toHaveLength(1));
    const ackId = String(fileSends()[0].payload.ackId);
    BridgeRegistry.call('failPendingSend', ackId, 'reddedildi');
    BridgeRegistry.call('retrySend', ackId);

    expect(fileSends()).toHaveLength(2);
    expect(fileSends()[1].payload).toMatchObject({ ackId, fileUrl: '/uploads/abc123.txt' });
    expect(uploads()).toHaveLength(1);
  });

  it('ek kuyruğa alındığında ayrı socket dinleyicisi oluşturulmaz', async () => {
    chooseFile(mkFile());
    document.querySelector<HTMLButtonElement>('[data-bridge-action="sendMessage"]')!.click();
    await vi.waitFor(() => { flushSync(); expect(preview()).toBeNull(); });

    expect(fileSends()).toHaveLength(1);
  });
});
