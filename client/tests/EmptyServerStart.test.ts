import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// ── KOPYA METNİ TEST SABİTİ DEĞİLDİR ──────────────────────────────────────
// Ham hata metni (`'Sunucu hatası. Birazdan tekrar dene.'`) i18n sözlüğüne
// taşındığında (`error_server`, `error_network`) üretim doğru davranmaya
// devam etti, testler ise bir dizgenin harflerini ölçtüğü için kırmızıya
// döndü. Sözleşme "kanonik ve güvenli mesaj gösterilir"dir.
import { t } from '../js/core/i18n/index.ts';

const bridgeRegistryMock = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  get: vi.fn(),
}));

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: bridgeRegistryMock,
}));

import EmptyServerStart from '../js/core/EmptyServerStart.svelte';

function response(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe('EmptyServerStart', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.lang = 'tr';
    window.localStorage.clear();

    bridgeRegistryMock.register.mockReset();
    bridgeRegistryMock.unregister.mockReset();
    bridgeRegistryMock.get.mockReset();
    apiFetchMock.mockReset();
    bridgeRegistryMock.get.mockImplementation((key: string) => {
      if (key === 'getMe') return () => ({ _id: 'user-1' });
      if (key === 'apiFetch') return apiFetchMock;
      return undefined;
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Ham fetch kullanılmamalı'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('sunucusu olmayan kullanıcıya oluştur/katıl/QR seçeneklerini gösterir', async () => {
    apiFetchMock.mockResolvedValue(response([]));

    render(EmptyServerStart);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Henüz bir sunucun yok' })
      ).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Sunucu Oluştur/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Davet Koduyla Katıl/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /QR Kod Tara/i })).toBeInTheDocument();

    expect(apiFetchMock).toHaveBeenCalledWith('/api/servers', {});
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('kendiliğinden açılan karşılama, kişinin açtığı başka bir pencerenin ÜSTÜNE inmez; kapanınca gelir', async () => {
    // Final21 Faz 19 (gerçek tarayıcıda ölçüldü): girişten 800 ms sonra gelen karşılama,
    // kişinin o arada açtığı Ayarlar penceresinin üstüne iniyor ve işini kesiyordu.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const settings = document.createElement('div');
      settings.setAttribute('role', 'dialog');
      settings.setAttribute('aria-modal', 'true');
      document.body.appendChild(settings);
      apiFetchMock.mockResolvedValue(response([]));

      render(EmptyServerStart);
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(2_500);
      expect(screen.queryByRole('heading', { name: 'Henüz bir sunucun yok' })).not.toBeInTheDocument();

      settings.remove();
      await vi.advanceTimersByTimeAsync(1_100);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument());
      // Kapanınca liste YENİDEN sorulur (arada bir sunucuya katılmış olabilir).
      expect(apiFetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('KONTROL: gizli (display:none) bir iletişim kutusu karşılamayı ERTELEMEZ', async () => {
    const hiddenDialog = document.createElement('div');
    hiddenDialog.setAttribute('role', 'dialog');
    hiddenDialog.setAttribute('aria-modal', 'true');
    hiddenDialog.style.display = 'none';
    document.body.appendChild(hiddenDialog);
    apiFetchMock.mockResolvedValue(response([]));

    render(EmptyServerStart);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument());
  });

  test('en az bir sunucusu olan kullanıcıya başlangıç ekranını göstermez', async () => {
    apiFetchMock.mockResolvedValue(
      response([{ _id: 'server-1', name: 'Oyun Ekibi' }])
    );

    render(EmptyServerStart);

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/servers', {});
    });

    expect(
      screen.queryByRole('heading', { name: 'Henüz bir sunucun yok' })
    ).not.toBeInTheDocument();
  });
  test('sunucu oluştururken kanonik API istemcisine JSON POST gönderir', async () => {
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/servers' && init?.method !== 'POST') {
        return Promise.resolve(response([]));
      }
      return new Promise<Response>(() => {});
    });

    render(EmptyServerStart);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sunucu Oluştur/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Sunucu Oluştur/i }));

    const nameInput = await screen.findByPlaceholderText('Örn. Oyun Ekibi');
    fireEvent.input(nameInput, { target: { value: 'Bridge Türkiye' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });

    await waitFor(() => {
      expect(
        apiFetchMock.mock.calls.some(
          ([url, init]) => url === '/api/servers' && (init as RequestInit)?.method === 'POST'
        )
      ).toBe(true);
    });

    const post = apiFetchMock.mock.calls.find(
      ([url, init]) => url === '/api/servers' && (init as RequestInit)?.method === 'POST'
    );
    const postInit = post?.[1] as RequestInit;

    expect(JSON.parse(String(postInit.body))).toEqual({
      name: 'Bridge Türkiye',
      icon: '🌐',
    });
    expect(new Headers(postInit.headers).get('Content-Type')).toBe('application/json');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('davet bağlantısından çıkarılan kodla katılma isteği gönderir', async () => {
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/servers' && init?.method !== 'POST') {
        return Promise.resolve(response([]));
      }
      return new Promise<Response>(() => {});
    });

    render(EmptyServerStart);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Davet Koduyla Katıl/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Davet Koduyla Katıl/i }));

    const inviteInput = await screen.findByPlaceholderText(
      'örn. a1b2c3d4 veya https://…/invite/a1b2c3d4'
    );
    fireEvent.input(inviteInput, {
      target: { value: 'https://bridge.example/invite/a1B2_c-9' },
    });
    fireEvent.keyDown(inviteInput, { key: 'Enter' });

    await waitFor(() => {
      expect(
        apiFetchMock.mock.calls.some(
          ([url, init]) =>
            url === '/api/servers/invites/a1B2_c-9/use' &&
            (init as RequestInit)?.method === 'POST'
        )
      ).toBe(true);
    });

    const post = apiFetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/servers/invites/a1B2_c-9/use' &&
        (init as RequestInit)?.method === 'POST'
    );
    const postInit = post?.[1] as RequestInit;

    expect(postInit.body).toBe('{}');
    expect(new Headers(postInit.headers).get('Content-Type')).toBe('application/json');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('geçici liste hatasını sınırlı yeniden deneyip başarı kanıtı gelince ekranı açar', async () => {
    vi.useFakeTimers();
    try {
      apiFetchMock
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(response([]));

      render(EmptyServerStart);
      await Promise.resolve(); await Promise.resolve();
      expect(apiFetchMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();

      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve(); await Promise.resolve();
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    expect(await screen.findByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument();
  });

  test('401 veya oturumsuz kimlik ilk-sunucu duvarını göstermez', async () => {
    apiFetchMock.mockResolvedValueOnce(response({ error: 'unauthorized' }, 401));
    const first = render(EmptyServerStart);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).toBeNull();
    first.unmount();

    bridgeRegistryMock.get.mockImplementation((key: string) => {
      if (key === 'getMe') return () => ({ id: '' });
      if (key === 'apiFetch') return apiFetchMock;
      return undefined;
    });
    apiFetchMock.mockClear();
    render(EmptyServerStart);
    await Promise.resolve(); await Promise.resolve();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('boş sunucu adını reddeder ve API hata gövdesini SIZDIRMADAN kanonik mesaj gösterir', async () => {
    apiFetchMock
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ error: 'Bu sunucu adı zaten kullanılıyor.' }, 409));
    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /Sunucu Oluştur/i }));

    const submit = screen.getByRole('button', { name: /^Sunucu Oluştur$/i });
    fireEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sunucuna bir ad ver.');

    fireEvent.input(screen.getByPlaceholderText('Örn. Oyun Ekibi'), { target: { value: '  Güvenli Alan  ' } });
    fireEvent.input(screen.getByPlaceholderText('🌐'), { target: { value: '   ' } });
    fireEvent.click(submit);
    // api-error.ts guvenlik sozlesmesi: "Sunucu govdesi, stack trace, URL,
    // token vb. ASLA bildirime konmaz." Bu test eskiden sunucunun gonderdigi
    // metnin EKRANA BASILMASINI bekliyordu; artik 409 kanonik `error_conflict`
    // metnine eslenir ve ham govde SIZMAZ.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t('error_conflict'));
    expect(alert.textContent ?? '').not.toContain('Bu sunucu adı zaten kullanılıyor.');
    const post = apiFetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ name: 'Güvenli Alan', icon: '🌐' });
  });

  test('JSON olmayan API hatasında durum kodlu geri dönüş kullanır', async () => {
    apiFetchMock
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => { throw new SyntaxError('html'); } } as Response);
    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /Davet Koduyla Katıl/i }));
    const input = screen.getByPlaceholderText('örn. a1b2c3d4 veya https://…/invite/a1b2c3d4');
    fireEvent.input(input, { target: { value: 'valid-code' } });
    fireEvent.click(screen.getByRole('button', { name: /^Sunucuya Katıl$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('error_server'));
  });

  test('yalnız ayraçlardan oluşan daveti reddeder ve sunucuya istek göndermez', async () => {
    apiFetchMock.mockResolvedValueOnce(response([]));
    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /Davet Koduyla Katıl/i }));
    fireEvent.input(screen.getByPlaceholderText('örn. a1b2c3d4 veya https://…/invite/a1b2c3d4'), {
      target: { value: ' !!! / ... ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Sunucuya Katıl$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Geçerli bir davet kodu/i);
    expect(apiFetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  });

  test('QR desteği yoksa güvenli manuel-davet geri dönüşünü gösterir ve moddan çıkarken temizler', async () => {
    apiFetchMock.mockResolvedValueOnce(response([]));
    vi.stubGlobal('BarcodeDetector', undefined);
    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /QR Kod Tara/i }));
    expect(await screen.findByText(/QR tarama desteklenmiyor/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Davet kodunu yapıştır/i }));
    expect(await screen.findByRole('heading', { name: 'Sunucuya katıl' })).toBeInTheDocument();
  });

  test('QR kamera sonucunu davet akışına taşır ve kamera izini bırakmaz', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const detect = vi.fn(async () => [{ rawValue: 'bridge://invite/qr_SAFE-9' }]);
    class Detector { detect = detect; }
    vi.stubGlobal('BarcodeDetector', Detector);
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/servers' && init?.method !== 'POST') return Promise.resolve(response([]));
      return new Promise<Response>(() => {});
    });

    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /QR Kod Tara/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/servers/invites/qr_SAFE-9/use', expect.objectContaining({ method: 'POST' }),
    ));
    expect(detect).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  test('kamera izni reddedilirse ayrıntıyı çalıştırılabilir bağlama taşımadan hata gösterir', async () => {
    apiFetchMock.mockResolvedValueOnce(response([]));
    class Detector { detect = vi.fn(async () => []); }
    vi.stubGlobal('BarcodeDetector', Detector);
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => { throw new Error('permission denied'); }) },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();

    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /QR Kod Tara/i }));
    expect(await screen.findByText('Kamera açılamadı. Davet kodunu yapıştırabilirsin.')).toBeInTheDocument();
  });

  test('Escape/kapat sahipliği ve açık kayıtlı komutu ekranı deterministik yönetir', async () => {
    apiFetchMock.mockResolvedValueOnce(response([]));
    render(EmptyServerStart);
    expect(await screen.findByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const open = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'openServerStart')?.[1] as (() => void);
    open();
    expect(await screen.findByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Kapat ve uygulamaya devam et/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const check = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'checkEmptyServerStart')?.[1] as (() => Promise<void>);
    const calls = apiFetchMock.mock.calls.length;
    await check();
    expect(apiFetchMock).toHaveBeenCalledTimes(calls);
  });

  test('kapatılan veya daha yeni sorguyla geçersizleşen server-list yanıtı duvarı geri açmaz', async () => {
    apiFetchMock.mockResolvedValueOnce(response([]));
    render(EmptyServerStart);
    expect(await screen.findByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument();
    const check = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'checkEmptyServerStart')?.[1] as (() => Promise<void>);

    let releaseDismissed!: (value: Response) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseDismissed = resolve; }));
    const dismissedRefresh = check();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /Kapat ve uygulamaya devam et/i }));
    releaseDismissed(response([]));
    await dismissedRefresh;
    expect(screen.queryByRole('dialog')).toBeNull();

    const open = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'openServerStart')?.[1] as (() => void);
    open();
    let releaseOld!: (value: Response) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseOld = resolve; }))
      .mockResolvedValueOnce(response([{ _id: 'existing' }]));
    const oldRefresh = check();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    await check();
    expect(screen.queryByRole('dialog')).toBeNull();
    releaseOld(response([]));
    await oldRefresh;
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('geri dönülen create/join isteklerinin geç sonuçlarını ve hatalarını görünür duruma uygulamaz', async () => {
    apiFetchMock.mockResolvedValueOnce(response([]));
    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /Sunucu Oluştur/i }));
    fireEvent.input(screen.getByPlaceholderText('Örn. Oyun Ekibi'), { target: { value: 'Late server' } });

    let releaseCreate!: (value: Response) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { releaseCreate = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /^Sunucu Oluştur$/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /Geri/i }));
    releaseCreate(response({ _id: 'late' }, 201));
    await Promise.resolve(); await Promise.resolve();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Davet Koduyla Katıl/i }));
    fireEvent.input(screen.getByPlaceholderText('örn. a1b2c3d4 veya https://…/invite/a1b2c3d4'), { target: { value: 'late-code' } });
    let rejectJoin!: (reason: unknown) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectJoin = reject; }));
    fireEvent.click(screen.getByRole('button', { name: /^Sunucuya Katıl$/i }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: /Geri/i }));
    rejectJoin('late rejection');
    await Promise.resolve(); await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument();
  });

  test('QR modu kamera izni beklerken terk edilirse geç akışı durdurur', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    let releaseCamera!: (value: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { releaseCamera = resolve; }));
    const detect = vi.fn(async () => [{ rawValue: 'bridge://invite/too-late' }]);
    class Detector { detect = detect; }
    vi.stubGlobal('BarcodeDetector', Detector);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    apiFetchMock.mockResolvedValueOnce(response([]));

    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /QR Kod Tara/i }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /Geri/i }));
    releaseCamera(stream);
    await waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
    expect(detect).not.toHaveBeenCalled();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  test('QR algılama sonucu mod değişiminden sonra davet kullanamaz', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    let releaseDetection!: (value: Array<{ rawValue: string }>) => void;
    const detect = vi.fn(() => new Promise<Array<{ rawValue: string }>>(resolve => { releaseDetection = resolve; }));
    class Detector { detect = detect; }
    vi.stubGlobal('BarcodeDetector', Detector);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    apiFetchMock.mockResolvedValueOnce(response([]));

    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /QR Kod Tara/i }));
    await waitFor(() => expect(detect).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /Davet kodunu yapıştır/i }));
    releaseDetection([{ rawValue: 'bridge://invite/late-detect' }]);
    await Promise.resolve(); await Promise.resolve();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Sunucuya katıl' })).toBeInTheDocument();
  });

  test('güvenli API sahibi yoksa yalnız görünür ekranda eyleme dönük hata gösterir ve unmount temizler', async () => {
    vi.useFakeTimers();
    try {
      bridgeRegistryMock.get.mockImplementation((key: string) => {
        if (key === 'getMe') return () => ({ _id: 'user-1' });
        return undefined;
      });
      const view = render(EmptyServerStart);
      await Promise.resolve(); await Promise.resolve();
      const open = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'openServerStart')?.[1] as (() => void);
      const check = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'checkEmptyServerStart')?.[1] as (() => Promise<void>);
      open();
      await check();
      expect(screen.getByRole('alert')).toHaveTextContent(/Sunucu listen yüklenemedi/);
      view.unmount();
      expect(bridgeRegistryMock.unregister).toHaveBeenCalledWith('checkEmptyServerStart');
      expect(bridgeRegistryMock.unregister).toHaveBeenCalledWith('openServerStart');
      expect(bridgeRegistryMock.unregister).toHaveBeenCalledWith('closeServerStart');
      await vi.advanceTimersByTimeAsync(8_000);
      expect(apiFetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('görünür liste hatalarını dürüstçe gösterir, retry çoğaltmaz ve online dönüşünü işler', async () => {
    apiFetchMock.mockResolvedValueOnce(response([]));
    render(EmptyServerStart);
    expect(await screen.findByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument();
    const check = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'checkEmptyServerStart')?.[1] as (() => Promise<void>);

    apiFetchMock.mockRejectedValueOnce('offline without Error');
    await check();
    expect(screen.getByRole('alert')).toHaveTextContent(/Sunucu listen yüklenemedi/);

    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: '   ' }) } as Response);
    await check();
    expect(screen.getByRole('alert')).toHaveTextContent(t('error_server'));

    apiFetchMock.mockResolvedValueOnce(response([]));
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Kapat ve uygulamaya devam et/i }));
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(apiFetchMock).toHaveBeenCalledTimes(4);
  });

  test('JSON okuması ve taşıma hatası sırasında eskiyen refresh sonuçlarını yoksayar', async () => {
    apiFetchMock.mockResolvedValueOnce(response([]));
    render(EmptyServerStart);
    expect(await screen.findByRole('heading', { name: 'Henüz bir sunucun yok' })).toBeInTheDocument();
    const check = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'checkEmptyServerStart')?.[1] as (() => Promise<void>);
    const open = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'openServerStart')?.[1] as (() => void);

    let releaseJson!: (value: unknown[]) => void;
    const json = vi.fn(() => new Promise<unknown[]>(resolve => { releaseJson = resolve; }));
    apiFetchMock.mockResolvedValueOnce({ ok: true, status: 200, json } as unknown as Response);
    const parsing = check();
    await waitFor(() => expect(json).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /Kapat ve uygulamaya devam et/i }));
    releaseJson([]);
    await parsing;
    expect(screen.queryByRole('dialog')).toBeNull();

    open();
    let rejectOld!: (reason: Error) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValueOnce(response([{ _id: 'newer-server' }]));
    const obsolete = check();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    await check();
    rejectOld(new Error('obsolete transport'));
    await obsolete;
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('geçerli create ve join ağ hatalarının Error olmayan biçimini güvenli varsayılanla gösterir', async () => {
    apiFetchMock.mockResolvedValueOnce(response([]));
    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /Sunucu Oluştur/i }));
    const name = screen.getByPlaceholderText('Örn. Oyun Ekibi');
    fireEvent.keyDown(name, { key: 'Shift' });
    fireEvent.input(name, { target: { value: 'Failure' } });
    apiFetchMock.mockRejectedValueOnce('create failed');
    fireEvent.click(screen.getByRole('button', { name: /^Sunucu Oluştur$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sunucu oluşturulamadı. Tekrar dene.');

    fireEvent.click(screen.getByRole('button', { name: /Geri/i }));
    fireEvent.click(screen.getByRole('button', { name: /Davet Koduyla Katıl/i }));
    const invite = screen.getByPlaceholderText('örn. a1b2c3d4 veya https://…/invite/a1b2c3d4');
    fireEvent.keyDown(invite, { key: 'Shift' });
    fireEvent.input(invite, { target: { value: 'valid' } });
    apiFetchMock.mockRejectedValueOnce('join failed');
    fireEvent.click(screen.getByRole('button', { name: /^Sunucuya Katıl$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sunucuya katılınamadı. Davet kodunu kontrol edip tekrar dene.');
  });

  test('başarılı create ve join yalnız güncel modda durum kanıtı üretir', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetchMock.mockResolvedValueOnce(response([]));
    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /Sunucu Oluştur/i }));
    fireEvent.input(screen.getByPlaceholderText('Örn. Oyun Ekibi'), { target: { value: 'Success' } });
    apiFetchMock.mockResolvedValueOnce(response({ _id: 'created' }, 201));
    fireEvent.click(screen.getByRole('button', { name: /^Sunucu Oluştur$/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sunucun oluşturuldu');

    const open = bridgeRegistryMock.register.mock.calls.find(([name]) => name === 'openServerStart')?.[1] as (() => void);
    open();
    await screen.findByRole('heading', { name: 'Henüz bir sunucun yok' });
    fireEvent.click(screen.getByRole('button', { name: /Davet Koduyla Katıl/i }));
    fireEvent.input(screen.getByPlaceholderText('örn. a1b2c3d4 veya https://…/invite/a1b2c3d4'), { target: { value: 'success-code' } });
    apiFetchMock.mockResolvedValueOnce(response({ ok: true }));
    fireEvent.click(screen.getByRole('button', { name: /^Sunucuya Katıl$/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sunucuya katıldın');
    consoleError.mockRestore();
  });

  test('boş QR karelerini yeniden tarar, kare hatasını yalıtır ve unmount zamanlayıcıyı kapatır', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const detect = vi.fn()
      .mockRejectedValueOnce(new Error('bad frame'))
      .mockResolvedValue([]);
    class Detector { detect = detect; }
    vi.stubGlobal('BarcodeDetector', Detector);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    apiFetchMock.mockResolvedValueOnce(response([]));

    const view = render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /Davet Koduyla Katıl/i }));
    fireEvent.click(screen.getByRole('button', { name: /Bunun yerine QR kod tara/i }));
    await waitFor(() => expect(detect.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect(screen.getByText(/Kamera açık/i)).toBeInTheDocument();
    const calls = detect.mock.calls.length;
    view.unmount();
    expect(track.stop).toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(detect).toHaveBeenCalledTimes(calls);
  });

  test('video oynatma beklerken QR modu kapanırsa geç devam etmez; Error olmayan kamera reddi geneldir', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    let releasePlay!: () => void;
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementationOnce(() => new Promise<void>(resolve => { releasePlay = resolve; }));
    class Detector { detect = vi.fn(async () => []); }
    vi.stubGlobal('BarcodeDetector', Detector);
    vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    apiFetchMock.mockResolvedValueOnce(response([]));
    render(EmptyServerStart);
    fireEvent.click(await screen.findByRole('button', { name: /QR Kod Tara/i }));
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /Geri/i }));
    releasePlay();
    await Promise.resolve(); await Promise.resolve();
    expect(track.stop).toHaveBeenCalled();

    let rejectLatePlay!: (reason: Error) => void;
    play.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectLatePlay = reject; }));
    fireEvent.click(screen.getByRole('button', { name: /QR Kod Tara/i }));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /Geri/i }));
    rejectLatePlay(new Error('late play rejection'));
    await Promise.resolve(); await Promise.resolve();
    expect(track.stop.mock.calls.length).toBeGreaterThanOrEqual(2);

    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      mediaDevices: { getUserMedia: vi.fn(() => Promise.reject('camera rejected')) },
    });
    fireEvent.click(screen.getByRole('button', { name: /QR Kod Tara/i }));
    expect(await screen.findByText('Kamera açılamadı. Davet kodunu yapıştırabilirsin.')).toBeInTheDocument();
  });

});
