// client/tests/channel-list.test.ts
// Kanal listesi — CANLI sözleşme testleri (native Vitest/ESM, gerçek bileşenler).
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — LIVE_MOVED_CONTRACT (24 iddia → gerçek Svelte sahiplerine taşındı)
// ════════════════════════════════════════════════════════════════════════════
//
// ÇÖKME NEDENİ (ölçüldü): `jest.mock is not a function` @ satır 10; süit 0 test
// kaydediyordu. Ama asıl sorun bundan derindi:
//
//   1) Dosya `:93`'te `require('../js/core/channel-list')` yapıyordu.
//      Legacy `js/core/channel-list.ts` SİLİNMİŞ, `channel-list/index.ts` de YOK.
//      Yani süit var olmayan bir modüle dayanıyordu; `vi.mock`'a çevirmek
//      yalnızca MODULE_RESOLUTION hatasını açığa çıkarırdı. Shim YARATILMADI.
//
//   2) `jest.mock` factory'si (`:10-83`) `mountOrUpdateChannelList`'in ~70
//      SATIRLIK YENİDEN İMPLEMENTASYONUYDU (kendi `esc()` kaçış yardımcısı
//      dahil). Eski `renderChannels` iddiaları üretimi değil, TEST-YEREL kodu
//      ölçüyordu. Bu mock tamamen kaldırıldı.
//
// BUGÜNKÜ SAHİPLER (kaynak doğrulandı, placeholder DEĞİL):
//   js/core/channel-list/ChannelItem.svelte   (109 satır) — öğe düzeyi
//   js/core/channel-list/ChannelList.svelte   (139 satır) — liste/kategori
//   js/core/ChannelListManager.svelte         — loadChannels/state
// Erişilebilir: app.ts:50 + index.html konteyneri.
//
// ── 24/24 İDDİA HARİTASI ────────────────────────────────────────────────────
// A) makeChannelEl (10) → LIVE_MOVED → ChannelItem
//    A1-A4 `#`/🔊/📋/📣 emoji metni → STALE_IMPLEMENTATION_DETAIL: bugün
//          `iconKind` türetiliyor ve tip başına inline SVG basılıyor
//          (ChannelItem:19-25, :46-58). Emoji literalleri KORUNMADI; canlı
//          garanti "tip başına ayırt edici ikon dalı + doğru data-type".
//    A5    kanal adı → LIVE_SAME (`.ch-name` = {channel.name})
//    A6    XSS → REPLACED_BY_STRONGER_CONTRACT: Svelte metin enterpolasyonu.
//          Entity serileştirmesine DEĞİL, semantiğe bakılır.
//    A7-A8 nsfw 18+ rozeti → LIVE_SAME (:61-63)
//    A9    data-id / data-type → LIVE_SAME (:32-33)
//    A10   vc-*/unread-* gizli işaretçiler → LIVE_SAME (:64-65) — YALNIZ DOM
//          işaretçisi sözleşmesi; eski unread state mimarisi DİRİLTİLMEDİ.
//
// B) renderChannels (6) → LIVE_MOVED → ChannelList (mock değil, gerçek bileşen)
//    kategori gruplama · kategori başlıkları · collapsed gizleme ·
//    position sıralaması · kategorisiz kanalların önce gelmesi.
//    NOT: collapsed bugün `display:none` ile değil KOŞULLU RENDER ile
//    (`{#if !isCollapsed}`) sağlanıyor — garanti aynı, temsil değişti.
//
// C) loadChannels (2) → LIVE ama sahibi ChannelListManager.svelte:104.
//    Endpoint bugün de `/api/servers/:id/channels` (apiFetch +
//    encodeURIComponent). ANCAK `window.currentServerChannels` ÖLÜ: yerine
//    `BridgeRegistry.call('setCurrentServerChannels', …)` → AppState.svelte:86.
//    Manager'ı mount etmek apiFetch/registry/token sınırlarını gerektirir;
//    BU DOSYA KAPSAMINA ALINMADI ve kapsam boşluğu olarak KAYDA GEÇTİ
//    (bugün de zaten 0 kapsam vardı — süit hiç çalışmıyordu).
//
// D) showInputModal / showConfirmModal (3) → FULL_DEAD (üretimde 0 eşleşme).
//    Ayrıca kayıtlı ürün kararı: Channel create = ABSENT. Yeniden yaratılmadı.
//
// ── TEKRAR ETMEME ───────────────────────────────────────────────────────────
// tests/channel-shell-accessibility.test.ts ZATEN gerçek ChannelItem/ChannelList
// üzerinde şunları kapsıyor: Space ile seçim + `aria-current` semantiği, eylem
// menüsünün klavyeyle seçim tetiklememesi, registry sahibi yokken eylemlerin
// sunulmaması, kategori "ekle" düğmesinin klavyeyle daraltma yapmaması.
// Bunlar BURADA TEKRARLANMAZ.
//
// Üretim kodu bu turda DEĞİŞTİRİLMEMİŞTİR.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ChannelItem, { type ChannelData } from '../js/core/channel-list/ChannelItem.svelte';
import ChannelList from '../js/core/channel-list/ChannelList.svelte';

function channel(overrides: Partial<ChannelData> & { categoryId?: string; category?: string } = {}): ChannelData {
  return { _id: 'ch-001', name: 'genel', type: 'text', nsfw: false, ...overrides } as ChannelData;
}

const noop = (): void => {};

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
// A) ChannelItem — öğe düzeyi sözleşmeler
// ════════════════════════════════════════════════════════════════════════════
describe('ChannelItem — kanal sunumu', () => {
  it('kanal adını METİN olarak basar', () => {
    const view = render(ChannelItem, { props: { channel: channel({ name: 'test-kanal' }), onSelect: noop } });

    expect(view.container.querySelector('.ch-name')?.textContent).toBe('test-kanal');
  });

  it('data-id ve data-type köke yazılır', () => {
    const view = render(ChannelItem, { props: { channel: channel({ _id: 'ch-42', type: 'voice' }), onSelect: noop } });
    const root = view.container.querySelector('.ch-item');

    expect(root?.getAttribute('data-id')).toBe('ch-42');
    expect(root?.getAttribute('data-type')).toBe('voice');
  });

  it('type verilmemişse data-type "text"e düşer', () => {
    const view = render(ChannelItem, { props: { channel: { _id: 'ch-1', name: 'x' } as ChannelData, onSelect: noop } });

    expect(view.container.querySelector('.ch-item')?.getAttribute('data-type')).toBe('text');
  });

  it('desteklenen her kanal tipi kendi ikon dalını üretir (emoji DEĞİL, SVG)', () => {
    // Eski test '#','🔊','📋','📣' metinlerini bekliyordu; bugün iconKind
    // türetiliyor ve tip başına ayrı SVG basılıyor. Uygulama detayına
    // (path verisine) bağlanmadan dalın varlığı ve tipin doğruluğu ölçülür.
    const seen = new Set<string>();

    for (const type of ['text', 'voice', 'forum', 'announcement', 'stage']) {
      const view = render(ChannelItem, { props: { channel: channel({ _id: `ch-${type}`, type }), onSelect: noop } });
      const item = view.container.querySelector('.ch-item');

      expect(item?.getAttribute('data-type')).toBe(type);
      const icon = item?.querySelector('.ch-icon svg');
      expect(icon).not.toBeNull();
      seen.add(icon!.innerHTML);
      cleanup();
    }

    // Beş tipin tamamı birbirinden ayırt edilebilir ikon üretmeli.
    expect(seen.size).toBe(5);
  });

  it('ses ve sahne kanalları tipe özgü aria-label taşır', () => {
    const voice = render(ChannelItem, { props: { channel: channel({ type: 'voice', name: 'sesli' }), onSelect: noop } });
    // ERISILEBILIRLIK DUZELTMESI: kanal ACMA artik GERCEK bir `<button>`
    // (`.ch-open`). Onceden `role="button"` bir div icinde gercek bir
    // `<button>` (kanal islemleri) vardi — axe bunu `serious`
    // `nested-interactive` olarak isaretliyordu.
    expect(voice.container.querySelector('.ch-open')?.getAttribute('aria-label')).toBe('Ses kanalı: sesli');
    cleanup();

    const stage = render(ChannelItem, { props: { channel: channel({ type: 'stage', name: 'sahne' }), onSelect: noop } });
    expect(stage.container.querySelector('.ch-open')?.getAttribute('aria-label')).toBe('Sahne kanalı: sahne');
  });

  it('nsfw=true ise 18+ rozeti çıkar', () => {
    const view = render(ChannelItem, { props: { channel: channel({ nsfw: true }), onSelect: noop } });

    expect(view.container.querySelector('.ch-nsfw-badge')?.textContent).toContain('18+');
  });

  it('nsfw=false ise 18+ rozeti ÇIKMAZ', () => {
    const view = render(ChannelItem, { props: { channel: channel({ nsfw: false }), onSelect: noop } });

    expect(view.container.querySelector('.ch-nsfw-badge')).toBeNull();
  });

  it('voice-count ve unread işaretçileri başlangıçta GİZLİDİR', () => {
    // Yalnız DOM işaretçisi sözleşmesi; eski unread state mimarisi canlı değil.
    const view = render(ChannelItem, { props: { channel: channel({ _id: 'ch-99' }), onSelect: noop } });

    expect(view.container.querySelector<HTMLElement>('#vc-ch-99')?.style.display).toBe('none');
    expect(view.container.querySelector<HTMLElement>('#unread-ch-99')?.style.display).toBe('none');
  });

  it('GÜVENLİK: kanal adındaki HTML enjekte EDİLMEZ', () => {
    const payload = '<script>alert(1)</script>';
    const view = render(ChannelItem, { props: { channel: channel({ name: payload }), onSelect: noop } });

    // Semantik doğrulama — entity serileştirmesine bağlanılmaz.
    expect(view.container.querySelector('.ch-name')?.textContent).toBe(payload);
    expect(view.container.querySelector('script')).toBeNull();
  });

  it('GÜVENLİK: img/onerror yükü de çalıştırılabilir DOM üretmez', () => {
    const view = render(ChannelItem, {
      props: { channel: channel({ name: '<img src=x onerror=alert(1)>' }), onSelect: noop },
    });

    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('[onerror]')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B) ChannelList — kategori/gruplama sözleşmeleri (GERÇEK bileşen)
// ════════════════════════════════════════════════════════════════════════════
describe('ChannelList — kategorisiz (fallback) mod', () => {
  const channels = [
    channel({ _id: 'ch-1', name: 'genel',  category: 'Metin' }),
    channel({ _id: 'ch-2', name: 'sohbet', category: 'Metin' }),
    channel({ _id: 'ch-3', name: 'sesli',  category: 'Ses', type: 'voice' }),
  ];

  it('kanalları category alanına göre gruplar ve başlıkları basar', () => {
    const view = render(ChannelList, { props: { channels, onSelect: noop } });

    const names = [...view.container.querySelectorAll('.cat-name')].map(n => n.textContent);
    expect(names).toEqual(['Metin', 'Ses']);
    expect(view.container.querySelectorAll('.ch-item')).toHaveLength(3);
  });

  it('category taşımayan kanal GENERAL altında toplanır', () => {
    const view = render(ChannelList, { props: { channels: [channel({ _id: 'ch-x', name: 'başıboş' })], onSelect: noop } });

    expect(view.container.querySelector('.cat-name')?.textContent).toBe('GENERAL');
  });

  it('collapsed kategori kanalları RENDER EDİLMEZ', () => {
    // Bugünkü temsil: koşullu render ({#if !isCollapsed}) — display:none değil.
    const view = render(ChannelList, {
      props: { channels, collapsedCategoryKeys: new Set(['Metin']), onSelect: noop },
    });

    expect(view.container.querySelector('[data-id="ch-1"]')).toBeNull();
    expect(view.container.querySelector('[data-id="ch-3"]')).not.toBeNull();
    // Başlık görünmeye devam eder ve durumunu erişilebilir biçimde bildirir.
    // ERISILEBILIRLIK DUZELTMESI: durum artik SARMALAYICI div'de degil,
    // GERCEK acma/kapama dugmesinde bildirilir. Onceki yapi `role="button"`
    // bir div icinde gercek bir `<button>` barindiriyordu — axe bunu
    // `serious` `nested-interactive` olarak isaretliyordu.
    const toggle = [...view.container.querySelectorAll('.cat-toggle')]
      .find(el => el.querySelector('.cat-name')?.textContent === 'Metin');
    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ChannelList — DB kategori modu', () => {
  const categories = [
    { _id: 'cat-b', name: 'İkinci', position: 2 },
    { _id: 'cat-a', name: 'Birinci', position: 1 },
  ];
  const channels = [
    channel({ _id: 'ch-free', name: 'kategorisiz' }),
    channel({ _id: 'ch-a', name: 'a-kanal', categoryId: 'cat-a' }),
    channel({ _id: 'ch-b', name: 'b-kanal', categoryId: 'cat-b' }),
  ];

  it('kategoriler position sırasına göre dizilir', () => {
    const view = render(ChannelList, { props: { channels, categories, onSelect: noop } });

    const names = [...view.container.querySelectorAll('.cat-name')].map(n => n.textContent);
    expect(names).toEqual(['Birinci', 'İkinci']);
  });

  it('kategorisiz kanallar kategorilerden ÖNCE gelir', () => {
    const view = render(ChannelList, { props: { channels, categories, onSelect: noop } });

    const rendered = [...view.container.querySelectorAll('.ch-item, .ch-category')];
    const freeIndex = rendered.findIndex(el => el.getAttribute('data-id') === 'ch-free');
    const firstCategoryIndex = rendered.findIndex(el => el.classList.contains('ch-category'));

    expect(freeIndex).toBeGreaterThanOrEqual(0);
    expect(freeIndex).toBeLessThan(firstCategoryIndex);
  });

  it('kanallar kendi kategorisinin sarmalayıcısına yerleşir', () => {
    const view = render(ChannelList, { props: { channels, categories, onSelect: noop } });

    expect(view.container.querySelector('#cat-channels-cat-a [data-id="ch-a"]')).not.toBeNull();
    expect(view.container.querySelector('#cat-channels-cat-b [data-id="ch-b"]')).not.toBeNull();
  });

  it('kullanıcıya özel collapsedCategoryKeys DB kategori sarmalayıcısını gizler', () => {
    const view = render(ChannelList, {
      props: {
        channels,
        categories: [{ _id: 'cat-a', name: 'Birinci', position: 1, collapsed: true }],
        collapsedCategoryKeys: new Set(['cat-a']),
        onSelect: noop,
      },
    });

    expect(view.container.querySelector('#cat-channels-cat-a')).toBeNull();
    expect(view.container.querySelector('[data-id="ch-a"]')).toBeNull();
  });

  it('activeChannelId ilgili öğeye aktif durumu geçirir', () => {
    const view = render(ChannelList, { props: { channels, categories, activeChannelId: 'ch-a', onSelect: noop } });

    expect(view.container.querySelector('[data-id="ch-a"]')?.classList.contains('active')).toBe(true);
    expect(view.container.querySelector('[data-id="ch-b"]')?.classList.contains('active')).toBe(false);
  });

  it('kanal seçimi onSelect ile üst katmana iletilir', () => {
    const onSelect = vi.fn();
    const view = render(ChannelList, { props: { channels, categories, onSelect } });

    // Tiklama hedefi artik satirin ICINDEKI gercek dugmedir.
    (view.container.querySelector('[data-id="ch-a"] .ch-open') as HTMLElement).click();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]._id).toBe('ch-a');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kanal YOKKEN boş durum', () => {
  // ══════════════════════════════════════════════════════════════════════════
  // KAPATILAN GERÇEK BOŞLUK
  // ══════════════════════════════════════════════════════════════════════════
  // Sunucuda hiç kanal yoksa İKİ dal da boş dönüyordu (`fallbackGroups()`
  // boş nesne, `categories` boş dizi) ve kenar çubuğu tamamen boş kalıyordu.
  // Yeni bir sunucu kuran kullanıcı ne olduğunu ya da SIRADA NE YAPACAĞINI
  // anlatan hiçbir şey görmüyordu.

  it('kanal yokken boş durum GÖRÜNÜR', () => {
    const { container } = render(ChannelList, { props: { channels: [], onSelect: () => {} } });
    expect(container.querySelector('.ch-empty')).toBeTruthy();
  });

  it('kanal oluşturabilen kullanıcıya EYLEM gösterilir', () => {
    const onCreateChannel = vi.fn();
    const { container } = render(ChannelList, {
      props: { channels: [], onSelect: () => {}, onCreateChannel },
    });

    const cta = container.querySelector<HTMLButtonElement>('.ch-empty-cta');
    expect(cta, 'kanal oluştur düğmesi yok').toBeTruthy();
    cta!.click();
    expect(onCreateChannel).toHaveBeenCalledTimes(1);
  });

  it('yetkisi olmayana YANLIŞ UMUT verilmez', () => {
    // Görünürlük bir güvenlik sınırı DEĞİLDİR (sunucu yetkiyi doğrular);
    // amaç kullanıcıya yapamayacağı bir eylemi teklif etmemektir.
    const { container } = render(ChannelList, { props: { channels: [], onSelect: () => {} } });

    expect(container.querySelector('.ch-empty-cta')).toBeNull();
    expect(container.querySelector('.ch-empty-hint')?.textContent).toBeTruthy();
  });

  it('kanal VARKEN boş durum gösterilmez', () => {
    // Pozitif kontrol: aksi halde "her zaman göster" de testi geçerdi.
    const { container } = render(ChannelList, {
      props: {
        channels: [{ _id: 'c1', name: 'genel', type: 'text' }],
        onSelect: () => {},
      },
    });
    expect(container.querySelector('.ch-empty')).toBeNull();
  });
});
