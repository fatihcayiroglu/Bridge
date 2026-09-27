import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

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

function response(body: unknown): Response {
  return { ok: true, json: vi.fn(async () => body) } as unknown as Response;
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div class="chat-area"></div>';
  localStorage.clear();
  vi.stubGlobal('API', 'https://bridge.test');
  vi.stubGlobal('currentServer', { _id: 's1' });
  vi.stubGlobal('toast', vi.fn());
  vi.stubGlobal('apiFetch', vi.fn(async () => response({ items: [], nextCursor: null, canManage: false })));
});

describe('soundboard persisted presentation settings', () => {
  it('restores, clamps and filters durable volume/mute/suppression settings before first paint', async () => {
    localStorage.setItem('bridge.soundboard.settings.v1', JSON.stringify({
      volume: 7,
      muted: true,
      suppressedUserIds: ['allowed', 12, null, 'also-allowed'],
    }));
    const soundboard = await import('../js/soundboard.ts');
    await soundboard.openSoundboard();
    expect(document.getElementById('soundboard-volume')).toHaveValue('100');
    expect(document.querySelector('[data-soundboard-action="mute"]')).toHaveAttribute('aria-pressed', 'true');
    soundboard.setSoundboardUserSuppressed('allowed', false);
    expect(JSON.parse(localStorage.getItem('bridge.soundboard.settings.v1') || '{}').suppressedUserIds).toEqual(['also-allowed']);
    soundboard.closeSoundboardPanel();
  });

  it('falls back safely when persisted JSON is corrupt', async () => {
    localStorage.setItem('bridge.soundboard.settings.v1', '{broken');
    const soundboard = await import('../js/soundboard.ts');
    await soundboard.openSoundboard();
    expect(document.getElementById('soundboard-volume')).toHaveValue('80');
    expect(document.querySelector('[data-soundboard-action="mute"]')).toHaveAttribute('aria-pressed', 'false');
    soundboard.closeSoundboardPanel();
  });
});
