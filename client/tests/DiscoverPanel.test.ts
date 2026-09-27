// client/tests/DiscoverPanel.test.ts
// DiscoverPanel — GERÇEK bileşen sözleşme testleri (native Vitest/ESM).
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — NATIVE_VITEST_MIGRATION (CLASS A)
// ════════════════════════════════════════════════════════════════════════════
//
// ÇÖKME NEDENİ (ölçüldü): `jest.mock is not a function` @ satır 54; süit 0 test
// kaydediyordu. Sözleşme sorunu DEĞİLDİ: dosya zaten GERÇEK bileşeni
// (`js/core/DiscoverPanel.svelte`, 798 satır) @testing-library/svelte ile mount
// ediyordu ve üç mock'u da VIRTUAL DEĞİLDİ. Yalnız Jest→Vitest API'si taşındı.
//
// MOCK DENETİMİ (üçü de gerçek dış sınır, hepsi hoisting-güvenli — factory'ler
// sonradan tanımlanan hiçbir değişkene dokunmuyor):
//   api-fetch.js      → ağ sınırı (bileşen: /api/discover, /featured,
//                       /categories, POST /api/servers/:id/join)
//   globals.js        → getAPI() yapılandırma sınırı
//   bridge-registry.js→ bileşen `call`, `register` VE `get` kullanır.
//
// ── DÜZELTİLEN ÖLÇÜM KÖRLÜĞÜ ────────────────────────────────────────────
// Bu mock eskiden YALNIZCA `register` + `call` sağlıyordu ve yukarıdaki yorum
// "bileşen yalnızca `call` kullanır" diyordu. İKSİ DE YANLIŞTI: bileşen
// `BridgeRegistry.get('socket')` çağırıyor (DiscoverPanel.svelte:170, 200).
//
// SONUCU ÖLÇÜLDÜ: her mount/unmount'ta
//     TypeError: BridgeRegistry.get is not a function
// fırlatıyordu — tek koşuda 38 "unhandled error". Bunlar SÜİTİ DÜŞÜRMÜYOR,
// yalnızca uyarı olarak basılıyordu; dolayısıyla gerçek zamanlı üye/online
// abonelik yolu (`subscribeRealtimeCounts` / `unsubscribeRealtimeCounts`)
// HIÇBİR ZAMAN ÇALIŞMADI ve tamamen test D I Ş I N D A kaldı.
//
// Mock artık gerçek sözleşmeyi taşıyor: `get('socket')` denetlenebilir sahte
// bir soket döndürür, böylece o yol GERÇEKTEN yürütülür ve iddia edilir.
//
// ── ÜRÜN ERİŞİLEBİLİRLİĞİ: DÜZELTİLDİ — DISCOVER BAĞLI ─────────────────────
// Burada eskiden "bileşen üründe MOUNT EDİLMİYOR / DORMANT_COMPLETE_FEATURE /
// DISCOVER_PRODUCT_DECISION_REQUIRED = YES" yazıyordu. Bu ARTIK DOĞRU DEĞİL:
//
//     js/app.ts:234   import './core/discover-svelte.ts';
//
// Yani auto-mount shim üretim paketindedir ve `DiscoverPanel.svelte` ondan
// ulaşılabilir.
//
// ── ESKİ NOT NEDEN YANLIŞTI ────────────────────────────────────────────────
// İddia, bir import tarayıcısının çıktısına dayanıyordu ve o tarayıcının
// deseni `\s*` kullanıyordu — satır sonlarını geçer. Bu depodaki Türkçe
// yorumlar kesme işareti (') içerdiği için bir yorumdaki "from" kelimesi
// aşağıdaki bir kesme işaretiyle eşleşiyor ve ARADAKİ GERÇEK import'u
// yutuyordu. Ölçüm aracı ulaşılabilirliği OLDUĞUNDAN DAR gösteriyordu.
//
// Tarayıcı düzeltildi (`client/scripts/production-reachable-coverage.js`:
// yorumlar çıkarılır, desen satır atlamaz) ve artık tek kanonik kopya
// paylaşılır. Ölçüm: ulaşılabilir 175 dosya (önce 173 sanılıyordu).
//
// Buradaki testler yine BİLEŞEN düzeyi sözleşmedir ("mount edildiğinde doğru
// davranır"); ancak "ürüne bağlı değil" uyarısı KALDIRILDI çünkü yanlıştı.
//
// KALDIRILAN İDDİA (1): eski "ADR-0008 servis sınırı" testi yalnızca
// `expect(mockSocket.emit).toBeDefined()` diyordu — kendi ürettiği vi.fn()'in
// tanımlı olduğunu doğrulayan VAKUMLU gövde (HARNESS_ONLY). Bileşenin socket'ı
// doğrudan import etmediği iddiası statik bir yapı kuralıdır, çalışma zamanında
// bu şekilde kanıtlanamaz. 22 → 21.
//
// Son hardening turu ayrıca ağ/realtime girdilerini normalize eder, bayat
// istekleri geçersiz kılar ve katılımı tek-uçuşlu hale getirir; aşağıdaki
// davranış testleri bu üretim sınırlarını da doğrular.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import DiscoverPanel from '../js/core/DiscoverPanel.svelte';

// ── Mock'lar ──────────────────────────────────────────────────────────────────

const mockServers = [
  {
    _id: 's1',
    name: 'Gaming Hub',
    description: 'Oyuncular için büyük bir topluluk',
    memberCount: 5000,
    onlineCount: 320,
    category: 'gaming',
    tags: ['oyun', 'fps', 'rpg'],
    featured: true,
    verified: true,
    createdAt: Date.now() - 100 * 86400000,
  },
  {
    _id: 's2',
    name: 'Kod Kampüsü',
    description: 'Yazılım geliştirme topluluğu',
    memberCount: 1200,
    onlineCount: 89,
    category: 'tech',
    tags: ['kod', 'python', 'js'],
    boostLevel: 2,
    createdAt: Date.now() - 20 * 86400000, // yeni sunucu
  },
  {
    _id: 's3',
    name: 'Müzik Kulübü',
    description: 'Müzik severler için',
    memberCount: 850,
    onlineCount: 45,
    category: 'music',
    tags: ['müzik', 'rock'],
    createdAt: Date.now() - 200 * 86400000,
  },
];

const mockFeatured = [mockServers[0]];
const mockCategories = [
  { id: 'gaming', label: 'Oyun' },
  { id: 'tech',   label: 'Teknoloji' },
  { id: 'music',  label: 'Müzik' },
];

// apiFetch mock
vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: vi.fn(),
}));

// globals mock
vi.mock('../js/core/globals.js', () => ({
  getAPI: vi.fn(() => 'http://localhost:3001'),
}));

// BridgeRegistry mock — `get` DÂHİL (bkz. başlıktaki ölçüm körlüğü notu).
vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: vi.fn(),
    // `unregister` (onDestroy) ve `has` (exclusive-surface, acilista rakip
    // yuzeyleri kapatir) URETIMDE cagriliyordu ama mock'ta YOKTU: panel her
    // acilista `BridgeRegistry.has is not a function` ile patliyor ve bu
    // dosyadaki 47 test olcum yapmadan dusuyordu.
    unregister: vi.fn(),
    has: vi.fn(() => false),
    call: vi.fn(),
    get: vi.fn(),
  },
}));

import { apiFetch } from '../js/core/api-fetch.js';
import { BridgeRegistry } from '../js/core/bridge-registry.js';

const mockApiFetch = vi.mocked(apiFetch);

/**
 * Faz 12 sonrası: panel artık GİZLİ başlar ve rail'deki "Keşfet" düğmesiyle
 * açılır (kardeş yüzey FriendsPanel ile aynı sözleşme). Testler paneli
 * GERÇEK açıcı üzerinden açar — registry'ye kaydedilen `showDiscoverPanel`
 * fonksiyonu çağrılır; test-yerel bir görünürlük hilesi kullanılmaz.
 */
async function openPanel(): Promise<void> {
  const call = vi.mocked(BridgeRegistry.register).mock.calls
    .find(c => c[0] === 'showDiscoverPanel');
  if (!call) throw new Error("showDiscoverPanel registry kaydi YOK");
  (call[1] as () => void)();
  await tick();
}

/**
 * BUGÜNKÜ SÖZLEŞME: varsayılan sekme 'featured' ve YALNIZCA öne çıkanları
 * listeler (DiscoverPanel.svelte:94-95 — `featured.length ? featured :
 * allServers.filter(s => s.featured)`). Eski testler varsayılan sekmenin TÜM
 * sunucuları listelediğini varsayıyordu; 8 hatanın tek ortak nedeni buydu.
 *
 * Tüm sunucu kümesini gerektiren testler önce '✨ Yeni' sekmesine geçer —
 * bu sekme `allServers`ı tarihe göre sıralar (:100-101). Kategori ve arama
 * filtreleri sekme listesinin ÜZERİNE uygulanır (:118-128), dolayısıyla
 * doğru sekme bu testlerin ön koşuludur.
 */
async function showAllServers(): Promise<void> {
  await waitFor(() => screen.getByText('✨ Yeni'));
  await fireEvent.click(screen.getByText('✨ Yeni'));
}

function makeOkResponse(data: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

// İZOLASYON: Vitest altında @testing-library/svelte'in otomatik temizliği
// garanti değildir; açıkça çağrılır (Phase9Messaging.test.ts de kendi
// teardown'ını taşır). NOT: buradaki "multiple elements" hataları biriken
// mount'tan DEĞİL, öne çıkan sunucunun hem featured şeridinde hem grid'de
// görünmesinden kaynaklanıyordu — temizlik yine de doğru hijyendir.
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

/**
 * Denetlenebilir sahte soket. `on` ile kaydedilen dinleyiciler saklanır ki
 * testler sunucudan gelen olayı GERÇEKTEN tetikleyebilsin — bileşenin iç
 * durumunu elle kurcalamak yerine.
 */
type FakeSocket = {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  handlers: Map<string, (d: unknown) => void>;
};

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, (d: unknown) => void>();
  return {
    handlers,
    emit: vi.fn(),
    on: vi.fn((event: string, cb: (d: unknown) => void) => { handlers.set(event, cb); }),
    off: vi.fn((event: string) => { handlers.delete(event); }),
  };
}

let fakeSocket: FakeSocket;

beforeEach(() => {
  vi.clearAllMocks();
  fakeSocket = makeFakeSocket();
  vi.mocked(BridgeRegistry.get).mockImplementation(
    (name: string) => (name === 'socket' ? fakeSocket : null) as never,
  );
  // Varsayılan: başarılı API yanıtları
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/discover/featured'))   return Promise.resolve(makeOkResponse(mockFeatured));
    if (url.includes('/discover/categories')) return Promise.resolve(makeOkResponse(mockCategories));
    if (url.includes('/discover'))             return Promise.resolve(makeOkResponse(mockServers));
    return Promise.resolve(makeOkResponse({}));
  });
});

// ── Testler ───────────────────────────────────────────────────────────────────

describe('DiscoverPanel — render', () => {
  test('skeleton yükleme sırasında gösterilir', async () => {
    // apiFetch hiç resolve etmesin (loading state)
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(DiscoverPanel);
    await openPanel();
    // Skeleton element'leri var mı?
    const skeletons = document.querySelectorAll('.skeleton-card');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  test('sunucular yüklendikten sonra grid gösterilir', async () => {
    render(DiscoverPanel);
    await openPanel();
    await showAllServers();   // 'featured' sekmesi yalnız öne çıkanları listeler

    await waitFor(() => {
      expect(screen.getByText('Gaming Hub')).toBeInTheDocument();
    });
    expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument();
    expect(screen.getByText('Müzik Kulübü')).toBeInTheDocument();
  });

  test('hero banner ve sunucu sayısı gösterilir', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => {
      expect(screen.getByText(/Toplulukları Keşfet/)).toBeInTheDocument();
    });
    expect(screen.getByText(/topluluk seni bekliyor/)).toBeInTheDocument();
  });

  test('featured sunucu bölümü gösterilir (tab=featured + featured list dolu)', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => {
      expect(screen.getByText('⭐ Öne Çıkan Sunucular')).toBeInTheDocument();
    });
  });

  test('verified badge gösterilir', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => {
      expect(screen.getByTitle('Doğrulanmış')).toBeInTheDocument();
    });
  });

  test('boost badge gösterilir (boostLevel >= 2)', async () => {
    // Rozeti taşıyan sunucu (Kod Kampüsü) öne çıkan DEĞİL — doğru sekmeye geç.
    render(DiscoverPanel);
    await openPanel();
    await showAllServers();

    await waitFor(() => {
      expect(screen.getByText(/🚀 L2/)).toBeInTheDocument();
    });
  });
});

describe('DiscoverPanel — tab geçişi', () => {
  test('Trend tab\'ına geçince stats bar görünür', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => screen.getByText('📈 Trend'));
    fireEvent.click(screen.getByText('📈 Trend'));

    // "çevrimiçi" hem stats bar'da hem sunucu kartlarında geçiyor; iddia
    // stats bar'a ait olduğu için sorgu o kapsayıcıya daraltılır (:322-328).
    await waitFor(() => {
      expect(document.querySelector('.discover-stats-bar')).not.toBeNull();
    });
    const statsBar = within(document.querySelector('.discover-stats-bar') as HTMLElement);
    expect(statsBar.getByText(/çevrimiçi/)).toBeInTheDocument();
    expect(statsBar.getByText(/toplam üye/)).toBeInTheDocument();
  });

  test('Yeni tab\'ına geçince sunucular listeleniyor', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => screen.getByText('✨ Yeni'));
    fireEvent.click(screen.getByText('✨ Yeni'));
    await waitFor(() => {
      // Tüm sunucular hâlâ görünmeli
      expect(screen.getByText('Gaming Hub')).toBeInTheDocument();
    });
  });

  test('Sizin İçin tab\'ı: mid-size sunucuları filtreler', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => screen.getByText('💡 Sizin İçin'));
    fireEvent.click(screen.getByText('💡 Sizin İçin'));
    // Gaming Hub (5000 üye) foryou listesinden düşer (max 5000 exclusive)
    await waitFor(() => {
      // Kod Kampüsü (1200) ve Müzik Kulübü (850) görünmeli
      expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument();
    });
  });
});

describe('DiscoverPanel — kategori filtresi', () => {
  test('gaming kategorisi seçilince sadece gaming sunucuları görünür', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => screen.getByText('🎮 Oyun'));
    fireEvent.click(screen.getByText('🎮 Oyun'));
    await waitFor(() => {
      expect(screen.getByText('Gaming Hub')).toBeInTheDocument();
    });
    // tech sunucusu görünmemeli (kategori filtresi aktif)
    expect(screen.queryByText('Kod Kampüsü')).not.toBeInTheDocument();
  });

  test('Tümü kategorisi seçilince filtre kaldırılır', async () => {
    // Kategori filtresi AKTİF SEKMENİN listesi üzerinde çalışır (:118-120).
    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    await waitFor(() => screen.getByText('🌟 Tümü'));

    // Önce gaming seç
    fireEvent.click(screen.getByText('🎮 Oyun'));
    await waitFor(() => expect(screen.queryByText('Kod Kampüsü')).not.toBeInTheDocument());

    // Tümü'ne dön
    fireEvent.click(screen.getByText('🌟 Tümü'));
    await waitFor(() => {
      expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument();
    });
  });
});

describe('DiscoverPanel — arama', () => {
  test('arama query sunucuları filtreler', async () => {
    // Arama da aktif sekmenin listesi üzerinde çalışır (:121-128).
    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    await waitFor(() => screen.getByPlaceholderText('Topluluk ara...'));

    const input = screen.getByPlaceholderText('Topluluk ara...');
    fireEvent.input(input, { target: { value: 'müzik' } });

    await waitFor(() => {
      expect(screen.queryByText('Gaming Hub')).not.toBeInTheDocument();
      expect(screen.getByText('Müzik Kulübü')).toBeInTheDocument();
    }, { timeout: 500 }); // debounce 200ms
  });

  test('boş arama tüm sunucuları gösterir', async () => {
    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    await waitFor(() => screen.getByPlaceholderText('Topluluk ara...'));

    const input = screen.getByPlaceholderText('Topluluk ara...');
    fireEvent.input(input, { target: { value: 'oyun' } });
    await new Promise(r => setTimeout(r, 250));
    fireEvent.input(input, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByText('Gaming Hub')).toBeInTheDocument();
      expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument();
    }, { timeout: 500 });
  });
});

describe('DiscoverPanel — katıl aksiyonu', () => {
  test('Katıl butonuna basılınca apiFetch POST çağrılır', async () => {
    mockApiFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') return Promise.resolve(makeOkResponse({ ok: true }));
      if (url.includes('/discover/featured'))   return Promise.resolve(makeOkResponse(mockFeatured));
      if (url.includes('/discover/categories')) return Promise.resolve(makeOkResponse(mockCategories));
      return Promise.resolve(makeOkResponse(mockServers));
    });

    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => screen.getAllByText('Topluluğa Katıl'));

    const joinBtns = screen.getAllByText('Topluluğa Katıl');
    fireEvent.click(joinBtns[0]);

    await waitFor(() => {
      const postCalls = mockApiFetch.mock.calls.filter(c => c[1]?.method === 'POST');
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });

  test('Katıl başarılıysa toast çağrılır', async () => {
    mockApiFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') return Promise.resolve(makeOkResponse({ ok: true }));
      if (url.includes('/discover/featured'))   return Promise.resolve(makeOkResponse(mockFeatured));
      if (url.includes('/discover/categories')) return Promise.resolve(makeOkResponse(mockCategories));
      return Promise.resolve(makeOkResponse(mockServers));
    });

    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => screen.getAllByText('Topluluğa Katıl'));
    fireEvent.click(screen.getAllByText('Topluluğa Katıl')[0]);

    await waitFor(() => {
      expect(BridgeRegistry.call).toHaveBeenCalledWith('toast', expect.stringContaining('Topluluğa katıldın'), 'success');
    });
  });

  test('Katıl başarısızsa hata toast çağrılır', async () => {
    mockApiFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') return Promise.resolve({
        ok: false, json: () => Promise.resolve({ error: 'Zaten üyesin' })
      } as unknown as Response);
      if (url.includes('/discover/featured'))   return Promise.resolve(makeOkResponse(mockFeatured));
      if (url.includes('/discover/categories')) return Promise.resolve(makeOkResponse(mockCategories));
      return Promise.resolve(makeOkResponse(mockServers));
    });

    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => screen.getAllByText('Topluluğa Katıl'));
    fireEvent.click(screen.getAllByText('Topluluğa Katıl')[0]);

    // GUVENLIK SOZLESMESI (js/core/api-error.ts): sunucu govdesi ASLA
    // kullaniciya gosterilmez. Toast yalnizca sinirli urun metnidir; ham
    // sunucu metni ('Zaten uyesin') sizmaz.
    await waitFor(() => {
      expect(BridgeRegistry.call).toHaveBeenCalledWith('toast', expect.any(String), 'error');
    });
    const toastCalls = vi.mocked(BridgeRegistry.call).mock.calls.filter(call => call[0] === 'toast');
    expect(toastCalls.length).toBeGreaterThan(0);
    for (const call of toastCalls) expect(String(call[1])).not.toContain('Zaten üyesin');
  });
});

describe('DiscoverPanel — hata durumu', () => {
  test('API hatası error UI gösterir', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));
    render(DiscoverPanel);
    await openPanel();

    // Ag hatasi sinirli urun metnine eslenir; ham `Error.message` ekrana
    // BASILMAZ (api-error.ts guvenlik sozlesmesi).
    await waitFor(() => {
      expect(screen.getByText('Sunucuya bağlanılamıyor.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Network error')).toBeNull();
    expect(screen.getByText('Yeniden dene')).toBeInTheDocument();
  });

  test('Tekrar Dene butonuna basılınca init yeniden çağrılır', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));
    // İkinci çağrıda başarılı
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/discover/featured'))   return Promise.resolve(makeOkResponse(mockFeatured));
      if (url.includes('/discover/categories')) return Promise.resolve(makeOkResponse(mockCategories));
      return Promise.resolve(makeOkResponse(mockServers));
    });

    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => screen.getByText('Yeniden dene'));
    fireEvent.click(screen.getByText('Yeniden dene'));

    // Varsayılan 'featured' sekmesinde öne çıkan sunucu KASITLI olarak iki
    // yerde görünür: featured şeridi (:331-336) ve sekme grid'i (:94-95).
    // İddia "retry listeyi yeniden dolduruyor mu" olduğu için çoğul sorgu
    // semantik olarak doğrudur; benzersizlik ürün sözleşmesi değildir.
    await waitFor(() => {
      expect(screen.getAllByText('Gaming Hub').length).toBeGreaterThan(0);
    });
  });
});

// NOT: "ADR-0008 servis sınırı" testi HARNESS_ONLY olarak kaldırıldı —
// gövdesi yalnızca kendi ürettiği vi.fn()'in tanımlı olduğunu doğruluyordu.

describe('DiscoverPanel — pagination', () => {
  test('19+ sunucu varsa pagination görünür', async () => {
    const manyServers = Array.from({ length: 20 }, (_, i) => ({
      _id: `s${i}`,
      name: `Sunucu ${i}`,
      description: `Açıklama ${i}`,
      memberCount: 100 + i,
      onlineCount: 10,
      category: 'tech',
      tags: [],
    }));

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/discover/featured'))   return Promise.resolve(makeOkResponse([]));
      if (url.includes('/discover/categories')) return Promise.resolve(makeOkResponse([]));
      return Promise.resolve(makeOkResponse(manyServers));
    });

    // Sayfalama `filteredList` üzerinde çalışır (:133-134). Fixture'daki
    // sunucuların hiçbiri featured değil; bu yüzden sayfalanacak koleksiyonu
    // veren sekmeye geçilir. Fixture'ı yapay olarak featured yapmak, testin
    // ölçtüğü şeyi (genel liste sayfalaması) değiştirirdi.
    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    await waitFor(() => screen.getByText('Sunucu 0'));

    // 20 sunucu, PAGE_SIZE=18 → 2 sayfa
    await waitFor(() => {
      expect(screen.getByText('Sonraki ›')).toBeInTheDocument();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GERÇEK ZAMANLI SAYIMLAR — daha önce HİÇ yürütülmemiş yol
// ════════════════════════════════════════════════════════════════════════════
// `BridgeRegistry.get` mock'ta yoktu; `subscribeRealtimeCounts` daha ilk
// satırında TypeError fırlatıyor ve bu bir "unhandled rejection" olarak
// yutuluyordu. Aşağıdaki testler o yolu GERÇEKTEN çalıştırır.
//
// Her testin yakaladığı üretim arızası:
//   · abone olmama            → üye/online sayıları asla canlı güncellenmez
//   · memberCount yok sayılma → sunucu büyürken kart eski değerde donar
//   · online_update kısmiliği → grid güncellenirken öne çıkan kart donar
//   · unsubscribe yapılmama   → panel kapandıktan sonra dinleyici sızar
//   · soket yoksa çökme       → soket hazır olmadan açılan panel patlar

describe('DiscoverPanel — gerçek zamanlı sayımlar', () => {
  test('panel açılınca discover:subscribe gönderir ve iki olaya abone olur', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.discover-member-count')).not.toBeNull());

    expect(fakeSocket.emit).toHaveBeenCalledWith('discover:subscribe');
    expect(fakeSocket.handlers.has('discover:memberCount')).toBe(true);
    expect(fakeSocket.handlers.has('discover:online_update')).toBe(true);
  });

  test('discover:memberCount olayı öne çıkan kartın üye sayısını günceller', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.discover-member-count')).not.toBeNull());

    // Ön koşul: fixture değeri gösteriliyor (5000 → tr biçiminde).
    const once = document.querySelector('.discover-member-count');
    expect(once?.textContent).toContain((5000).toLocaleString('tr'));

    fakeSocket.handlers.get('discover:memberCount')!(
      { serverId: 's1', memberCount: 7777, onlineCount: 999 },
    );
    await tick();

    await waitFor(() => {
      const el = document.querySelector('.discover-member-count');
      expect(el?.textContent).toContain((7777).toLocaleString('tr'));
    });
    expect(document.querySelector('.discover-online-count')?.textContent).toContain('999');
  });

  test('discover:online_update öne çıkan kartı da günceller (grid ile tutarlı)', async () => {
    // REGRESYON: bu handler eskiden YALNIZCA `allServers`ı güncelliyordu.
    // Öne çıkan şerit kendi `featured` dizisinden render edildiği için
    // çevrimiçi sayısı orada ESKİ değerde donuyordu.
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.discover-member-count')).not.toBeNull());

    expect(document.querySelector('.discover-online-count')?.textContent).toContain('320');

    fakeSocket.handlers.get('discover:online_update')!({ serverId: 's1', count: 42 });
    await tick();

    await waitFor(() => {
      expect(document.querySelector('.discover-online-count')?.textContent).toContain('42');
    });
  });

  test('bilinmeyen serverId hiçbir kartı değiştirmez', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.discover-member-count')).not.toBeNull());

    fakeSocket.handlers.get('discover:memberCount')!(
      { serverId: 'yok-boyle-sunucu', memberCount: 1, onlineCount: 1 },
    );
    await tick();

    expect(document.querySelector('.discover-member-count')?.textContent)
      .toContain((5000).toLocaleString('tr'));
  });

  test('unmount aboneliği bırakır (dinleyici sızıntısı yok)', async () => {
    const { unmount } = render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.discover-member-count')).not.toBeNull());

    fakeSocket.emit.mockClear();
    unmount();

    expect(fakeSocket.emit).toHaveBeenCalledWith('discover:unsubscribe');
    expect(fakeSocket.off).toHaveBeenCalledWith('discover:memberCount', expect.any(Function));
    expect(fakeSocket.off).toHaveBeenCalledWith('discover:online_update', expect.any(Function));
  });

  test('tekrar tekrar açmak çift abonelik üretmez', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.discover-member-count')).not.toBeNull());
    await openPanel();
    await openPanel();

    const subscribeCalls = fakeSocket.emit.mock.calls
      .filter(c => c[0] === 'discover:subscribe');
    expect(subscribeCalls).toHaveLength(1);
  });

  test('soket kayıtlı değilken panel yine açılır ve çökmez', async () => {
    // `BridgeRegistry.get` null döndürür — soket henüz hazır değil.
    vi.mocked(BridgeRegistry.get).mockReturnValue(null as never);

    render(DiscoverPanel);
    await openPanel();

    await waitFor(() => expect(document.querySelector('.discover-member-count')).not.toBeNull());
    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function registered(name: string): () => void {
  const call = vi.mocked(BridgeRegistry.register).mock.calls.find(c => c[0] === name);
  if (!call) throw new Error(`${name} registry kaydi YOK`);
  return call[1] as () => void;
}

describe('DiscoverPanel — production boundary hardening', () => {
  test('malformed and duplicate discovery records are rejected while valid fields are bounded', async () => {
    const oversizedTags = Array.from({ length: 15 }, (_, i) => `tag-${i}`);
    const valid = {
      _id: '  safe/id  ',
      name: '  Safe Server  ',
      description: 'A'.repeat(1100),
      memberCount: 2_000_000_000,
      onlineCount: -1,
      boostLevel: 500,
      category: 'not-a-category',
      tags: [...oversizedTags, 'tag-0', 17, '   '],
      verified: 'yes',
      featured: true,
      createdAt: Number.NaN,
    };
    const minimal = { _id: 'minimal', name: 'Minimal Server' };
    const malformed = [
      null,
      'not-an-object',
      [],
      { _id: 'missing-name' },
      { _id: 'blank-name', name: '   ' },
      valid,
      { ...valid, name: 'Duplicate must lose' },
      minimal,
    ];

    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? [valid] : malformed,
    )));

    render(DiscoverPanel);
    await openPanel();
    await showAllServers();

    await waitFor(() => expect(screen.getByText('Safe Server')).toBeInTheDocument());
    expect(screen.queryByText('Duplicate must lose')).not.toBeInTheDocument();
    expect(screen.getByText('Minimal Server')).toBeInTheDocument();
    expect(document.querySelector('.discover-card-counts')?.textContent)
      .toContain((1_000_000_000).toLocaleString());
    expect(document.querySelectorAll('.discover-tag')).toHaveLength(3);
    expect(document.querySelector('.badge-verified')).toBeNull();
    expect(document.querySelector('.badge-boost')?.textContent).toContain('L100');

    const input = screen.getByPlaceholderText('Topluluk ara...');
    await fireEvent.input(input, { target: { value: 'tag-11' } });
    await waitFor(() => expect(screen.getByText('Safe Server')).toBeInTheDocument(), { timeout: 500 });
    await fireEvent.input(input, { target: { value: 'tag-12' } });
    await waitFor(() => expect(screen.queryByText('Safe Server')).not.toBeInTheDocument(), { timeout: 500 });
  });

  test('non-array API bodies become a safe empty result', async () => {
    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? null : { servers: 'wrong shape' },
    )));

    render(DiscoverPanel);
    await openPanel();

    await waitFor(() => expect(screen.getByText('Topluluk bulunamadı')).toBeInTheDocument());
    expect(document.querySelectorAll('.discover-card')).toHaveLength(0);
  });

  test('primary HTTP failure is visible while featured failure remains non-fatal', async () => {
    mockApiFetch.mockImplementation((url: string) => Promise.resolve({
      ok: url.includes('/discover/featured'),
      json: async () => [],
    } as unknown as Response));

    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(screen.getByText(/Sunucular yüklenemedi/)).toBeInTheDocument());

    cleanup();
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.mocked(BridgeRegistry.get).mockReturnValue(fakeSocket as never);
    mockApiFetch.mockImplementation((url: string) => Promise.resolve({
      ok: !url.includes('/discover/featured'),
      json: async () => mockServers,
    } as unknown as Response));

    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    await waitFor(() => expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument());
    expect(document.querySelector('.discover-error')).toBeNull();
  });

  test('non-Error request rejection uses a stable user-facing fallback', async () => {
    mockApiFetch.mockRejectedValue('offline');
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(screen.getByText(/Sunucular yüklenemedi/)).toBeInTheDocument());
  });

  test('close and reopen ignores the older response even when it resolves last', async () => {
    const firstAll = deferred<Response>();
    const firstFeatured = deferred<Response>();
    const secondAll = deferred<Response>();
    const secondFeatured = deferred<Response>();
    const allQueue = [firstAll, secondAll];
    const featuredQueue = [firstFeatured, secondFeatured];
    mockApiFetch.mockImplementation((url: string) => {
      const queue = url.includes('/discover/featured') ? featuredQueue : allQueue;
      return queue.shift()!.promise;
    });

    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    registered('hideDiscoverPanel')();
    await tick();
    await openPanel();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(4));

    secondAll.resolve(makeOkResponse([{ _id: 'fresh', name: 'Fresh result', featured: true }]));
    secondFeatured.resolve(makeOkResponse([]));
    await waitFor(() => expect(screen.getByText('Fresh result')).toBeInTheDocument());

    firstAll.resolve(makeOkResponse([{ _id: 'stale', name: 'Stale result', featured: true }]));
    firstFeatured.resolve(makeOkResponse([]));
    await tick();
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument();
    expect(screen.getByText('Fresh result')).toBeInTheDocument();
  });

  test('closing cancels a pending debounced filter before the next open', async () => {
    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    const input = await screen.findByPlaceholderText('Topluluk ara...');
    await fireEvent.input(input, { target: { value: 'will-not-match' } });
    registered('hideDiscoverPanel')();
    await tick();
    await openPanel();
    await new Promise(resolve => setTimeout(resolve, 250));

    await showAllServers();
    await waitFor(() => expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument());
  });

  test('a rejection from a request invalidated by close cannot publish an error', async () => {
    const staleAll = deferred<Response>();
    const staleFeatured = deferred<Response>();
    mockApiFetch.mockImplementation((url: string) =>
      url.includes('/discover/featured') ? staleFeatured.promise : staleAll.promise,
    );

    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    registered('hideDiscoverPanel')();
    staleAll.reject(new Error('stale failure'));
    staleFeatured.resolve(makeOkResponse([]));
    await tick();

    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? [] : mockServers,
    )));
    await openPanel();
    await showAllServers();
    await waitFor(() => expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument());
    expect(screen.queryByText('stale failure')).not.toBeInTheDocument();
  });
});

describe('DiscoverPanel — deep interaction contracts', () => {
  test('assets render, preview opens by click/Enter, and unrelated keys do nothing', async () => {
    const server = {
      _id: 'asset-server',
      name: 'Asset Server',
      description: 'Visible description',
      bannerUrl: '/media/banner.png',
      iconUrl: '/media/icon.png',
      memberCount: 10,
      onlineCount: 2,
      tags: ['art'],
      category: 'art',
      featured: true,
      createdAt: Date.now() - 60 * 86400000,
    };
    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? [server] : [server],
    )));

    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.featured-banner:not(.featured-banner--placeholder)')).not.toBeNull());
    expect(document.querySelector('.featured-icon[src]')).not.toBeNull();
    expect(document.querySelector('.discover-card-banner')).not.toBeNull();
    expect(document.querySelector('.discover-card-icon[src]')).not.toBeNull();

    const card = document.querySelector('.discover-card') as HTMLElement;
    await fireEvent.keyDown(card, { key: 'Space' });
    expect(BridgeRegistry.call).not.toHaveBeenCalledWith('openServerPreview', expect.anything());
    await fireEvent.click(card);
    await fireEvent.keyDown(card, { key: 'Enter' });
    expect(BridgeRegistry.call).toHaveBeenCalledTimes(2);
    expect(BridgeRegistry.call).toHaveBeenNthCalledWith(1, 'openServerPreview', 'asset-server');
    expect(BridgeRegistry.call).toHaveBeenNthCalledWith(2, 'openServerPreview', 'asset-server');
  });

  test('description, tag, and tag-backed category filters each match safely', async () => {
    const sparse = { _id: 'sparse', name: 'Sparse' };
    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    await waitFor(() => expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Topluluk ara...');
    await fireEvent.input(input, { target: { value: 'yazılım' } });
    await waitFor(() => expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument(), { timeout: 500 });
    await fireEvent.input(input, { target: { value: 'python' } });
    await waitFor(() => expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument(), { timeout: 500 });

    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? [] : [sparse, { _id: 'tagged', name: 'Tagged', tags: ['social'] }],
    )));
    registered('hideDiscoverPanel')();
    await tick();
    await openPanel();
    await showAllServers();
    await fireEvent.click(screen.getByText('💬 Sosyal'));
    await waitFor(() => expect(screen.getByText('Tagged')).toBeInTheDocument());
    expect(screen.queryByText('Sparse')).not.toBeInTheDocument();
  });

  test('empty result can clear query and category filters', async () => {
    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    await fireEvent.click(await screen.findByText('🔬 Bilim'));
    await waitFor(() => expect(screen.getByText('Topluluk bulunamadı')).toBeInTheDocument());
    await fireEvent.click(screen.getByText('Filtreleri Temizle'));
    await waitFor(() => expect(screen.getByText('Kod Kampüsü')).toBeInTheDocument());
  });

  test('pagination supports next, numbered, and previous navigation', async () => {
    const servers = Array.from({ length: 40 }, (_, i) => ({
      _id: `page-${i}`,
      name: `Page Server ${i}`,
      memberCount: i,
      createdAt: i,
    }));
    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? [] : servers,
    )));

    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    await waitFor(() => expect(screen.getByText('Page Server 39')).toBeInTheDocument());
    const pagination = () => within(document.querySelector('.discover-pagination') as HTMLElement);

    await fireEvent.click(pagination().getByText('Sonraki ›'));
    await waitFor(() => expect(screen.getByText('Page Server 21')).toBeInTheDocument());
    expect(pagination().getByText('‹ Önceki')).toBeInTheDocument();

    await fireEvent.click(pagination().getByText('3'));
    await waitFor(() => expect(screen.getByText('Page Server 3')).toBeInTheDocument());
    expect(pagination().queryByText('Sonraki ›')).not.toBeInTheDocument();

    await fireEvent.click(pagination().getByText('‹ Önceki'));
    await waitFor(() => expect(screen.getByText('Page Server 21')).toBeInTheDocument());
  });

  test('Escape closes the visible dialog while other keys and hidden ready events are inert', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.discover-root')).not.toBeNull());
    const initialSubscriptions = fakeSocket.emit.mock.calls.filter(c => c[0] === 'discover:subscribe').length;

    await fireEvent.keyDown(window, { key: 'Shift' });
    expect(document.querySelector('.discover-root')).not.toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.discover-root')).toBeNull();

    document.dispatchEvent(new Event('bridge:socket-ready'));
    await tick();
    expect(fakeSocket.emit.mock.calls.filter(c => c[0] === 'discover:subscribe')).toHaveLength(initialSubscriptions);
  });

  test('trending totals and recommendations tolerate records with absent counts', async () => {
    const servers = [
      { _id: 'no-counts', name: 'No Counts' },
      { _id: 'mid-counts', name: 'Mid Counts', memberCount: 120, onlineCount: 7 },
    ];
    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? [] : servers,
    )));

    render(DiscoverPanel);
    await openPanel();
    await fireEvent.click(await screen.findByText('📈 Trend'));
    const stats = within(document.querySelector('.discover-stats-bar') as HTMLElement);
    expect(stats.getByText('7')).toBeInTheDocument();
    expect(stats.getByText('120')).toBeInTheDocument();

    await fireEvent.click(screen.getByText('💡 Sizin İçin'));
    await waitFor(() => expect(screen.getByText('Mid Counts')).toBeInTheDocument());
    expect(screen.queryByText('No Counts')).not.toBeInTheDocument();
  });

  test('featured join button stops card actions and successful join reloads server membership', async () => {
    render(DiscoverPanel);
    await openPanel();
    const button = await screen.findByText('Katıl');
    await fireEvent.click(button);
    await waitFor(() => expect(BridgeRegistry.call).toHaveBeenCalledWith('loadServers'));
    expect(BridgeRegistry.call).not.toHaveBeenCalledWith('openServerPreview', expect.anything());
  });

  test('join is URL-safe, locked while pending, and cannot double-submit', async () => {
    const post = deferred<Response>();
    const server = { _id: 'server/with space', name: 'Join Once', featured: true };
    mockApiFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return post.promise;
      return Promise.resolve(makeOkResponse(url.includes('/discover/featured') ? [server] : [server]));
    });

    render(DiscoverPanel);
    await openPanel();
    const featuredButton = await screen.findByText('Katıl') as HTMLButtonElement;
    const gridButton = screen.getByText('Topluluğa Katıl') as HTMLButtonElement;
    featuredButton.click();
    gridButton.click();
    await tick();

    const posts = mockApiFetch.mock.calls.filter(c => c[1]?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toContain('/servers/server%2Fwith%20space/join');
    expect(featuredButton.disabled).toBe(true);
    expect(gridButton.disabled).toBe(true);

    post.resolve(makeOkResponse({ ok: true }));
    await waitFor(() => expect(featuredButton.disabled).toBe(false));
  });

  test('invalid error JSON and network failures produce contained join errors', async () => {
    let postAttempt = 0;
    mockApiFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        postAttempt += 1;
        if (postAttempt === 1) {
          return Promise.resolve({ ok: false, json: async () => { throw new Error('bad json'); } } as unknown as Response);
        }
        if (postAttempt === 2) return Promise.reject(new Error('Network unavailable'));
        return Promise.reject('offline');
      }
      return Promise.resolve(makeOkResponse(url.includes('/discover/featured') ? [] : mockServers));
    });

    render(DiscoverPanel);
    await openPanel();
    await showAllServers();
    const join = await screen.findAllByText('Topluluğa Katıl');

    // Her uc bicim de (ayristirilamayan hata govdesi, jenerik `Error`, hata
    // olmayan bir reject degeri) AYNI sinirli urun metnine eslenir. `Error`
    // adi/mesaji ag hatasi imzasi tasimadigi icin `error_network` degil,
    // cagiranin fallback metni kullanilir (api-error.ts: classify()).
    await fireEvent.click(join[0]);
    await waitFor(() => expect(BridgeRegistry.call).toHaveBeenCalledWith('toast', expect.stringMatching(/Topluluğa katılınamadı/), 'error'));
    await fireEvent.click(join[0]);
    await waitFor(() => expect(BridgeRegistry.call).toHaveBeenCalledTimes(2));
    await fireEvent.click(join[0]);
    await waitFor(() => expect(BridgeRegistry.call).toHaveBeenCalledTimes(3));
    expect(BridgeRegistry.call).toHaveBeenLastCalledWith('toast', expect.stringMatching(/Topluluğa katılınamadı/), 'error');
    // Ham teknik metin ('Network unavailable', 'bad json', 'offline') kullaniciya SIZMAZ.
    for (const call of vi.mocked(BridgeRegistry.call).mock.calls) {
      const text = String(call[1] ?? '');
      expect(text).not.toContain('Network unavailable');
      expect(text).not.toContain('bad json');
      expect(text).not.toContain('offline');
    }
  });
});

describe('DiscoverPanel — bounded collections and realtime validation', () => {
  test('all-server and featured collections are bounded before rendering', async () => {
    const all = Array.from({ length: 1001 }, (_, i) => ({ _id: `all-${i}`, name: `All ${i}` }));
    const featured = Array.from({ length: 101 }, (_, i) => ({ _id: `featured-${i}`, name: `Featured ${i}` }));
    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? featured : all,
    )));

    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelectorAll('.featured-card')).toHaveLength(100));
    expect(document.querySelector('.discover-hero-sub')?.textContent).toContain((1000).toLocaleString());
    expect(screen.queryByText('Featured 100')).not.toBeInTheDocument();
  });

  test('malformed realtime payloads are ignored and valid counts are clamped', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(document.querySelector('.discover-member-count')).not.toBeNull());
    const before = document.querySelector('.discover-member-count')?.textContent;

    const member = fakeSocket.handlers.get('discover:memberCount')!;
    member(null);
    member([]);
    member({});
    member({ serverId: 's1', memberCount: -1, onlineCount: 1 });
    member({ serverId: 's1', memberCount: 1, onlineCount: Number.NaN });
    member({ serverId: 'unknown', memberCount: 2, onlineCount: 1 });
    await tick();
    expect(document.querySelector('.discover-member-count')?.textContent).toBe(before);

    member({ serverId: 's1', memberCount: 2_000_000_000, onlineCount: 2_000_000_000 });
    await tick();
    expect(document.querySelector('.discover-member-count')?.textContent)
      .toContain((1_000_000_000).toLocaleString('tr'));

    const online = fakeSocket.handlers.get('discover:online_update')!;
    online(null);
    online([]);
    online({});
    online({ serverId: 's1', count: -1 });
    online({ serverId: 'unknown', count: 5 });
    online({ serverId: 's1', count: 2_000_000_000 });
    await tick();
    expect(document.querySelector('.discover-online-count')?.textContent)
      .toContain('1000000000');
  });

  test('a visible panel cleanly detaches when the current socket disappears', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(fakeSocket.handlers.has('discover:memberCount')).toBe(true));
    fakeSocket.emit.mockClear();
    vi.mocked(BridgeRegistry.get).mockReturnValue(null as never);

    document.dispatchEvent(new Event('bridge:socket-reconnected'));
    await tick();

    expect(fakeSocket.handlers.size).toBe(0);
    expect(fakeSocket.emit).toHaveBeenCalledWith('discover:unsubscribe');
  });

  test('realtime counts recompute trending order instead of leaving stale scores', async () => {
    const servers = [
      { _id: 'large-idle', name: 'Large Idle', memberCount: 1000, onlineCount: 1 },
      { _id: 'small-active', name: 'Small Active', memberCount: 100, onlineCount: 100 },
    ];
    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? [] : servers,
    )));

    render(DiscoverPanel);
    await openPanel();
    await fireEvent.click(await screen.findByText('📈 Trend'));
    await waitFor(() => {
      expect(document.querySelector('.discover-card-name')?.textContent).toBe('Small Active');
    });

    fakeSocket.handlers.get('discover:online_update')!({ serverId: 'large-idle', count: 1000 });
    await waitFor(() => {
      expect(document.querySelector('.discover-card-name')?.textContent).toBe('Large Idle');
    });
  });

  test('realtime recommendation shrink clamps an out-of-range page', async () => {
    const servers = Array.from({ length: 20 }, (_, i) => ({
      _id: `recommended-${i}`,
      name: `Recommended ${i}`,
      memberCount: 100 + i,
      onlineCount: 10,
    }));
    mockApiFetch.mockImplementation((url: string) => Promise.resolve(makeOkResponse(
      url.includes('/discover/featured') ? [] : servers,
    )));

    render(DiscoverPanel);
    await openPanel();
    await fireEvent.click(await screen.findByText('💡 Sizin İçin'));
    await fireEvent.click(await screen.findByText('Sonraki ›'));
    expect(screen.getByText('‹ Önceki')).toBeInTheDocument();

    const member = fakeSocket.handlers.get('discover:memberCount')!;
    member({ serverId: 'recommended-0', memberCount: 5000, onlineCount: 10 });
    member({ serverId: 'recommended-1', memberCount: 5000, onlineCount: 10 });
    member({ serverId: 'recommended-2', memberCount: 5000, onlineCount: 10 });
    await waitFor(() => expect(screen.queryByText('‹ Önceki')).not.toBeInTheDocument());
    expect(document.querySelectorAll('.discover-card')).toHaveLength(17);
  });
});

// Final21 UX: varsayılan "Öne Çıkan" sekmesi, kimsenin öne çıkarmadığı bir örnekte (kendi
// barındırılan kurulumların neredeyse tamamı) "Topluluk bulunamadı" diyordu; hemen üstteki
// başlık "10 topluluk seni bekliyor". "Sizin İçin" küçük örneklerde HEP boştu.
describe('DiscoverPanel — içeriği olmayan sekme gösterilmez', () => {
  const small = mockServers.map((s) => ({ ...s, featured: false, memberCount: 12, onlineCount: 0 }));
  beforeEach(() => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/discover/featured'))   return Promise.resolve(makeOkResponse([]));
      if (url.includes('/discover/categories')) return Promise.resolve(makeOkResponse(mockCategories));
      if (url.includes('/discover'))             return Promise.resolve(makeOkResponse(small));
      return Promise.resolve(makeOkResponse({}));
    });
  });

  test('öne çıkan yoksa sekme gizlenir ve içeriği olan ilk sekme (Trend) açılır', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(screen.getByText('Gaming Hub')).toBeInTheDocument());
    expect(screen.queryByText('⭐ Öne Çıkan')).not.toBeInTheDocument();
    expect(screen.queryByText('💡 Sizin İçin')).not.toBeInTheDocument();
    expect(screen.getByText('📈 Trend').closest('button')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/bulunamadı/)).not.toBeInTheDocument();
  });

  test('kullanıcının seçtiği sekme korunur', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => screen.getByText('✨ Yeni'));
    await fireEvent.click(screen.getByText('✨ Yeni'));
    await tick();
    expect(screen.getByText('✨ Yeni').closest('button')).toHaveAttribute('aria-pressed', 'true');
  });

  test('çevrimiçi sayısı tek noktalı; sıfırken yeşil değil', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(screen.getByText('Gaming Hub')).toBeInTheDocument());
    const counts = [...document.querySelectorAll('.online-count')];
    expect(counts.length).toBeGreaterThan(0);
    for (const c of counts) {
      expect(c.textContent).not.toMatch(/●\s*●/);
      expect(c.classList.contains('none')).toBe(true);
    }
  });
});

describe('DiscoverPanel — öne çıkan varsa varsayılan korunur', () => {
  test('öne çıkan sunucu olan örnekte varsayılan sekme "Öne Çıkan"', async () => {
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(screen.getByText('⭐ Öne Çıkan').closest('button')).toHaveAttribute('aria-pressed', 'true'));
  });
});

describe('DiscoverPanel — başlıktaki sayı gösterilenle tutarlı', () => {
  test('öne çıkan olmayan örnekte "N topluluk seni bekliyor" ve varsayılan sekme N kart gösterir', async () => {
    const small = mockServers.map((s) => ({ ...s, featured: false, memberCount: 12, onlineCount: 0 }));
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/discover/featured'))   return Promise.resolve(makeOkResponse([]));
      if (url.includes('/discover/categories')) return Promise.resolve(makeOkResponse(mockCategories));
      if (url.includes('/discover'))             return Promise.resolve(makeOkResponse(small));
      return Promise.resolve(makeOkResponse({}));
    });
    render(DiscoverPanel);
    await openPanel();
    await waitFor(() => expect(screen.getByText('Gaming Hub')).toBeInTheDocument());
    const hero = document.querySelector('.discover-hero-sub')!.textContent ?? '';
    const n = Number((hero.match(/\d+/) ?? ['-1'])[0]);
    expect(n).toBe(small.length);
    expect(document.querySelectorAll('.discover-card')).toHaveLength(n);
    expect(screen.queryByText(/bulunamadı/)).not.toBeInTheDocument();
  });
});
