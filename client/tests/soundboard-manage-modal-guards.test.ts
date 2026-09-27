// client/tests/soundboard-manage-modal-guards.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// soundboard.ts — SES YÖNETME PENCERESİ VE EKSİK DOM PARÇALARI
// ════════════════════════════════════════════════════════════════════════════
// "Sesi yönet" penceresi bir YAZMA yüzeyidir: adı değiştirir ya da sesi
// tamamen siler. Bu yüzden her giriş yolu ayrı ayrı sınanmalıdır — bir
// yazım hatası taşıyan, eskimiş ya da kurcalanmış bir `data-*` değeri
// SESSİZCE bir silme isteğine dönüşmemelidir.
//
// İkinci sınıf: EKSİK DOM. Panelin parçaları (bekleme uyarısı, ilerleme
// çubuğu, ad alanı) bir tema, bir eklenti ya da bayat bir render tarafından
// yok edilmiş olabilir. Bu durumda kod ÇÖKMEMELİ, ama uydurma bir değerle de
// devam etmemelidir: adı olmayan bir ses yüklenmemelidir.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// KANONİK SÖZLÜĞE DEVRET.
// Önceki çift `(key, fallback) => fallback` biçimindeydi: yedek metni olmayan
// çağrılar HAM ANAHTAR döndürüyor, üçüncü argüman (`vars`) ise tamamen yok
// sayıldığı için `'{count} ses yüklendi'` gibi metinler YER TUTUCULARI
// YERLEŞTİRİLMEDEN kalıyordu. Böyle bir çift, ürünün yapmadığı bir davranışı
// ölçer; testler de gerçek metni değil çiftin kusurunu doğrular.
vi.mock('../js/core/i18n/index', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { ...real };
});

import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import {
  closeSoundboardPanel, initSoundboardSocket, openSoundboard, openSoundUpload,
  setSoundboardMuted, setSoundboardVolume, stopSoundboard, uploadSound,
} from '../js/soundboard.ts';

const toast = vi.fn();
const apiFetch = vi.fn();

const response = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response);
const page = (items: unknown[], canManage = true): unknown => ({ items, nextCursor: null, canManage });
const sound = (index: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ _id: `snd-${index}`, name: `Sound ${index}`, emoji: '🔊', url: `/sound-${index}.ogg`, scope: 'server', ...extra });

const flush = async (): Promise<void> => {
  await Promise.resolve(); await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};

class AudioStub {
  src: string; volume = 1;
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  pause = vi.fn(); play = vi.fn(async () => undefined);
  constructor(src = '') { this.src = src; }
}
class FakeSocket {
  on = vi.fn(() => this); off = vi.fn(() => this); emit = vi.fn();
}

/** Paneli açar ve "sesi yönet" penceresini gerçek tıklama yoluyla getirir. */
async function openManageModal(): Promise<void> {
  apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
  await openSoundboard();
  await flush();
  const manage = document.querySelector<HTMLElement>('[data-soundboard-action="manage"]');
  if (!manage) throw new Error('yönet denetimi çizilmedi');
  manage.click();
  await flush();
}

const manageModal = () => document.getElementById('sound-manage-modal');

beforeEach(() => {
  stopSoundboard(); closeSoundboardPanel();
  initSoundboardSocket(new FakeSocket())();
  document.body.innerHTML = '<div class="chat-area"></div>';
  localStorage.clear();
  toast.mockReset(); apiFetch.mockReset();
  vi.stubGlobal('toast', toast); vi.stubGlobal('apiFetch', apiFetch); BridgeRegistry.register('apiFetch', apiFetch as never); vi.stubGlobal('API', 'https://bridge.test');
  vi.stubGlobal('currentServer', { _id: 's1' }); vi.stubGlobal('Audio', AudioStub as unknown as typeof Audio);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:s') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  BridgeRegistry.unregister('getCurrentServer');
  BridgeRegistry.register('rtc', { isInVoice: () => true, currentChannelId: 'voice-1' } as never);
  BridgeRegistry.register('socket', { emit: vi.fn() } as never);
  setSoundboardMuted(false); setSoundboardVolume(0.8);
});

describe('manage modal only acts on declared actions', () => {
  it('opens from the sound row and pre-fills the current values', async () => {
    await openManageModal();
    expect(manageModal()).not.toBeNull();
    expect((document.getElementById('sound-rename-input') as HTMLInputElement).value).toBe('Sound 1');
    expect((document.getElementById('sound-rename-emoji') as HTMLInputElement).value).toBe('🔊');
  });

  it.each([
    ['a click with no action ancestor', 'sound-manage-title'],
  ])('ignores %s', async (_label, targetId) => {
    await openManageModal();
    apiFetch.mockClear();
    (document.getElementById(targetId) as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(manageModal()).not.toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('ignores an action name it does not implement', async () => {
    await openManageModal();
    apiFetch.mockClear();
    const forged = document.createElement('button');
    forged.setAttribute('data-sound-manage-action', 'publish');
    manageModal()!.querySelector('.modal-card')!.appendChild(forged);
    forged.click();
    await flush();
    // Tanınmayan eylem NE kaydeder NE siler NE de pencereyi kapatır.
    expect(manageModal()).not.toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('refuses to save a sound whose name was emptied', async () => {
    await openManageModal();
    (document.getElementById('sound-rename-input') as HTMLInputElement).value = '   ';
    apiFetch.mockClear();
    manageModal()!.querySelector<HTMLElement>('[data-sound-manage-action="save"]')!.click();
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('İsim'), 'error');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('applies canonical fallbacks for an emptied emoji and category', async () => {
    await openManageModal();
    (document.getElementById('sound-rename-input') as HTMLInputElement).value = 'Yeni ad';
    (document.getElementById('sound-rename-emoji') as HTMLInputElement).value = '  ';
    (document.getElementById('sound-rename-category') as HTMLInputElement).value = '';
    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response(200, {}));
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));

    manageModal()!.querySelector<HTMLElement>('[data-sound-manage-action="save"]')!.click();
    await flush();

    const [url, init] = apiFetch.mock.calls[0];
    expect(String(url)).toContain('/api/servers/s1/soundboard/snd-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Yeni ad', emoji: '🔊', category: 'Server' });
  });

  it('closes without writing anything when cancel is chosen', async () => {
    await openManageModal();
    apiFetch.mockClear();
    manageModal()!.querySelector<HTMLElement>('[data-sound-manage-action="close"]')!.click();
    await flush();
    expect(manageModal()).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does nothing once the managed sound reference has been cleared', async () => {
    await openManageModal();
    const save = manageModal()!.querySelector<HTMLElement>('[data-sound-manage-action="save"]')!;
    manageModal()!.querySelector<HTMLElement>('[data-sound-manage-action="close"]')!.click();
    await flush();
    apiFetch.mockClear();

    // Pencere kapandı; sökülmüş düğmeye yapılan geç tıklama HİÇBİR ŞEY yazmaz.
    save.click();
    await flush();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('missing panel fragments never fabricate a value', () => {
  it('refuses to upload when the name field itself is gone', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    await flush();
    openSoundUpload();

    const input = document.getElementById('sound-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true, value: [new File([new Uint8Array(64)], 'a.mp3', { type: 'audio/mpeg' })],
    });
    // Ad alanı sökülmüş: isim UYDURULMAZ, yükleme reddedilir.
    document.getElementById('sound-name-input')!.remove();
    apiFetch.mockClear();

    await uploadSound();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('İsim'), 'error');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('uploads without a progress element present', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    await flush();
    openSoundUpload();

    const input = document.getElementById('sound-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true, value: [new File([new Uint8Array(64)], 'a.mp3', { type: 'audio/mpeg' })],
    });
    (document.getElementById('sound-name-input') as HTMLInputElement).value = 'Boom';
    document.getElementById('sound-upload-progress')!.remove();
    apiFetch.mockClear();
    apiFetch.mockResolvedValueOnce(response(200, {}));
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));

    await uploadSound();
    await flush();
    // İlerleme çubuğu yokken de yükleme TAMAMLANIR.
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('eklendi'), 'success');
  });
});

describe('keyboard navigation on unexpected targets', () => {
  it('ignores an arrow key on a category-looking element outside the tab list', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    await flush();

    // BELGEYE HİÇ BAĞLI OLMAYAN ama aynı sınıfı taşıyan bir eleman: sekme
    // listesinde bulunmadığı için gezinme onu ATLAR. Bayat bir render'dan
    // artakalan böyle bir düğüm, aksi hâlde `tabs[-1]` üzerinden yanlış
    // sekmeye odak verirdi.
    const stray = document.createElement('button');
    stray.className = 'soundboard-category';

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { configurable: true, value: stray });
    document.getElementById('soundboard-panel')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
