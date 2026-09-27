// client/tests/renderer.test.ts
// Mesaj sunumu — CANLI sözleşme testleri (native Vitest/ESM, gerçek bileşen).
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — LIVE_MOVED + BÜYÜK ORANDA ALREADY_COVERED
// ════════════════════════════════════════════════════════════════════════════
//
// ÇÖKME NEDENİ (ölçüldü): `jest.mock is not a function` @ satır 25. Dosya
// `js/core/messages/renderer` modülünü CJS `require` + SEKİZ adet
// `{virtual:true}` mock ile yüklüyordu; süit 0 test kaydediyordu.
//
// ── ESKİ HEDEF: FULL_DEAD (kanıtlı) ─────────────────────────────────────────
// `js/core/messages/` DİZİNİ YOK. `renderMessage` üretimde yalnızca
// `js/types/globals.d.ts:179` tip bildirimi olarak yaşıyor. Çağrılabilir
// `renderMessage()` / `updateMessage()` / `deleteMessage()` API'leri YOK.
// Bugünkü sahip: `js/core/MessageRenderer.svelte` (384 satır).
//
// ── GÜVENLİK: REPLACED_BY_STRONGER_CONTRACT ─────────────────────────────────
// Eski renderer `innerHTML` + ELLE `escHtml` kullanıyordu. Eski test ise
// `utils.js`'i KENDİ yerel `escHtml` kopyasıyla mock'luyordu (o dosya:19) —
// yani ürünün kaçışını HİÇ çalıştırmıyordu. Bugün kullanıcı içeriği Svelte
// metin enterpolasyonu ile basılır; render zincirinde `innerHTML`/`{@html}`
// 0 kullanım (MessageRenderer.svelte + MessageListPanel.svelte doğrulandı).
// Ek katmanlar: `safeUrl()` javascript:/data: şemalarını eler, `avatarColor`
// `/^#[0-9a-f]{3,8}$/i` ile doğrulanır.
//
// ── ALREADY_COVERED (tests/Phase9Messaging.test.ts, GEÇEN süit) ─────────────
// Gerçek bileşene karşı zaten kapsanan ve BURADA TEKRARLANMAYAN sözleşmeler:
//   • XSS: `<img src=x onerror=...>` metin olarak basılır, eleman oluşmaz (:106)
//   • `javascript:` fileUrl → ek tamamen reddedilir (:106)
//   • `avatarColor` CSS enjeksiyonu engellenir (:106)
//   • semantik <article> + makine-okunur zaman damgası (:43)
//   • compact/gutter hizalaması (:53) · eylem düğmeleri + sahiplik (:60)
//   • reply durumları: jumpable / snapshot / deleted (:74)
//   • ek türleri (image/video/audio) + loading/preload (:96)
//   • reaksiyon pill'leri + pending/failed/retry (:116)
//
// ── FULL_DEAD (üretimde 0 eşleşme) ──────────────────────────────────────────
//   pinned · scheduledId · bridgedFrom · voice_message · transcript
//   blocked-user filtresi → `_blockedUserIds` yalnız globals.d.ts:145 tip
//   bildirimi; ÜRETİM UYGULAMASI YOK (dormant).
//   `.msg-group` / `.msg-continue` / `reply-quote` / `file-link` gibi eski CSS
//   seçicileri → bugünkü karşılıkları farklı (`.msg-compact`, `.msg-reply-ref`,
//   `.msg-file`) ve ilgili davranışlar Phase9Messaging'de kapsanıyor. Seçici
//   adları uygulama detayıdır; korunmaz.
//
// ── BU DOSYANIN KALAN GÖREVİ: UNIQUE_LIVE boşluklar ─────────────────────────
// Eski süitten YALNIZCA iki sözleşme hem CANLI hem de hiçbir geçen testte
// kapsanmıyordu (tests/ genelinde 0 eşleşme ile doğrulandı):
//   #6,#7 → sistem mesajı sunumu (`.msg-system` / `.sys-text`)
//   #16   → düzenlenmiş işareti (`(düzenlendi)`)
// Bunlar gerçek bileşene karşı burada korunur. Ham test sayısı yapay olarak
// korunmaz. Üretim kodu bu turda DEĞİŞTİRİLMEMİŞTİR.

import { describe, it, expect, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import MessageRenderer, { type MessageData } from '../js/core/MessageRenderer.svelte';

function message(overrides: Partial<MessageData> = {}): MessageData {
  return {
    _id: 'm-1', userId: 'u-1', displayName: 'Ada Lovelace',
    content: 'Merhaba Bridge', createdAt: 1_754_000_000_000,
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
// Sistem mesajı — UNIQUE_LIVE (MessageRenderer.svelte:134-138)
// ════════════════════════════════════════════════════════════════════════════
describe('sistem mesajı sunumu', () => {
  it('type=system ayrı bir sistem makalesi üretir', () => {
    const view = render(MessageRenderer, {
      props: { message: message({ type: 'system', content: 'Kanal oluşturuldu' }) },
    });

    const article = view.container.querySelector('article.msg-system');
    expect(article).not.toBeNull();
    expect(article?.getAttribute('aria-label')).toBe('Sistem mesajı');
    expect(view.container.querySelector('.sys-text')?.textContent).toBe('Kanal oluşturuldu');
  });

  it('sistem mesajı normal mesaj kromunu (avatar/başlık/eylemler) taşımaz', () => {
    const view = render(MessageRenderer, {
      props: { message: message({ type: 'system', content: 'Kanal oluşturuldu' }) },
    });

    expect(view.container.querySelector('.msg-avatar')).toBeNull();
    expect(view.container.querySelector('.msg-head')).toBeNull();
    expect(view.container.querySelector('.msg-actions')).toBeNull();
  });

  it('GÜVENLİK: sistem mesajı içeriği de metin olarak basılır', () => {
    // Sistem metinleri sunucu üretimlidir ama kullanıcı adı taşıyabilir.
    const view = render(MessageRenderer, {
      props: { message: message({ type: 'system', content: '<img src=x onerror=alert(1)>' }) },
    });

    expect(view.container.querySelector('.sys-text')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(view.container.querySelector('.sys-text img')).toBeNull();
  });

  it('normal mesaj sistem sınıfını ALMAZ', () => {
    const view = render(MessageRenderer, { props: { message: message() } });

    expect(view.container.querySelector('article.msg-system')).toBeNull();
    expect(view.container.querySelector('article.msg')).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Kimlik/dosya alanlarında kaçış — SECURITY_UNIQUE
// (messages-render.test.ts'in #7,#9,#14 iddialarının GERÇEK karşılığı; eski
//  test bunları test-yerel escHtml ile ölçüyordu, Phase9Messaging ise yalnız
//  content/fileUrl/avatarColor'ı açıkça iddia ediyor.)
// ════════════════════════════════════════════════════════════════════════════
describe('kullanıcı kontrollü alanların kaçışı', () => {
  const PAYLOAD = '<img src=x onerror=alert(1)>';

  it('displayName HTML olarak enjekte EDİLMEZ', () => {
    const view = render(MessageRenderer, { props: { message: message({ displayName: PAYLOAD }) } });

    expect(view.container.querySelector('.msg-author')?.textContent).toBe(PAYLOAD);
    expect(view.container.querySelector('.msg-author img')).toBeNull();
    expect(view.container.querySelector('img[onerror]')).toBeNull();
  });

  it('replyTo displayName ve içeriği HTML olarak enjekte EDİLMEZ', () => {
    const view = render(MessageRenderer, {
      props: { message: message({ replyTo: { _id: 'm-0', displayName: PAYLOAD, content: PAYLOAD } }) },
    });

    const ref = view.container.querySelector('.msg-reply-ref');
    expect(ref?.querySelector('.reply-author')?.textContent).toBe(PAYLOAD);
    expect(ref?.querySelector('img')).toBeNull();
  });

  it('fileName HTML olarak enjekte EDİLMEZ (metin ve alt niteliğinde)', () => {
    const view = render(MessageRenderer, {
      props: { message: message({ fileUrl: '/uploads/x', fileName: PAYLOAD, fileType: 'application/pdf' }) },
    });

    expect(view.container.querySelector('.msg-file')?.textContent).toContain(PAYLOAD);
    expect(view.container.querySelector('.msg-attachment img')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Düzenlenmiş işareti — UNIQUE_LIVE (MessageRenderer.svelte:190, :194)
// ════════════════════════════════════════════════════════════════════════════
describe('düzenlenmiş işareti', () => {
  it('editedAt varsa başlıkta (düzenlendi) görünür', () => {
    const view = render(MessageRenderer, {
      props: { message: message({ editedAt: 1_754_000_100_000 }) },
    });

    expect(view.container.querySelector('.msg-edited')?.textContent).toContain('düzenlendi');
  });

  it('editedAt yoksa işaret ÇIKMAZ', () => {
    const view = render(MessageRenderer, { props: { message: message() } });

    expect(view.container.querySelector('.msg-edited')).toBeNull();
  });

  it('compact mesajda da düzenlendi işareti korunur (başlık satırı yokken)', () => {
    // Gruplanmış mesajda .msg-head çizilmez; işaret satır-içi varyanta düşer.
    const view = render(MessageRenderer, {
      props: { message: message({ editedAt: 1_754_000_100_000 }), compact: true },
    });

    expect(view.container.querySelector('.msg-head')).toBeNull();
    expect(view.container.querySelector('.msg-edited')?.textContent).toContain('düzenlendi');
  });
});
