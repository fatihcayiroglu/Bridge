// client/tests/device-policy-delivery-saved-searches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// CİHAZ BİLDİRİM POLİTİKASI · TESLİM HATASI METNİ · KAYITLI ARAMALAR
// ════════════════════════════════════════════════════════════════════════════
//
// Üç küçük saf modül; üçü de bir GÜVEN SINIRINDA duruyor:
//
//   · cihaz politikası → `localStorage` ve Service Worker'dan gelen değerler
//     tamamen kullanıcı/çalışma zamanı kontrolündedir. Bozuk bir kayıt sessiz
//     hatalı davranışa (ör. "24 saat sessiz") dönüşmemelidir.
//   · teslim hatası metni → soket yükü SUNUCUDAN gelir. Üretim yalnız bilinen
//     ürün metnini gösterir; bilinmeyen kod güvenli yedeğe düşer.
//   · kayıtlı aramalar → depodaki değer bozulabilir; liste sınırsız
//     büyümemeli, aynı sorgu iki kez durmamalıdır.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_DEVICE_POLICY,
  isQuietHoursActive,
  loadNotificationDevicePolicy,
  normalizeNotificationDevicePolicy,
  saveNotificationDevicePolicy,
  syncNotificationDevicePolicy,
  type NotificationDevicePolicy,
} from '../js/core/notifications/notification-device-policy.ts';
import { connectionLostDeliveryError, messageDeliveryError } from '../js/core/message-delivery-error.ts';
import {
  MAX_SAVED_SEARCHES,
  addSaved,
  loadSaved,
  normalizeSaved,
  removeSaved,
  saveSaved,
} from '../js/core/search/saved-searches.ts';
import { t } from '../js/core/i18n/index.ts';

const STORAGE_KEY = 'bridge_notification_device_policy_v1';

function policy(over: Partial<NotificationDevicePolicy> = {}): NotificationDevicePolicy {
  return { ...DEFAULT_NOTIFICATION_DEVICE_POLICY, ...over };
}

function at(hour: number, minute = 0): Date {
  const date = new Date(2026, 8, 9, hour, minute, 0, 0);
  return date;
}

function installServiceWorker(over: Record<string, unknown> = {}): { posts: unknown[] } {
  const posts: unknown[] = [];
  const worker = { postMessage: (message: unknown) => { posts.push(message); } };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ active: worker, waiting: null }), controller: null, ...over },
  });
  return { posts };
}

function removeServiceWorker(): void {
  Reflect.deleteProperty(navigator, 'serviceWorker');
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  removeServiceWorker();
  // Once kuresel taklitler geri alinir: `localStorage` taklidi kaldirilmadan
  // temizlik cagrisi kancanin kendisini dusururdu.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('cihaz bildirim politikası normalizasyonu', () => {
  it('nesne olmayan her girdi belgelenmiş varsayılana düşer', () => {
    for (const value of [null, undefined, 'dnd', 42, true, Symbol('x')]) {
      expect(normalizeNotificationDevicePolicy(value)).toEqual(DEFAULT_NOTIFICATION_DEVICE_POLICY);
    }
    // Dizi bir nesnedir; alanları olmadigi icin yine varsayilana duser.
    expect(normalizeNotificationDevicePolicy([])).toEqual(DEFAULT_NOTIFICATION_DEVICE_POLICY);
  });

  it('bayraklar yalnız gerçek `true` ile açılır; "truthy" değerler açmaz', () => {
    const result = normalizeNotificationDevicePolicy({ dnd: 'evet', quietEnabled: 1 });
    expect(result.dnd).toBe(false);
    expect(result.quietEnabled).toBe(false);
    expect(normalizeNotificationDevicePolicy({ dnd: true, quietEnabled: true }))
      .toEqual({ dnd: true, quietEnabled: true, quietStart: '22:00', quietEnd: '08:00' });
  });

  it('geçersiz saat biçimleri sessizce varsayılana döner, geçerli sınırlar korunur', () => {
    for (const bad of ['24:00', '9:00', '22:60', '', '2200', 900, null, '23:5', '-1:00']) {
      const result = normalizeNotificationDevicePolicy({ quietStart: bad, quietEnd: bad });
      expect(result.quietStart).toBe('22:00');
      expect(result.quietEnd).toBe('08:00');
    }
    expect(normalizeNotificationDevicePolicy({ quietStart: '00:00', quietEnd: '23:59' }))
      .toMatchObject({ quietStart: '00:00', quietEnd: '23:59' });
  });

  it('varsayılan nesne kopyalanır; çağıran onu değiştirerek modülü bozamaz', () => {
    const first = normalizeNotificationDevicePolicy(null);
    first.dnd = true;
    expect(DEFAULT_NOTIFICATION_DEVICE_POLICY.dnd).toBe(false);
    expect(normalizeNotificationDevicePolicy(null).dnd).toBe(false);
  });
});

describe('cihaz politikası kalıcılığı', () => {
  it('kayıt yokken, bozuk JSON\'da ve depo erişilemezken varsayılana düşer', () => {
    expect(loadNotificationDevicePolicy()).toEqual(DEFAULT_NOTIFICATION_DEVICE_POLICY);

    localStorage.setItem(STORAGE_KEY, '{bozuk');
    expect(loadNotificationDevicePolicy()).toEqual(DEFAULT_NOTIFICATION_DEVICE_POLICY);

    localStorage.setItem(STORAGE_KEY, 'null');
    expect(loadNotificationDevicePolicy()).toEqual(DEFAULT_NOTIFICATION_DEVICE_POLICY);

    vi.stubGlobal('localStorage', undefined);
    expect(loadNotificationDevicePolicy()).toEqual(DEFAULT_NOTIFICATION_DEVICE_POLICY);
  });

  it('kaydedilen politika okunurken yeniden normalize edilir', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ dnd: true, quietEnabled: true, quietStart: '99:99', quietEnd: '07:30' }));

    expect(loadNotificationDevicePolicy()).toEqual({
      dnd: true, quietEnabled: true, quietStart: '22:00', quietEnd: '07:30',
    });
  });

  it('kaydetme normalize eder ve Service Worker\'a aynı politikayı bildirir', async () => {
    const { posts } = installServiceWorker();

    await saveNotificationDevicePolicy(policy({ dnd: true, quietStart: 'bozuk' }));

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      dnd: true, quietEnabled: false, quietStart: '22:00', quietEnd: '08:00',
    });
    expect(posts).toEqual([{
      type: 'SET_NOTIFICATION_POLICY',
      notificationPolicy: { dnd: true, quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' },
    }]);
  });

  it('denetleyici varsa ona, yoksa aktif/bekleyen worker\'a gönderilir', async () => {
    const controllerPosts: unknown[] = [];
    const activePosts: unknown[] = [];
    installServiceWorker({
      controller: { postMessage: (m: unknown) => controllerPosts.push(m) },
      ready: Promise.resolve({ active: { postMessage: (m: unknown) => activePosts.push(m) }, waiting: null }),
    });
    await saveNotificationDevicePolicy(policy());
    expect(controllerPosts).toHaveLength(1);
    expect(activePosts).toHaveLength(0);

    const waitingPosts: unknown[] = [];
    installServiceWorker({
      controller: null,
      ready: Promise.resolve({ active: null, waiting: { postMessage: (m: unknown) => waitingPosts.push(m) } }),
    });
    await saveNotificationDevicePolicy(policy());
    expect(waitingPosts).toHaveLength(1);
  });

  it('Service Worker yoksa, hazır değilse veya hiç worker yoksa kayıt yine de tamamlanır', async () => {
    removeServiceWorker();
    await expect(saveNotificationDevicePolicy(policy({ dnd: true }))).resolves.toBeUndefined();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).dnd).toBe(true);

    installServiceWorker({ ready: Promise.reject(new Error('sw kaydı yok')) });
    await expect(saveNotificationDevicePolicy(policy())).resolves.toBeUndefined();

    installServiceWorker({ controller: null, ready: Promise.resolve({ active: null, waiting: null }) });
    await expect(saveNotificationDevicePolicy(policy())).resolves.toBeUndefined();
  });

  it('depo yazılamıyorsa kayıt sessizce sürer ve Service Worker yine bilgilendirilir', async () => {
    const { posts } = installServiceWorker();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('kota doldu'); });

    await expect(saveNotificationDevicePolicy(policy({ dnd: true }))).resolves.toBeUndefined();
    expect(posts).toHaveLength(1);
  });

  it('senkronizasyon kayıtlı politikayı okur, Service Worker\'a yollar ve geri döndürür', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ quietEnabled: true, quietStart: '01:00', quietEnd: '02:00' }));
    const { posts } = installServiceWorker();

    const result = await syncNotificationDevicePolicy();

    expect(result).toEqual({ dnd: false, quietEnabled: true, quietStart: '01:00', quietEnd: '02:00' });
    expect(posts).toEqual([{ type: 'SET_NOTIFICATION_POLICY', notificationPolicy: result }]);
  });
});

describe('sessiz saat penceresi', () => {
  it('kapalıyken hiçbir saat sessiz değildir', () => {
    expect(isQuietHoursActive(policy({ quietEnabled: false, quietStart: '00:00', quietEnd: '23:59' }), at(3))).toBe(false);
  });

  it('aynı başlangıç ve bitiş 24 saatlik pencere demektir', () => {
    const all = policy({ quietEnabled: true, quietStart: '09:00', quietEnd: '09:00' });
    expect(isQuietHoursActive(all, at(9))).toBe(true);
    expect(isQuietHoursActive(all, at(20, 30))).toBe(true);
  });

  it('gün içi pencere başlangıcı kapsar, bitişi kapsamaz', () => {
    const daytime = policy({ quietEnabled: true, quietStart: '09:00', quietEnd: '17:00' });
    expect(isQuietHoursActive(daytime, at(8, 59))).toBe(false);
    expect(isQuietHoursActive(daytime, at(9))).toBe(true);
    expect(isQuietHoursActive(daytime, at(16, 59))).toBe(true);
    expect(isQuietHoursActive(daytime, at(17))).toBe(false);
  });

  it('gece yarısını aşan pencere iki günün uçlarını da kapsar', () => {
    const overnight = policy({ quietEnabled: true, quietStart: '22:00', quietEnd: '08:00' });
    expect(isQuietHoursActive(overnight, at(21, 59))).toBe(false);
    expect(isQuietHoursActive(overnight, at(22))).toBe(true);
    expect(isQuietHoursActive(overnight, at(3, 30))).toBe(true);
    expect(isQuietHoursActive(overnight, at(7, 59))).toBe(true);
    expect(isQuietHoursActive(overnight, at(8))).toBe(false);
  });
});

describe('teslim hatası ürün metni', () => {
  it('bilinen her kod sabit ürün metnine eşlenir', () => {
    const cases: Array<[string, string]> = [
      ['EMPTY_MESSAGE', t('delivery_empty', 'Boş mesaj gönderilemez.')],
      ['MESSAGE_TOO_LONG', t('delivery_too_long', 'Mesaj çok uzun. Kısaltıp yeniden deneyin.')],
      ['USER_NOT_FOUND', t('delivery_user_unavailable', 'Bu kullanıcı artık kullanılamıyor.')],
      ['INVALID_FILE_REFERENCE', t('delivery_file_unavailable', 'Dosya artık kullanılamıyor. Eki yeniden seçip gönderin.')],
      ['CHANNEL_NOT_FOUND', t('delivery_channel_unavailable', 'Bu kanal artık kullanılamıyor.')],
      ['DM_POLICY_DENIED', t('delivery_dm_blocked', 'Bu kullanıcıyla şu anda mesajlaşamazsınız.')],
      ['NOT_A_MEMBER', t('delivery_group_forbidden', 'Bu grup konuşmasına artık erişiminiz yok.')],
      ['RATE_LIMITED', t('delivery_rate_limit', 'Çok hızlı mesaj gönderiyorsunuz. Biraz sonra yeniden deneyin.')],
      ['NONCE_CONFLICT', t('delivery_idempotency_failed', 'Bu gönderim güvenli biçimde yeniden kullanılamadı. Mesajı yeniden gönderin.')],
      ['INVALID_PAYLOAD', t('delivery_invalid_request', 'Mesaj gönderme isteği geçersizdi. Yeniden deneyin.')],
    ];
    for (const [code, expected] of cases) {
      expect(messageDeliveryError(code, 'dm')).toBe(expected);
      // Metin YUZEYDEN bagimsizdir; yalnizca yetki/genel yedek dallanir.
      expect(messageDeliveryError(code, 'channel')).toBe(expected);
      expect(messageDeliveryError(code, 'gdm')).toBe(expected);
    }
  });

  it('yetki reddi kanal ile özel/grup arasında farklı metin verir', () => {
    for (const code of ['MISSING_PERMISSION', 'PERMISSION_DENIED']) {
      expect(messageDeliveryError(code, 'channel')).toBe(t('delivery_channel_permission', 'Bu kanala mesaj gönderme yetkiniz yok.'));
      expect(messageDeliveryError(code, 'dm')).toBe(t('delivery_permission_generic', 'Bu işlemi yapma yetkiniz yok.'));
      expect(messageDeliveryError(code, 'gdm')).toBe(t('delivery_permission_generic', 'Bu işlemi yapma yetkiniz yok.'));
    }
  });

  it('bilinmeyen ve string olmayan kodlar yüzeye göre güvenli yedeğe düşer', () => {
    const group = t('delivery_group_failed', 'Grup mesajı gönderilemedi. Yeniden deneyin.');
    const generic = t('delivery_send_failed', 'Mesaj gönderilemedi. Yeniden deneyin.');

    for (const code of ['SQL_ERROR: relation missing', '', undefined, null, 42, { code: 'x' }]) {
      expect(messageDeliveryError(code, 'gdm')).toBe(group);
      expect(messageDeliveryError(code, 'channel')).toBe(generic);
      expect(messageDeliveryError(code, 'dm')).toBe(generic);
    }
    // Sunucu ayrintisi hicbir yuzeyde gorunmez.
    expect(messageDeliveryError('SQL_ERROR: relation missing', 'dm')).not.toContain('SQL');
  });

  it('bağlantı kaybı ayrı ve belirsizliği kabul eden bir metin verir', () => {
    expect(connectionLostDeliveryError())
      .toBe(t('delivery_connection_lost', 'Bağlantı kesildi. Mesajın durumunu doğrulamak için yeniden deneyin.'));
  });
});

describe('kayıtlı aramalar', () => {
  it('normalizasyon kırpar, boşları atar, harf duyarsız tekilleştirir ve tavanı uygular', () => {
    expect(normalizeSaved(['  bridge  ', 'BRIDGE', '', '   ', 'svelte'])).toEqual(['bridge', 'svelte']);

    const long = 'x'.repeat(300);
    expect(normalizeSaved([long])[0]).toHaveLength(180);

    const many = Array.from({ length: MAX_SAVED_SEARCHES + 5 }, (_, i) => `sorgu-${i}`);
    const capped = normalizeSaved(many);
    expect(capped).toHaveLength(MAX_SAVED_SEARCHES);
    expect(capped[0]).toBe('sorgu-0');
  });

  it('depo yokken, bozuk JSON\'da ve dizi olmayan kayıtta boş liste döner', () => {
    expect(loadSaved('u-1', null)).toEqual([]);

    const bad: Pick<Storage, 'getItem' | 'setItem'> = { getItem: () => '{bozuk', setItem: () => undefined };
    expect(loadSaved('u-1', bad)).toEqual([]);

    const notArray: Pick<Storage, 'getItem' | 'setItem'> = { getItem: () => '{"a":1}', setItem: () => undefined };
    expect(loadSaved('u-1', notArray)).toEqual([]);

    const mixed: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => JSON.stringify(['bridge', 7, null, { q: 'x' }, 'svelte']),
      setItem: () => undefined,
    };
    expect(loadSaved('u-1', mixed)).toEqual(['bridge', 'svelte']);
  });

  it('kayıt kullanıcıya özel anahtar kullanır; kimliksiz çağrı anonim kovaya düşer', () => {
    saveSaved('kullanici-1', ['bridge']);
    saveSaved('   ', ['gizli']);

    expect(localStorage.getItem('bridge:saved-searches:kullanici-1')).toBe(JSON.stringify(['bridge']));
    expect(localStorage.getItem('bridge:saved-searches:anonymous')).toBe(JSON.stringify(['gizli']));
    // Bir kullanicinin kaydi otekinin kovasina sizmaz.
    expect(loadSaved('kullanici-2')).toEqual([]);
    expect(loadSaved('kullanici-1')).toEqual(['bridge']);
  });

  it('çok uzun kullanıcı kimliği anahtarı sınırlar ve yine de tutarlı okunur', () => {
    const huge = 'k'.repeat(400);
    saveSaved(huge, ['bridge']);
    expect(loadSaved(huge)).toEqual(['bridge']);
    expect(localStorage.getItem(`bridge:saved-searches:${'k'.repeat(128)}`)).toBe(JSON.stringify(['bridge']));
  });

  it('yazma başarısız olursa kısayol sessizce vazgeçer', () => {
    const failing: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => '[]',
      setItem: () => { throw new Error('kota doldu'); },
    };
    expect(() => saveSaved('u-1', ['bridge'], failing)).not.toThrow();
    expect(() => saveSaved('u-1', ['bridge'], null)).not.toThrow();
  });

  it('ekleme sorguyu başa taşır ve kopyasını bırakmaz', () => {
    expect(addSaved(['bridge', 'svelte'], 'vitest')).toEqual(['vitest', 'bridge', 'svelte']);
    expect(addSaved(['bridge', 'svelte'], '  SVELTE ')).toEqual(['SVELTE', 'bridge']);
    expect(addSaved(['bridge'], '   ')).toEqual(['bridge']);
  });

  it('kaldırma harf duyarsızdır ve boşlukları yok sayar', () => {
    expect(removeSaved(['Bridge', 'svelte'], '  bridge ')).toEqual(['svelte']);
    expect(removeSaved(['Bridge', 'svelte'], 'yok')).toEqual(['Bridge', 'svelte']);
  });
});
