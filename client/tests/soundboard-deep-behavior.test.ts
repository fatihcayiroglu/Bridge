import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';

// KANONIK SOZLUGE DEVRET.
// Onceki cift `(key, fallback) => fallback` idi ve UCUNCU argumani (`vars`)
// tamamen yok sayiyordu; bu yuzden `'{page}. sayfa'` / `'{count} ses yuklendi'`
// gibi metinler YER TUTUCULARI YERLESTIRILMEDEN donuyordu. Yani test, urunun
// yapmadigi bir davranisi olcuyordu.
vi.mock('../js/core/i18n/index', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { ...real };
});

import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import {
  SOUNDBOARD_DOM_WINDOW_SIZE,
  SOUNDBOARD_MAX_REMOTE_PLAYBACKS,
  SOUNDBOARD_PAGE_SIZE,
  closeSoundboardPanel,
  initSoundboardSocket,
  isSoundboardUserSuppressed,
  loadMoreSoundboard,
  openSoundboard,
  openSoundUpload,
  playSound,
  previewSoundFile,
  refreshSoundboard,
  runSoundboardSearch,
  setSoundboardMuted,
  setSoundboardUserSuppressed,
  setSoundboardVolume,
  stopSoundboard,
  uploadSound,
} from '../js/soundboard.ts';

const toast = vi.fn();
const apiFetch = vi.fn();
const socketEmit = vi.fn();
const rtc = { isInVoice: vi.fn(() => true), currentChannelId: 'voice-1' };

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response;
}

function page(items: unknown[], options: { nextCursor?: string | null; canManage?: boolean } = {}): unknown {
  return { items, nextCursor: options.nextCursor ?? null, canManage: options.canManage ?? false };
}

function sound(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { _id: `snd-${index}`, name: `Sound ${index}`, emoji: '🔊', url: `/sound-${index}.ogg`, scope: 'server', ...overrides };
}

async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
}

async function chooseProductDialog(action: 'confirm' | 'cancel'): Promise<void> {
  await flush();
  const button = document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`);
  if (!button) throw new Error(`product dialog ${action} button missing`);
  button.click();
  await flush();
}

class AudioStub {
  static instances: AudioStub[] = [];
  static playImpl = vi.fn(async () => undefined);
  src: string;
  volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(() => AudioStub.playImpl());
  constructor(src = '') { this.src = src; AudioStub.instances.push(this); }
}

class FakeSocket {
  handlers = new Map<string, Set<(...payload: unknown[]) => void>>();
  on = vi.fn((event: string, handler: (...payload: unknown[]) => void) => {
    const handlers = this.handlers.get(event) ?? new Set(); handlers.add(handler); this.handlers.set(event, handlers); return this;
  });
  off = vi.fn((event: string, handler: (...payload: unknown[]) => void) => { this.handlers.get(event)?.delete(handler); return this; });
  emit = vi.fn();
  emitLocal(event: string, payload?: unknown): void { for (const handler of this.handlers.get(event) ?? []) handler(payload); }
}

beforeEach(() => {
  stopSoundboard(); closeSoundboardPanel();
  const resetSocket = new FakeSocket(); initSoundboardSocket(resetSocket)();
  document.body.innerHTML = '<button id="return-focus">Open</button><div class="chat-area"></div>';
  localStorage.clear();
  toast.mockReset(); apiFetch.mockReset(); socketEmit.mockReset();
  rtc.isInVoice.mockReset(); rtc.isInVoice.mockReturnValue(true); rtc.currentChannelId = 'voice-1';
  AudioStub.instances.length = 0; AudioStub.playImpl.mockReset(); AudioStub.playImpl.mockResolvedValue(undefined);
  vi.stubGlobal('toast', toast); vi.stubGlobal('apiFetch', apiFetch); BridgeRegistry.register('apiFetch', apiFetch as never); vi.stubGlobal('API', 'https://bridge.test');
  vi.stubGlobal('currentServer', { _id: 's1' }); vi.stubGlobal('Audio', AudioStub as unknown as typeof Audio);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:bridge-sound') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  BridgeRegistry.unregister('getCurrentServer'); BridgeRegistry.unregister('rtc'); BridgeRegistry.unregister('socket');
  BridgeRegistry.register('rtc', rtc as never); BridgeRegistry.register('socket', { emit: socketEmit } as never);
  setSoundboardMuted(false); setSoundboardVolume(0.8);
  for (const id of ['u1', 'u2', 'u3']) setSoundboardUserSuppressed(id, false);
});

describe('soundboard popup, paging and accessibility', () => {
  it('requires a selected server and exposes a labelled, focus-managed dialog', async () => {
    vi.stubGlobal('currentServer', null);
    await openSoundboard();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('sunucu'), 'error');

    vi.stubGlobal('currentServer', { _id: 's1' });
    apiFetch.mockResolvedValueOnce(response(200, page([
      sound(1, { name: '<b>boom</b>', emoji: '<i>' }),
    ])));
    const trigger = document.getElementById('return-focus') as HTMLButtonElement;
    trigger.focus();
    await openSoundboard();
    expect(apiFetch).toHaveBeenCalledWith(`https://bridge.test/api/servers/s1/soundboard?limit=${SOUNDBOARD_PAGE_SIZE}&channelId=voice-1`);
    const panel = document.getElementById('soundboard-panel');
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-labelledby', 'soundboard-title');
    expect(document.activeElement).toBe(document.getElementById('soundboard-search'));
    expect(document.querySelector('#soundboard-grid')?.innerHTML).toContain('&lt;b&gt;boom&lt;/b&gt;');
    expect(document.querySelector('#soundboard-grid b')).toBeNull();
    panel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(document.getElementById('soundboard-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps a 1,000-item response DOM-bounded and navigates opaque cursor pages', async () => {
    const thousand = Array.from({ length: 1_000 }, (_, index) => sound(index));
    apiFetch.mockResolvedValueOnce(response(200, page(thousand, { nextCursor: 'opaque:48' })));
    await openSoundboard();
    expect(document.querySelectorAll('.sound-btn')).toHaveLength(SOUNDBOARD_PAGE_SIZE);
    expect(document.querySelectorAll('.sound-cell')).toHaveLength(SOUNDBOARD_PAGE_SIZE);

    apiFetch.mockResolvedValueOnce(response(200, page([sound(48), sound(49)])));
    (document.querySelector('[data-soundboard-action="next"]') as HTMLButtonElement).click();
    await flush();
    expect(apiFetch).toHaveBeenLastCalledWith(expect.stringContaining('cursor=opaque%3A48'));
    expect(document.querySelectorAll('.sound-btn')).toHaveLength(2);
    expect(document.getElementById('soundboard-page-label')?.textContent).toContain('2.');

    apiFetch.mockResolvedValueOnce(response(200, page(thousand, { nextCursor: 'opaque:48' })));
    (document.querySelector('[data-soundboard-action="previous"]') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelectorAll('.sound-btn')).toHaveLength(SOUNDBOARD_PAGE_SIZE);
  });

  it('incrementally traverses 1,500 metadata rows while virtualizing the DOM and never eagerly creating audio', async () => {
    const total = 1_500;
    const pages = Array.from({ length: Math.ceil(total / SOUNDBOARD_PAGE_SIZE) }, (_, pageIndex) => {
      const start = pageIndex * SOUNDBOARD_PAGE_SIZE;
      const items = Array.from({ length: Math.min(SOUNDBOARD_PAGE_SIZE, total - start) }, (_value, offset) => sound(start + offset));
      const nextCursor = start + items.length < total ? `cursor-${pageIndex + 1}` : null;
      return page(items, { nextCursor });
    });
    for (const body of pages) apiFetch.mockResolvedValueOnce(response(200, body));

    await openSoundboard();
    const grid = document.getElementById('soundboard-grid') as HTMLElement;
    Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(grid, 'scrollHeight', { configurable: true, get: () => grid.scrollTop + 400 });
    grid.scrollTop = 100_000;

    // The first continuation is caused by the real scroll owner. Continue the
    // same cursor path explicitly so this remains deterministic in jsdom while
    // still proving the infinite-scroll trigger itself.
    grid.dispatchEvent(new Event('scroll'));
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    for (let pageIndex = 2; pageIndex < pages.length; pageIndex += 1) {
      expect(await loadMoreSoundboard()).toBe(true);
      expect(document.querySelectorAll('.sound-cell').length).toBeLessThanOrEqual(SOUNDBOARD_DOM_WINDOW_SIZE);
    }

    expect(apiFetch).toHaveBeenCalledTimes(pages.length);
    expect(document.querySelectorAll('.sound-cell')).toHaveLength(SOUNDBOARD_DOM_WINDOW_SIZE);
    expect(document.querySelector('[data-sound-id="snd-1499"]')).not.toBeNull();
    expect(document.getElementById('soundboard-page-label')?.textContent).toContain('1500');
    expect(AudioStub.instances).toHaveLength(0);
  });

  it('searches on the server, supports category rails and renders distinct empty states', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2, { _id: 'global:pop', url: 'bridge-sound:pop', scope: 'global' })])));
    await openSoundboard();

    apiFetch.mockResolvedValueOnce(response(200, page([])));
    const search = document.getElementById('soundboard-search') as HTMLInputElement;
    search.value = 'air horn';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('[data-soundboard-action="clear-search"]')).toHaveProperty('hidden', false);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(apiFetch).toHaveBeenLastCalledWith(expect.stringContaining('q=air+horn'));
    expect(document.getElementById('soundboard-status')?.textContent).toContain('eşleşen');

    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    (document.querySelector('[data-soundboard-action="clear-search"]') as HTMLButtonElement).click();
    await flush();
    expect(apiFetch).toHaveBeenLastCalledWith(expect.not.stringContaining('q='));
    expect(search.value).toBe('');
    expect(document.activeElement).toBe(search);
    expect(document.querySelector('[data-soundboard-action="clear-search"]')).toHaveProperty('hidden', true);

    apiFetch.mockResolvedValueOnce(response(200, page([])));
    (document.querySelector('[data-soundboard-category="favorites"]') as HTMLButtonElement).click();
    await flush();
    expect(apiFetch).toHaveBeenLastCalledWith(expect.stringContaining('scope=favorites'));
    expect(document.querySelector('[data-soundboard-category="favorites"]')).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('[data-soundboard-category="favorites"]')).toHaveAttribute('aria-controls', 'soundboard-library');
    expect(document.getElementById('soundboard-library')).toHaveAttribute('aria-labelledby', 'soundboard-tab-favorites');
  });

  it('shows retryable errors and ignores a stale request after the popup closes', async () => {
    apiFetch.mockResolvedValueOnce(response(503, { error: 'Temporarily offline' }));
    await openSoundboard();
    expect(document.getElementById('soundboard-status')?.textContent).toContain('Sunucu hatası');
    expect(document.getElementById('soundboard-status')?.textContent).not.toContain('Temporarily offline');
    expect(document.querySelector('[data-soundboard-action="retry"]')).not.toBeNull();
    closeSoundboardPanel();

    let resolveRequest!: (value: Response) => void;
    apiFetch.mockReturnValueOnce(new Promise(resolve => { resolveRequest = resolve; }));
    const opening = openSoundboard();
    closeSoundboardPanel();
    resolveRequest(response(200, page([sound(1)])));
    await opening;
    expect(document.getElementById('soundboard-panel')).toBeNull();
  });

  it('renders locked sounds as disabled and uses arrow/Home/End grid navigation', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2), sound(3, { locked: true })])));
    await openSoundboard();
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sound-btn'));
    expect(buttons[2]).toBeDisabled();
    expect(buttons[2]).toHaveAttribute('aria-label', expect.stringContaining('kilitli'));
    buttons[0].focus(); buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(buttons[1]);
    buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);

    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.soundboard-category'));
    tabs[0].focus(); tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(tabs.at(-1));
    tabs.at(-1)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(tabs.at(-1));
    tabs.at(-1)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]);
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('normalizes legacy arrays, malformed metadata, defaults and durable local usage safely', async () => {
    expect(await refreshSoundboard()).toBe(false);
    localStorage.setItem('bridge.soundboard.usage.v1.s1', JSON.stringify({ 'snd-9': { count: 7, lastPlayedAt: 1234 } }));
    apiFetch.mockResolvedValueOnce(response(200, [
      null, {}, { _id: 'missing-fields' },
      sound(9, { emoji: '', category: 'Memes', playCount: 0, lastPlayedAt: 0 }),
      sound(10, { scope: 'global', category: '', favorite: true, playCount: 4, canPlay: false }),
    ]));
    await openSoundboard();
    expect(document.querySelectorAll('.sound-btn')).toHaveLength(2);
    expect(document.querySelectorAll('.sound-emoji')[0]?.textContent).toBe('🔊');
    expect(document.querySelectorAll('.sound-meta')[0]?.textContent).toBe('Memes · 7×');
    expect(document.querySelectorAll('.sound-meta')[1]?.textContent).toBe('Bridge · 4×');
    expect(document.querySelectorAll<HTMLButtonElement>('.sound-btn')[1]).toBeDisabled();
    expect(document.querySelectorAll('[data-soundboard-action="favorite"]')[1]).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('[data-soundboard-action="open-upload"]')).toHaveProperty('hidden', true);
  });

  it('debounces typed search, controls local presentation settings and covers every grid direction', async () => {
    vi.useFakeTimers();
    try {
      apiFetch.mockResolvedValueOnce(response(200, page(Array.from({ length: 8 }, (_, index) => sound(index)))));
      await openSoundboard();
      const search = document.getElementById('soundboard-search') as HTMLInputElement;
      search.value = 'pop';
      apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
      search.dispatchEvent(new Event('input', { bubbles: true }));
      expect(apiFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(251);
      expect(apiFetch).toHaveBeenCalledTimes(2);
      await runSoundboardSearch('pop');
      expect(apiFetch).toHaveBeenCalledTimes(2); // identical normalized search is a no-op

      const volume = document.getElementById('soundboard-volume') as HTMLInputElement;
      volume.value = '25'; volume.dispatchEvent(new Event('input', { bubbles: true }));
      expect(volume).toHaveAttribute('aria-valuetext', '25%');
      const mute = document.querySelector('[data-soundboard-action="mute"]') as HTMLButtonElement;
      expect(mute).toHaveAttribute('aria-label', expect.stringContaining('kapat'));
      mute.click(); expect(mute).toHaveAttribute('aria-pressed', 'true');
      expect(mute).toHaveAttribute('aria-label', expect.stringContaining('aç'));
      mute.click(); expect(mute).toHaveAttribute('aria-pressed', 'false');

      // Re-render the full grid after clearing search, then exercise vertical and edge keys.
      apiFetch.mockResolvedValueOnce(response(200, page(Array.from({ length: 8 }, (_, index) => sound(index)))));
      await runSoundboardSearch('');
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sound-btn'));
      buttons[4].focus();
      for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'End']) {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
      expect(document.activeElement).toBe(buttons.at(-1));
    } finally { vi.useRealTimers(); }
  });

  it('executes delegated rail, retry, pagination and close controls without dead UI', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    const calls = apiFetch.mock.calls.length;
    (document.querySelector('[data-soundboard-category="all"]') as HTMLButtonElement).click();
    expect(apiFetch).toHaveBeenCalledTimes(calls); // already-selected tab is stable

    for (const category of ['favorites', 'recent', 'frequent', 'global'] as const) {
      apiFetch.mockResolvedValueOnce(response(200, page([])));
      (document.querySelector(`[data-soundboard-category="${category}"]`) as HTMLButtonElement).click();
      await flush();
      expect(apiFetch).toHaveBeenLastCalledWith(expect.stringContaining(`scope=${category}`));
    }
    expect(document.getElementById('soundboard-status')?.textContent).toContain('Bridge');

    // Disabled page controls can still receive synthetic/assistive events; handlers remain harmless.
    (document.querySelector('[data-soundboard-action="previous"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (document.querySelector('[data-soundboard-action="next"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    (document.querySelector('[data-soundboard-action="close"]') as HTMLButtonElement).click();
    expect(document.getElementById('soundboard-panel')).toBeNull();
    apiFetch.mockResolvedValueOnce(response(500, { error: 'retry me' }));
    await openSoundboard();
    apiFetch.mockResolvedValueOnce(response(200, page([sound(2)])));
    (document.querySelector('[data-soundboard-action="retry"]') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('.sound-name')?.textContent).toBe('Sound 2');
    await openSoundboard(); // public opener is an intentional toggle
    expect(document.getElementById('soundboard-panel')).toBeNull();
  });

  it('keeps cursor history stable on failed navigation and handles malformed/error bodies', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)], { nextCursor: 'next' })));
    await openSoundboard();
    apiFetch.mockResolvedValueOnce(response(500, { error: 'page failed' }));
    (document.querySelector('[data-soundboard-action="next"]') as HTMLButtonElement).click();
    await flush();
    expect(document.getElementById('soundboard-page-label')?.textContent).toContain('1.');
    closeSoundboardPanel();

    // `openSoundboard()` paneli MONTE eder; yukleme hatasinin duruma yazilmasi
    // bir sonraki mikro gorevde tamamlanir. `flush()` olmadan bu iddialar bir
    // ONCEKI kosunun durum metnini okuyordu (olculdu: 500 sayfa hatasindan
    // kalan "Sunucu hatasi..." metni).
    const invalidJson = { ok: false, json: vi.fn(async () => { throw new Error('bad json'); }) } as unknown as Response;
    apiFetch.mockResolvedValueOnce(invalidJson);
    await openSoundboard();
    await flush();
    // Durum kodu OLMAYAN bir yanit siniflandirilamaz: cagiranin yedek metni.
    expect(document.getElementById('soundboard-status')?.textContent).toContain('yüklenemedi');
    closeSoundboardPanel();

    apiFetch.mockResolvedValueOnce(response(500, { error: 42 }));
    await openSoundboard();
    await flush();
    // 500 kanonik sunucu hatasi metnine eslenir; sunucunun govdesi kullanilmaz.
    expect(document.getElementById('soundboard-status')?.textContent).toContain(t('error_server'));
    closeSoundboardPanel();

    apiFetch.mockRejectedValueOnce('not-an-error');
    await openSoundboard();
    await flush();
    expect(document.getElementById('soundboard-status')?.textContent).toContain('yüklenemedi');
    closeSoundboardPanel();

    apiFetch.mockResolvedValueOnce(response(200, { items: 'not-an-array', nextCursor: 123, canManage: 'yes' }));
    await openSoundboard();
    expect(document.querySelectorAll('.sound-btn')).toHaveLength(0);
  });

  it('routes click/input/keyboard edge events without accidental playback or requests', async () => {
    vi.useFakeTimers();
    try {
      document.querySelector('.chat-area')?.remove(); // body fallback is a supported shell state
      apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2)])));
      await openSoundboard();
      expect(document.getElementById('soundboard-panel')?.parentElement).toBe(document.body);
      const panel = document.getElementById('soundboard-panel')!;
      panel.querySelector('.soundboard-header')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(AudioStub.instances).toHaveLength(0);

      const search = document.getElementById('soundboard-search') as HTMLInputElement;
      search.value = 'first'; search.dispatchEvent(new Event('input', { bubbles: true }));
      search.value = 'second'; search.dispatchEvent(new Event('input', { bubbles: true }));
      apiFetch.mockResolvedValueOnce(response(200, page([sound(2)])));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      expect(apiFetch).toHaveBeenLastCalledWith(expect.stringContaining('q=second'));

      const fake = document.createElement('div'); fake.className = 'sound-btn'; panel.append(fake); fake.focus();
      fake.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const locked = document.createElement('button'); locked.className = 'sound-btn'; locked.disabled = true; panel.append(locked);
      locked.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      (document.querySelector('.sound-btn') as HTMLButtonElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));

      vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
      (document.querySelector('.sound-btn') as HTMLButtonElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

      // Delegated play and missing-id favorite paths.
      await Promise.resolve();
      (document.querySelector('.sound-btn') as HTMLButtonElement)?.click(); await Promise.resolve();
      const missing = document.createElement('button'); missing.dataset.soundboardAction = 'favorite'; panel.append(missing); missing.click();
      missing.dataset.soundId = 'does-not-exist'; missing.click();
      const manageMissing = document.createElement('button'); manageMissing.dataset.soundboardAction = 'manage'; panel.append(manageMissing); manageMissing.click();
      const playMissing = document.createElement('button'); playMissing.dataset.soundboardAction = 'play'; panel.append(playMissing); playMissing.click();
      const unrelated = document.createElement('input'); panel.append(unrelated); unrelated.dispatchEvent(new Event('input', { bubbles: true }));
      panel.firstChild?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } finally { vi.useRealTimers(); }
  });

  it('keeps settings and rendering safe across missing optional chrome and storage fallbacks', async () => {
    localStorage.setItem('bridge.soundboard.usage.v1.s1', 'null');
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    for (const selector of [
      '[data-soundboard-action="open-upload"]', '[data-soundboard-action="previous"]',
      '[data-soundboard-action="next"]', '#soundboard-page-label',
    ]) document.querySelector(selector)?.remove();
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await runSoundboardSearch('rerender');

    vi.stubGlobal('API', '');
    setSoundboardMuted(true); playSound('snd-1'); await flush();
    setSoundboardVolume(0.6);
    expect(AudioStub.instances.at(-1)?.volume).toBe(0);
    setSoundboardMuted(false); setSoundboardVolume(0.7);
    expect(AudioStub.instances.at(-1)?.volume).toBe(0.7);

    const remoteSocket = new FakeSocket(); initSoundboardSocket(remoteSocket);
    remoteSocket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'remote-settings', soundUrl: '/remote.ogg' });
    setSoundboardMuted(true); setSoundboardVolume(0.3);
    setSoundboardMuted(false); setSoundboardVolume(0.4);
    expect(AudioStub.instances.at(-1)?.volume).toBe(0.4);
  });
});

describe('soundboard persistence, management and upload', () => {
  it('persists favorite changes and rolls optimistic state back on failure', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    apiFetch.mockResolvedValueOnce(response(204, {}));
    (document.querySelector('[data-soundboard-action="favorite"]') as HTMLButtonElement).click();
    await flush();
    expect(apiFetch).toHaveBeenLastCalledWith('https://bridge.test/api/servers/s1/soundboard/snd-1/favorite', { method: 'PUT' });
    expect(document.querySelector('[data-soundboard-action="favorite"]')).toHaveAttribute('aria-pressed', 'true');

    apiFetch.mockResolvedValueOnce(response(500, { error: 'DB unavailable' }));
    (document.querySelector('[data-soundboard-action="favorite"]') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('[data-soundboard-action="favorite"]')).toHaveAttribute('aria-pressed', 'true');
    // Sunucunun `error` govdesi kullaniciya ULASMAZ: 500 kanonik metne eslenir.
    expect(toast).toHaveBeenCalledWith(t('error_server'), 'error');
    expect(toast).not.toHaveBeenCalledWith('DB unavailable', 'error');

    apiFetch.mockRejectedValueOnce('offline');
    (document.querySelector('[data-soundboard-action="favorite"]') as HTMLButtonElement).click();
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Favori'), 'error');
  });

  it('fails manage UI closed for members and supports rename/delete for managers', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)], { canManage: false })));
    await openSoundboard();
    expect(document.querySelector('[data-soundboard-action="open-upload"]')).toHaveProperty('hidden', true);
    expect(document.querySelector('[data-soundboard-action="manage"]')).toBeNull();
    openSoundUpload();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('iznin'), 'error');
    closeSoundboardPanel();

    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)], { canManage: true })));
    await openSoundboard();
    (document.querySelector('[data-soundboard-action="manage"]') as HTMLButtonElement).click();
    expect(document.getElementById('sound-manage-modal')).not.toBeNull();
    (document.getElementById('sound-rename-input') as HTMLInputElement).value = 'Renamed';
    (document.getElementById('sound-rename-category') as HTMLInputElement).value = 'Memes';
    apiFetch.mockResolvedValueOnce(response(200, sound(1, { name: 'Renamed' })));
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1, { name: 'Renamed' })], { canManage: true })));
    (document.querySelector('[data-sound-manage-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(apiFetch).toHaveBeenNthCalledWith(3, 'https://bridge.test/api/servers/s1/soundboard/snd-1', expect.objectContaining({ method: 'PATCH' }));
    expect(JSON.parse(apiFetch.mock.calls[2]?.[1]?.body as string)).toEqual(expect.objectContaining({ name: 'Renamed', category: 'Memes' }));
    expect(document.querySelector('.sound-name')?.textContent).toBe('Renamed');

    (document.querySelector('[data-soundboard-action="manage"]') as HTMLButtonElement).click();
    apiFetch.mockResolvedValueOnce(response(204, {}));
    apiFetch.mockResolvedValueOnce(response(200, page([], { canManage: true })));
    (document.querySelector('[data-sound-manage-action="delete"]') as HTMLButtonElement).click();
    // Silme onayi `window.confirm` degil, gercek urun diyalogudur; surulmezse
    // istek HIC gonderilmez.
    await chooseProductDialog('confirm');
    expect(apiFetch).toHaveBeenCalledWith('https://bridge.test/api/servers/s1/soundboard/snd-1', { method: 'DELETE' });
  });

  it('validates previews/uploads, prevents duplicate submits and revokes blob URLs', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([], { canManage: true })));
    await openSoundboard();
    openSoundUpload();
    const input = document.getElementById('sound-file-input') as HTMLInputElement;
    expect(input.accept).toContain('audio/aac');
    expect(input.accept).toContain('audio/flac');
    expect(input.accept).not.toContain('audio/mp4');
    await uploadSound();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Dosya seç'), 'error');

    const invalid = new File(['x'], 'script.html', { type: 'text/html' });
    Object.defineProperty(input, 'files', { configurable: true, value: [invalid] });
    await uploadSound();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Desteklenen'), 'error');

    const file = new File(['sound'], 'airhorn.ogg', { type: 'audio/ogg' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect((document.getElementById('sound-name-input') as HTMLInputElement).value).toBe('airhorn');
    expect(document.getElementById('sound-preview')).not.toHaveAttribute('hidden');
    expect(document.querySelector('#sound-upload-modal [onclick], #sound-upload-modal [onchange]')).toBeNull();

    let resolveUpload!: (value: Response) => void;
    apiFetch.mockReturnValueOnce(new Promise(resolve => { resolveUpload = resolve; }));
    const first = uploadSound(); const duplicate = uploadSound();
    expect(apiFetch).toHaveBeenCalledTimes(2); // initial page + exactly one upload
    expect((apiFetch.mock.calls[1]?.[1]?.body as FormData).get('category')).toBe('Server');
    const pendingModal = document.getElementById('sound-upload-modal') as HTMLElement;
    openSoundUpload();
    pendingModal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('sound-upload-modal')).toBe(pendingModal);
    resolveUpload(response(201, sound(2)));
    apiFetch.mockResolvedValueOnce(response(200, page([sound(2)], { canManage: true })));
    await Promise.all([first, duplicate]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bridge-sound');
    expect(document.getElementById('sound-upload-modal')).toBeNull();
  });

  it('keeps upload modal keyboard-safe and surfaces size, name, API and transport failures', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([], { canManage: true })));
    await openSoundboard();
    const uploadTrigger = document.querySelector('[data-soundboard-action="open-upload"]') as HTMLButtonElement;
    uploadTrigger.focus(); uploadTrigger.click();
    const modal = document.getElementById('sound-upload-modal') as HTMLElement;
    expect(modal).toHaveAttribute('aria-modal', 'true');
    previewSoundFile(document.createElement('input')); // an empty selection is harmless

    const firstControl = document.getElementById('sound-file-input') as HTMLInputElement;
    const lastControl = document.querySelector('[data-sound-upload-action="upload"]') as HTMLButtonElement;
    uploadTrigger.focus(); modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(firstControl);
    firstControl.focus(); modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(lastControl);
    modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(firstControl);

    const input = document.getElementById('sound-file-input') as HTMLInputElement;
    const oversized = new File(['x'], 'huge.ogg', { type: 'audio/ogg' });
    Object.defineProperty(oversized, 'size', { configurable: true, value: 5 * 1024 * 1024 + 1 });
    Object.defineProperty(input, 'files', { configurable: true, value: [oversized] });
    await uploadSound();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('5 MB'), 'error');

    const valid = new File(['x'], 'valid.ogg', { type: 'audio/ogg' });
    Object.defineProperty(input, 'files', { configurable: true, value: [valid] });
    (document.getElementById('sound-name-input') as HTMLInputElement).value = '';
    await uploadSound();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('İsim'), 'error');
    (document.getElementById('sound-name-input') as HTMLInputElement).value = 'Valid';
    apiFetch.mockResolvedValueOnce(response(429, { error: 'Too many uploads' }));
    await uploadSound();
    expect(toast).toHaveBeenCalledWith(t('error_ratelimit'), 'error');
    expect(toast).not.toHaveBeenCalledWith('Too many uploads', 'error');
    // §12: apiFetch REDDİ (ağ hatası) bir iç istisnadır; ham `.message`
    // kullanıcıya GÖSTERİLMEZ — güvenli genel metin gösterilir.
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    await uploadSound();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Yüklen'), 'error');

    (modal.querySelector('.soundboard-form-card') as HTMLElement).click();
    expect(document.getElementById('sound-upload-modal')).toBe(modal);
    modal.replaceChildren();
    expect(() => modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))).not.toThrow();
    modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(document.getElementById('sound-upload-modal')).toBeNull();
    expect(document.activeElement).toBe(uploadTrigger);
  });

  it('validates management input, honors delete cancellation and reports PATCH/DELETE failures', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)], { canManage: true })));
    await openSoundboard();
    const manage = document.querySelector('[data-soundboard-action="manage"]') as HTMLButtonElement;
    manage.click();
    (document.getElementById('sound-rename-input') as HTMLInputElement).value = '';
    (document.querySelector('[data-sound-manage-action="save"]') as HTMLButtonElement).click();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('İsim'), 'error');

    (document.getElementById('sound-rename-input') as HTMLInputElement).value = 'Name';
    apiFetch.mockResolvedValueOnce(response(400, { error: 'Invalid emoji' }));
    (document.querySelector('[data-sound-manage-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('İstek geçersiz'), 'error');
    expect(toast).not.toHaveBeenCalledWith('Invalid emoji', 'error');
    apiFetch.mockRejectedValueOnce('patch offline');
    (document.querySelector('[data-sound-manage-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('güncellenemedi'), 'error');

    (document.querySelector('[data-sound-manage-action="delete"]') as HTMLButtonElement).click();
    await chooseProductDialog('cancel');
    expect(apiFetch).toHaveBeenCalledTimes(3);

    // §12: reddedilen fetch'in ham mesajı gösterilmez; güvenli metin gösterilir.
    apiFetch.mockRejectedValueOnce(new Error('delete offline'));
    (document.querySelector('[data-sound-manage-action="delete"]') as HTMLButtonElement).click();
    await chooseProductDialog('confirm');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('silin'), 'error');

    apiFetch.mockResolvedValueOnce(response(500, { error: 'delete denied' }));
    (document.querySelector('[data-sound-manage-action="delete"]') as HTMLButtonElement).click();
    await chooseProductDialog('confirm');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Sunucu hatası'), 'error');
    expect(toast).not.toHaveBeenCalledWith('delete denied', 'error');

    (document.getElementById('sound-manage-modal') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(document.getElementById('sound-manage-modal')).toBeNull();
  });

  it('delegates upload buttons and dismisses both modal kinds through their accessible owners', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)], { canManage: true })));
    await openSoundboard();
    (document.querySelector('[data-soundboard-action="open-upload"]') as HTMLButtonElement).click();
    const uploadModal = document.getElementById('sound-upload-modal') as HTMLElement;
    uploadModal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('sound-upload-modal')).toBeNull();

    openSoundUpload();
    (document.querySelector('[data-sound-upload-action="close"]') as HTMLButtonElement).click();
    expect(document.getElementById('sound-upload-modal')).toBeNull();

    (document.querySelector('[data-soundboard-action="manage"]') as HTMLButtonElement).click();
    const manageModal = document.getElementById('sound-manage-modal') as HTMLElement;
    manageModal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('sound-manage-modal')).toBeNull();

    (document.querySelector('[data-soundboard-action="manage"]') as HTMLButtonElement).click();
    (document.querySelector('[data-sound-manage-action="close"]') as HTMLButtonElement).click();
    expect(document.getElementById('sound-manage-modal')).toBeNull();

    openSoundUpload();
    expect(document.getElementById('sound-upload-modal')).not.toBeNull();
    closeSoundboardPanel();
    expect(document.getElementById('sound-upload-modal')).toBeNull();
  });

  it('handles repeated upload opening, delegated submit, replacement previews and absent preview DOM', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([], { canManage: true })));
    await openSoundboard();
    openSoundUpload(); openSoundUpload();
    document.getElementById('sound-upload-modal')?.dispatchEvent(new Event('change', { bubbles: true }));
    const input = document.getElementById('sound-file-input') as HTMLInputElement;
    const first = new File(['one'], 'one.ogg', { type: 'audio/ogg' });
    Object.defineProperty(input, 'files', { configurable: true, value: [first] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const second = new File(['two'], 'two.ogg', { type: 'audio/ogg' });
    Object.defineProperty(input, 'files', { configurable: true, value: [second] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(URL.revokeObjectURL).toHaveBeenCalled();

    (document.getElementById('sound-name-input') as HTMLInputElement).value = 'Two';
    apiFetch.mockResolvedValueOnce(response(201, sound(2)));
    apiFetch.mockResolvedValueOnce(response(200, page([sound(2)], { canManage: true })));
    (document.querySelector('[data-sound-upload-action="upload"]') as HTMLButtonElement).click();
    await flush();
    expect(document.getElementById('sound-upload-modal')).toBeNull();

    const detached = document.createElement('input');
    Object.defineProperty(detached, 'files', { configurable: true, value: [first] });
    expect(() => previewSoundFile(detached)).not.toThrow();
  });

  it('uses optional upload defaults and remains safe if form controls disappear during a shell remount', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([], { canManage: true })));
    await openSoundboard(); openSoundUpload();
    const input = document.getElementById('sound-file-input') as HTMLInputElement;
    const file = new File(['one'], 'one.ogg', { type: 'audio/ogg' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    document.getElementById('sound-name-input')?.remove();
    await uploadSound();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('İsim'), 'error');

    closeSoundboardPanel();
    apiFetch.mockResolvedValueOnce(response(200, page([], { canManage: true })));
    await openSoundboard(); openSoundUpload();
    const input2 = document.getElementById('sound-file-input') as HTMLInputElement;
    Object.defineProperty(input2, 'files', { configurable: true, value: [file] });
    (document.getElementById('sound-name-input') as HTMLInputElement).value = 'One';
    document.getElementById('sound-emoji-input')?.remove();
    document.querySelector('[data-sound-upload-action="upload"]')?.remove();
    apiFetch.mockResolvedValueOnce(response(201, sound(1)));
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)], { canManage: true })));
    await uploadSound();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('eklendi'), 'success');
  });
});

describe('soundboard playback, preferences and realtime lifecycle', () => {
  it('plays lazily, broadcasts only after playback starts and cleans repeated local ownership', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    expect(AudioStub.instances).toHaveLength(0);
    playSound('snd-1'); await flush();
    expect(AudioStub.instances[0].src).toBe('https://bridge.test/sound-1.ogg');
    expect(AudioStub.instances[0].volume).toBe(0.8);
    expect(socketEmit).toHaveBeenCalledWith('soundboard:play', { channelId: 'voice-1', soundId: 'snd-1' });
    expect(document.querySelector('.sound-btn')).toHaveClass('playing');

    playSound('snd-1'); await flush();
    expect(AudioStub.instances[0].pause).toHaveBeenCalled();
    stopSoundboard();
    expect(AudioStub.instances[1].pause).toHaveBeenCalled();
    expect(document.querySelector('.sound-btn')).not.toHaveClass('playing');
  });

  it('rejects hostile URLs and lazily synthesizes trusted built-in sounds', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([
      sound(1, { url: 'https://attacker.example/a.mp3' }),
      sound(2, { _id: 'global:chime', url: 'bridge-sound:chime', scope: 'global' }),
      sound(3, { url: 'bridge-sound:not-whitelisted' }),
    ])));
    await openSoundboard();
    playSound('snd-1');
    expect(AudioStub.instances).toHaveLength(0);
    playSound('global:chime'); await flush();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(AudioStub.instances[0].src).toBe('blob:bridge-sound');
    AudioStub.instances[0].onended?.();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bridge-sound');
    playSound('snd-3');
    expect(AudioStub.instances).toHaveLength(1);
  });

  it('contains rejected/stale local playback and never broadcasts outside canonical voice ownership', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2), sound(3, { locked: true })])));
    await openSoundboard();
    playSound('missing'); playSound('snd-3');
    expect(AudioStub.instances).toHaveLength(0);

    AudioStub.playImpl.mockRejectedValueOnce(new Error('autoplay denied'));
    playSound('snd-1'); await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('oynatılamadı'), 'error');
    expect(socketEmit).not.toHaveBeenCalled();

    rtc.isInVoice.mockReturnValue(false);
    playSound('snd-1'); await flush();
    expect(socketEmit).not.toHaveBeenCalled();
    rtc.isInVoice.mockReturnValue(true);
    BridgeRegistry.unregister('socket');
    playSound('snd-1'); await flush();
    expect(socketEmit).not.toHaveBeenCalled();

    let resolveFirst!: () => void;
    AudioStub.playImpl.mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirst = resolve; })).mockResolvedValueOnce(undefined);
    BridgeRegistry.register('socket', { emit: socketEmit } as never);
    playSound('snd-1'); playSound('snd-2'); await flush();
    resolveFirst(); await flush();
    expect(AudioStub.instances.at(-2)?.pause).toHaveBeenCalled();
    expect(socketEmit).toHaveBeenCalledTimes(1);
    AudioStub.instances.at(-1)?.onerror?.();
  });

  it('contains late completion/rejection when newer playback owns the UI and tolerates metadata refresh', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2)])));
    await openSoundboard();
    let resolveOld!: () => void;
    AudioStub.playImpl.mockImplementationOnce(() => new Promise<void>(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(undefined);
    playSound('snd-1'); const old = AudioStub.instances.at(-1)!;
    playSound('snd-2'); await flush();
    old.onended?.(); resolveOld(); await flush();
    expect(document.querySelector('[data-sound-id="snd-2"] .sound-btn, .sound-btn[data-sound-id="snd-2"]')).toBeTruthy();

    let rejectOld!: (reason: unknown) => void;
    AudioStub.playImpl.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; })).mockResolvedValueOnce(undefined);
    playSound('snd-1'); playSound('snd-2'); await flush();
    rejectOld('late rejection'); await flush();

    let resolveAfterRefresh!: () => void;
    AudioStub.playImpl.mockImplementationOnce(() => new Promise<void>(resolve => { resolveAfterRefresh = resolve; }));
    playSound('snd-1');
    apiFetch.mockResolvedValueOnce(response(200, page([sound(2)])));
    await runSoundboardSearch('new page');
    resolveAfterRefresh(); await flush();
    expect(socketEmit).toHaveBeenCalled();
  });

  it('applies volume/mute/suppression, attribution, replay guard and a hard concurrent cap', async () => {
    const socket = new FakeSocket(); initSoundboardSocket(socket);
    setSoundboardVolume(0.35); setSoundboardMuted(true);
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'one', soundUrl: '/one.ogg' });
    expect(AudioStub.instances).toHaveLength(0);

    setSoundboardMuted(false); setSoundboardUserSuppressed('u1', true);
    expect(isSoundboardUserSuppressed('u1')).toBe(true);
    expect(isSoundboardUserSuppressed('')).toBe(false);
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'one', soundUrl: '/one.ogg', playedBy: { id: 'u1', displayName: 'Muted User' } });
    expect(AudioStub.instances).toHaveLength(0);
    setSoundboardUserSuppressed('u1', false);
    expect(isSoundboardUserSuppressed('u1')).toBe(false);
    const payload = { channelId: 'voice-1', soundId: 'one', soundUrl: '/one.ogg', soundName: 'One', emoji: '🎵', playedBy: { id: 'u1', displayName: 'Ada' } };
    socket.emitLocal('soundboard:play', payload); socket.emitLocal('soundboard:play', payload);
    expect(AudioStub.instances).toHaveLength(1);
    expect(AudioStub.instances[0].volume).toBe(0.35);
    expect(toast).toHaveBeenCalledWith('🎵 One · Ada', 'info');

    for (let index = 2; index <= 7; index += 1) socket.emitLocal('soundboard:play', { ...payload, soundId: `sound-${index}`, soundUrl: `/sound-${index}.ogg` });
    expect(AudioStub.instances[0].pause).toHaveBeenCalled();
    stopSoundboard();
    const paused = AudioStub.instances.filter(instance => instance.pause.mock.calls.length > 0);
    expect(paused.length).toBeGreaterThanOrEqual(AudioStub.instances.length - SOUNDBOARD_MAX_REMOTE_PLAYBACKS);
  });

  it('binds one listener set, removes stale sockets and resyncs matching mutations/reconnects', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    const first = new FakeSocket(); initSoundboardSocket(first);
    expect(first.on).toHaveBeenCalledTimes(9);
    initSoundboardSocket(first);
    expect(first.on).toHaveBeenCalledTimes(9);

    const second = new FakeSocket(); const cleanup = initSoundboardSocket(second);
    expect(first.off).toHaveBeenCalledTimes(9);
    second.emitLocal('soundboard:created', { serverId: 'other', sound: sound(2) });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2)])));
    second.emitLocal('soundboard:created', { serverId: 's1', sound: sound(2) });
    await flush();
    expect(document.querySelectorAll('.sound-btn')).toHaveLength(2);
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2)])));
    second.emitLocal('connect'); await flush();
    expect(apiFetch).toHaveBeenCalledTimes(3);
    second.emitLocal('permissions:updated', { serverId: 's1', channelId: 'other-voice' });
    second.emitLocal('role:granted', { serverId: 'other' });
    expect(apiFetch).toHaveBeenCalledTimes(3);
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1, { locked: true })])));
    second.emitLocal('permissions:updated', { serverId: 's1', channelId: 'voice-1' });
    await flush();
    expect(document.querySelector('.sound-btn')).toBeDisabled();
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    second.emitLocal('role:revoked', { serverId: 's1' });
    await flush();
    expect(document.querySelector('.sound-btn')).not.toBeDisabled();
    expect(apiFetch).toHaveBeenCalledTimes(5);
    cleanup(); expect(second.off).toHaveBeenCalledTimes(9);
  });

  it('drops malformed/wrong-room/unsafe remote events and handles fallback attribution plus media failures', async () => {
    const socket = new FakeSocket(); initSoundboardSocket(socket);
    socket.emitLocal('soundboard:play', null);
    socket.emitLocal('soundboard:play', { channelId: 'other', soundUrl: '/one.ogg' });
    rtc.isInVoice.mockReturnValue(false);
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundUrl: '/one.ogg' });
    rtc.isInVoice.mockReturnValue(true);
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'bad', soundUrl: 'data:audio/mp3;base64,AA==' });
    expect(AudioStub.instances).toHaveLength(0);

    AudioStub.playImpl.mockRejectedValueOnce(new Error('blocked'));
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'fallback', soundUrl: '/fallback.ogg', playedByName: 'Grace' });
    await flush();
    expect(toast).toHaveBeenCalledWith('🔊 Ses Panosu · Grace', 'info');
    expect(AudioStub.instances).toHaveLength(1);

    socket.emitLocal('soundboard:updated', null);
    socket.emitLocal('soundboard:deleted', { serverId: 'other' });
  });

  it('cleans remote completion/error callbacks and resynchronizes from canonical socket-ready signals', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    const socket = new FakeSocket();
    BridgeRegistry.register('socket', socket as never);
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(socket.on).toHaveBeenCalledTimes(9);
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2)])));
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await flush();
    expect(document.querySelectorAll('.sound-btn')).toHaveLength(2);

    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'end', soundUrl: '/end.ogg' });
    const ended = AudioStub.instances.at(-1)!;
    ended.onended?.();
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'error', soundUrl: '/error.ogg' });
    AudioStub.instances.at(-1)?.onerror?.();

    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    socket.emitLocal('soundboard:updated', { sound: sound(1) }); // missing serverId means current room
    await flush();
    socket.emitLocal('soundboard:updated', null); // malformed mutation is ignored
    BridgeRegistry.unregister('socket');
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
  });

  it('degrades safely when browser storage and object-URL facilities fail', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    expect(() => setSoundboardVolume(Number.NaN)).not.toThrow();
    expect(() => setSoundboardUserSuppressed('', true)).not.toThrow();
    setItem.mockRestore();

    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2, { _id: 'global:pop', url: 'bridge-sound:pop', scope: 'global' })])));
    await openSoundboard();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2, { _id: 'global:pop', url: 'bridge-sound:pop', scope: 'global' })])));
    await runSoundboardSearch('storage');
    getItem.mockRestore();

    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => { throw new Error('blob blocked'); });
    playSound('global:pop');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('oynatılamadı'), 'error');
  });

  it('updates active local/remote playback volume immediately and makes cleanup idempotent', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    playSound('snd-1'); await flush();
    setSoundboardMuted(true);
    setSoundboardVolume(5);
    expect(AudioStub.instances[0].volume).toBe(0);
    setSoundboardMuted(false);
    expect(AudioStub.instances[0].volume).toBe(1);

    const socket = new FakeSocket(); initSoundboardSocket(socket);
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'remote-volume', soundUrl: '/remote.ogg' });
    const remote = AudioStub.instances.at(-1)!;
    setSoundboardMuted(true); setSoundboardVolume(0.4);
    expect(remote.volume).toBe(0);
    setSoundboardMuted(false); expect(remote.volume).toBe(0.4);
    remote.onended?.(); remote.onended?.();
    stopSoundboard(); stopSoundboard();
  });

  it('bounds replay bookkeeping across many unique events and accepts every attribution compatibility field', async () => {
    const socket = new FakeSocket(); initSoundboardSocket(socket);
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundUrl: '/anonymous.ogg' });
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'legacy-user', soundUrl: '/legacy.ogg', playedByUserId: 'legacy', playedByName: 'Legacy' });
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'underscore', soundUrl: '/underscore.ogg', playedBy: { _id: 'under', displayName: 'Under' } });
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'builtin', soundUrl: 'bridge-sound:notify', soundName: 'Notify' });
    for (let index = 0; index < 105; index += 1) {
      socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: `unique-${index}`, soundUrl: `/u-${index}.ogg`, playedBy: { id: `u-${index}` } });
    }
    expect(AudioStub.instances.length).toBeGreaterThan(100);
    expect(AudioStub.instances[0].pause).toHaveBeenCalled();
  });
});
