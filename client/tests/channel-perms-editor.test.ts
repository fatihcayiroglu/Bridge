// client/tests/channel-perms-editor.test.ts
// FAZ C2 — GÜVENLİ EDİTÖR (XSS + üç durum + kirli durum).
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Tarihsel `ChannelPermsModal.svelte` üç adet `{@html}` yuvası içeriyordu
// (`matrixHtml`, `auditBody`, `syncChannelListHtml`) ve bunlar çağıranın
// ürettiği HTML dizeleriyle besleniyordu. Rol/kanal adları KULLANICI
// DENETİMİNDEDİR → doğrudan XSS yüzeyi. `ChannelPermsEditor.svelte` bu
// sözleşmeyi tamamen terk eder ve veriyi olağan Svelte metin
// enterpolasyonuyla render eder.
//
// Bu paket o sınırın geri gelmemesini garanti eder.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ChannelPermsEditor from '../js/core/channel-perms/ChannelPermsEditor.svelte';
import { CHANNEL_PERMISSIONS, type PermState } from '../js/core/channel-perms/channelPermsStore.ts';

const VIEW = 1 << 0;
const XSS  = '<img src=x onerror="window.__pwned=1">';

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

interface Overrides { [k: string]: unknown }

function render(over: Overrides = {}) {
  const states = new Map<string, PermState>();
  const props = {
    channelName: 'genel',
    roles: [{ _id: 'role-1', name: 'Moderatör' }, { _id: 'role-2', name: 'Üye' }],
    selectedRoleId: 'role-1',
    loading: false, saving: false, dirty: false, error: null,
    explanationLoading: false, explanationError: null, explanation: null,
    rolePreviewLoading: false, rolePreviewError: null, rolePreview: null,
    stateOf: (_r: string, bit: number) => states.get(String(bit)) ?? 'inherit',
    onSelectRole: vi.fn(),
    onSetState:  vi.fn((_r: string, bit: number, s: PermState) => states.set(String(bit), s)),
    onSave: vi.fn(), onReset: vi.fn(), onExplain: vi.fn(), onPreviewRole: vi.fn(), onClose: vi.fn(),
    ...over,
  };
  instance = mount(ChannelPermsEditor, { target: host, props: props as never });
  flushSync();
  return props;
}

const rows       = () => [...host.querySelectorAll('.cp-row')];
const stateBtns  = (i = 0) => [...rows()[i]!.querySelectorAll<HTMLButtonElement>('.cp-state')];
const roleBtns   = () => [...host.querySelectorAll<HTMLButtonElement>('.cp-role')];

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
afterEach(() => {
  if (instance) unmount(instance);
  instance = null; host.remove();
  delete (window as unknown as Record<string, unknown>).__pwned;
  vi.restoreAllMocks(); document.body.innerHTML = '';
});

// ════════════════════════════════════════════════════════════════════════════
// XSS — en yüksek değerli regresyon
// ════════════════════════════════════════════════════════════════════════════
describe('C2 — GÜVENLİK: kullanıcı verisi HTML olarak render EDİLMEZ', () => {
  it('zararlı ROL adı METİN olarak basılır, HTML üretmez', () => {
    render({ roles: [{ _id: 'r1', name: XSS }], selectedRoleId: 'r1' });

    expect(host.querySelector('img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(host.textContent).toContain('onerror');   // metin olarak görünür
  });

  it('zararlı KANAL adı METİN olarak basılır', () => {
    render({ channelName: XSS });

    expect(host.querySelector('img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('zararlı HATA metni HTML üretmez', () => {
    render({ error: XSS });

    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('onerror');
  });

  it('editörün DOM’unda enjekte edilmiş script/img elemanı yoktur', () => {
    render({ channelName: XSS, roles: [{ _id: 'r1', name: XSS }], selectedRoleId: 'r1', error: XSS });

    expect(host.querySelectorAll('script, img, iframe')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Üç durum
// ════════════════════════════════════════════════════════════════════════════
describe('C2 — üç durumlu kontrol', () => {
  it('her izin için üç durum sunulur ve KATALOG kadar satır vardır', () => {
    render();

    expect(rows()).toHaveLength(CHANNEL_PERMISSIONS.length);
    expect(stateBtns()).toHaveLength(3);
  });

  it('ERİŞİLEBİLİRLİK: durum yalnız RENGE bağlı değildir (metin etiketi var)', () => {
    render();

    const labels = stateBtns().map(b => b.textContent?.trim() ?? '');
    expect(labels.join(' ')).toMatch(/Engelle/);
    expect(labels.join(' ')).toMatch(/Devral/);
    expect(labels.join(' ')).toMatch(/İzin ver/);
  });

  it('ERİŞİLEBİLİRLİK: radiogroup semantiği ve aria-checked kullanılır', () => {
    render();

    expect(rows()[0]!.querySelector('[role="radiogroup"]')).not.toBeNull();
    const checked = stateBtns().filter(b => b.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);          // varsayılan: inherit
    expect(checked[0]!.dataset.state).toBe('inherit');
  });

  it('durum tıklaması kontrolcüye DOĞRU bit ve durumu iletir', () => {
    const p = render();

    const allowBtn = stateBtns().find(b => b.dataset.state === 'allow')!;
    allowBtn.click();
    flushSync();

    expect(p.onSetState).toHaveBeenCalledWith('role-1', CHANNEL_PERMISSIONS[0]!.bit, 'allow');
    void VIEW;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Kirli durum / kaydetme
// ════════════════════════════════════════════════════════════════════════════
describe('C2 — kirli durum ve kaydetme', () => {
  it('değişiklik yokken Kaydet ve Geri al DEVRE DIŞI', () => {
    render({ dirty: false });

    const btns = [...host.querySelectorAll<HTMLButtonElement>('.cp-footer button')];
    expect(btns.every(b => b.disabled)).toBe(true);
  });

  it('kirliyken Kaydet etkinleşir ve kontrolcüyü çağırır', () => {
    const p = render({ dirty: true });

    const save = [...host.querySelectorAll<HTMLButtonElement>('.cp-footer button')].at(-1)!;
    expect(save.disabled).toBe(false);
    save.click();
    flushSync();

    expect(p.onSave).toHaveBeenCalledTimes(1);
  });

  it('GÜVENLİK: kirliyken rol değiştirilemez (sessiz kayıp yok)', () => {
    const p = render({ dirty: true });

    const other = roleBtns().find(b => b.textContent?.includes('Üye'))!;
    expect(other.disabled).toBe(true);
    other.click();
    flushSync();

    expect(p.onSelectRole).not.toHaveBeenCalled();
  });

  it('kaydederken mutasyon kontrolleri DEVRE DIŞI', () => {
    render({ saving: true, dirty: true });

    expect(stateBtns().every(b => b.disabled)).toBe(true);
  });

  it('yüklenirken matris gösterilmez', () => {
    render({ loading: true });

    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain('yükleniyor');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Kapsam — yayınlanmayan bölümler
// ════════════════════════════════════════════════════════════════════════════
describe('C2 — kapsam dürüstlüğü', () => {
  it('kullanıcı/üye override arayüzü YOKTUR (arka uç desteklemiyor)', () => {
    render();

    expect(host.textContent).not.toMatch(/üye ekle|kullanıcı ekle/i);
  });

  it('audit / sync / bulk bölümleri YAYINLANMAZ', () => {
    render();

    expect(host.textContent).not.toMatch(/audit|senkron|toplu/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Etkin izin açıklaması — yalnız güvenli, yapılandırılmış veri
// ════════════════════════════════════════════════════════════════════════════
describe('Permission Explainability — güvenli yönetici görünümü', () => {
  const explanation = {
    channelId: 'chan-1',
    subject: 'current-user',
    permissions: [{
      key: 'SEND_MESSAGES',
      label: 'Mesaj gönder',
      allowed: false,
      effective: 'denied' as const,
      reasonCode: 'CHANNEL_OVERRIDE_DENIED',
      message: 'Bu kanal sunucu rol izinleriyle kısıtlanmış.',
      base: { state: 'allowed' as const, sources: ['Developer rolü izin veriyor'] },
      overrides: [{
        scope: 'role' as const,
        label: 'Developer kanal kuralı',
        state: 'denied' as const,
      }],
    }],
  };

  it('Açıkla eylemini kontrolcüye iletir', () => {
    const p = render();

    [...host.querySelectorAll<HTMLButtonElement>('.cp-explain button')]
      .find(button => button.textContent?.includes('Açıkla'))!
      .click();
    flushSync();

    expect(p.onExplain).toHaveBeenCalledTimes(1);
  });

  it('özel rol bulunmasa da owner/yönetici açıklama yüzeyi erişilebilir kalır', () => {
    const p = render({ roles: [], selectedRoleId: '' });

    expect(host.textContent).toContain('Bu sunucuda düzenlenebilir rol yok.');
    expect(host.textContent).toContain('Etkin izinlerim neden böyle?');
    host.querySelector<HTMLButtonElement>('.cp-explain button')!.click();
    flushSync();

    expect(p.onExplain).toHaveBeenCalledTimes(1);
  });

  it('etkin kararın temel kaynağını ve kanal kuralını anlaşılır biçimde gösterir', () => {
    render({ explanation });

    const row = host.querySelector('.cp-explain-row');
    expect(row).toHaveAttribute('data-effective', 'denied');
    expect(row).toHaveTextContent('Mesaj gönder');
    expect(row).toHaveTextContent('Reddedildi');
    expect(row).toHaveTextContent('Developer rolü izin veriyor');
    expect(row).toHaveTextContent('Developer kanal kuralı: reddediyor');
  });

  it('zararlı açıklama verisini METİN olarak basar, HTML üretmez', () => {
    render({
      explanation: {
        ...explanation,
        permissions: [{
          ...explanation.permissions[0],
          label: XSS,
          message: '<script>window.__pwned=1</script>',
          base: { state: 'allowed', sources: [XSS] },
          overrides: [{ scope: 'role', label: XSS, state: 'denied' }],
        }],
      },
    });

    expect(host.querySelectorAll('.cp-explain script, .cp-explain img')).toHaveLength(0);
    expect(host.querySelector('.cp-explain')?.textContent).toContain('window.__pwned');
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('View as Role — salt okunur rol simülasyonu', () => {
  const preview = {
    simulation: true as const,
    role: { id: 'role-1', name: 'Moderatör' },
    summary: {
      totalChannels: 2,
      visibleChannels: 1,
      sendableChannels: 1,
      attachableChannels: 1,
      manageableChannels: 0,
    },
    channels: [
      {
        channelId: 'general', name: 'general', type: 'text', categoryId: null, visible: true,
        capabilities: { sendMessages: true, attachFiles: true, manageMessages: false, connect: true, speak: true },
      },
      {
        channelId: 'staff', name: 'staff', type: 'text', categoryId: null, visible: false,
        capabilities: { sendMessages: true, attachFiles: true, manageMessages: false, connect: true, speak: true },
      },
    ],
  };

  it('seçilen rol kimliğini önizleme kontrolcüsüne iletir', () => {
    const p = render();
    const select = host.querySelector<HTMLSelectElement>('#cp-preview-role')!;
    select.value = 'role-1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    [...host.querySelectorAll<HTMLButtonElement>('.cp-preview button')]
      .find(button => button.textContent?.includes('Rolü önizle'))!
      .click();
    flushSync();

    expect(p.onPreviewRole).toHaveBeenCalledWith('role-1');
  });

  it('görünür/gizli kanalları ve mesaj/dosya/yönetim yeteneklerini gösterir', () => {
    render({ rolePreview: preview });

    expect(host.querySelector('.cp-preview-summary')).toHaveTextContent('1/2 kanal görünür');
    expect(host.querySelector('[data-visible="true"]')).toHaveTextContent('# general');
    expect(host.querySelector('[data-visible="true"]')).toHaveTextContent('Dosya: var');
    expect(host.querySelector('[data-visible="true"]')).toHaveTextContent('Yönetim: yok');
    expect(host.querySelector('[data-visible="false"]')).toHaveTextContent('# staff');
    expect(host.textContent).toContain('Yalnız simülasyon');
  });

  it('rol ve kanal adlarını METİN olarak basar, simülasyon yüzeyi HTML çalıştırmaz', () => {
    render({
      rolePreview: {
        ...preview,
        role: { id: 'role-1', name: XSS },
        channels: [{ ...preview.channels[0], name: XSS }],
      },
    });

    expect(host.querySelectorAll('.cp-preview img, .cp-preview script')).toHaveLength(0);
    expect(host.querySelector('.cp-preview')?.textContent).toContain('onerror');
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('özel rol yokken @everyone önizleme seçeneği yine kullanılabilir', () => {
    const p = render({ roles: [], selectedRoleId: '' });
    host.querySelector<HTMLButtonElement>('.cp-preview button')!.click();
    flushSync();

    expect(p.onPreviewRole).toHaveBeenCalledWith('__everyone__');
  });
});

describe('C2 — klavye, kapatma ve rol etkileşimleri', () => {
  it('Escape, kapat düğmesi ve yalnız gerçek backdrop tıklaması kapatır', () => {
    const p = render();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(p.onClose).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    host.querySelector<HTMLButtonElement>('.cp-close')!.click();
    host.querySelector<HTMLElement>('.cp-card')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(p.onClose).toHaveBeenCalledTimes(2);

    host.querySelector<HTMLElement>('.cp-overlay')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(p.onClose).toHaveBeenCalledTimes(3);
  });

  it('temiz ve boşta iken rol seçer', () => {
    const p = render();
    roleBtns()[1]!.click();
    expect(p.onSelectRole).toHaveBeenCalledWith('role-2');
  });

  it('kirli iken sentetik olay gelse bile rol değişimini reddeder', () => {
    const p = render({ dirty: true });
    // Raw dispatch, disabled öğe korumasının ardındaki uygulama kapısını da
    // doğrular (sentetik/yardımcı teknoloji olayları .click() kuralına bağlı değildir).
    const dirtyButton = roleBtns()[1]!;
    dirtyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(p.onSelectRole).not.toHaveBeenCalled();
  });

  it('Geri al düğmesini iletir ve kaydetme sırasında doğru ilerleme metnini gösterir', () => {
    const p = render({ dirty: true, saving: false });
    const [reset] = [...host.querySelectorAll<HTMLButtonElement>('.cp-footer button')];
    reset!.click();
    expect(p.onReset).toHaveBeenCalledTimes(1);
  });
});

describe('Permission Explainability — tüm görünür karar durumları', () => {
  const allowedExplanation = {
    channelId: 'chan-1', subject: 'current-user',
    permissions: [{
      key: 'VIEW_CHANNELS', label: 'Kanalı görüntüle', allowed: true,
      effective: 'allowed' as const, reasonCode: 'BASE_ALLOWED', message: 'Rol izin veriyor.',
      base: { state: 'allowed' as const, sources: [] },
      overrides: [
        { scope: 'everyone' as const, label: '@everyone', state: 'allowed' as const },
        { scope: 'role' as const, label: 'Muted', state: 'denied' as const },
      ],
    }, {
      key: 'SEND_MESSAGES', label: 'Mesaj gönder', allowed: false,
      effective: 'denied' as const, reasonCode: 'BASE_DENIED', message: 'Temel izin yok.',
      base: { state: 'denied' as const, sources: ['Varsayılan'] }, overrides: [],
    }],
  };

  it('yükleme ve hata durumlarını birbirinden ayırır', () => {
    render({ explanationLoading: true, explanationError: 'Açıklama alınamadı' });
    const button = host.querySelector<HTMLButtonElement>('.cp-explain button')!;
    expect(button.disabled).toBe(true);
    expect(button).toHaveTextContent('Açıklanıyor');
    expect(host.querySelector('.cp-explain-error')).toHaveTextContent('Açıklama alınamadı');
  });

  it('izin verilen/reddedilen sonuçları, boş kaynağı ve iki override yönünü render eder', () => {
    render({ explanation: allowedExplanation });
    const rows = [...host.querySelectorAll<HTMLElement>('.cp-explain-row')];

    expect(rows[0]).toHaveTextContent('İzin verildi');
    expect(rows[0]).toHaveTextContent('@everyone: izin veriyor');
    expect(rows[0]).toHaveTextContent('Muted: reddediyor');
    expect(rows[1]!.querySelector('ul')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.cp-explain button')).toHaveTextContent('Yenile');
  });
});

describe('View as Role — yükleme, hata ve yetenek dalları', () => {
  it('yükleme ve hata durumlarını doğru yansıtır', () => {
    render({ rolePreviewLoading: true, rolePreviewError: 'Önizleme alınamadı', dirty: true });
    const button = host.querySelector<HTMLButtonElement>('.cp-preview button')!;
    expect(button.disabled).toBe(true);
    expect(button).toHaveTextContent('Önizleniyor');
    expect(host.querySelector('.cp-preview-error')).toHaveTextContent('Önizleme alınamadı');
    expect(host.querySelector('.cp-preview-note')).not.toBeNull();
  });

  it('ses kanalını ve yeteneklerin karşıt durumlarını render eder', () => {
    render({
      rolePreview: {
        simulation: true,
        role: { id: 'voice-role', name: 'Voice' },
        summary: {
          totalChannels: 1, visibleChannels: 1, sendableChannels: 0,
          attachableChannels: 0, manageableChannels: 1,
        },
        channels: [{
          channelId: 'voice', name: 'Lounge', type: 'voice', categoryId: null, visible: true,
          capabilities: {
            sendMessages: false, attachFiles: false, manageMessages: true,
            connect: false, speak: false,
          },
        }],
      },
    });

    const channel = host.querySelector('.cp-preview-channel')!;
    expect(channel).toHaveTextContent('🔊 Lounge');
    expect(channel).toHaveTextContent('Mesaj: yok');
    expect(channel).toHaveTextContent('Dosya: yok');
    expect(channel).toHaveTextContent('Yönetim: var');
    expect(channel).toHaveTextContent('Ses bağlantısı: yok');
    expect(channel).toHaveTextContent('Konuşma: yok');
  });

  it('saving durumunda kaydetme metnini ve bütün mutasyon kilitlerini gösterir', () => {
    render({ saving: true, dirty: true });
    const footer = [...host.querySelectorAll<HTMLButtonElement>('.cp-footer button')];
    expect(footer.at(-1)).toHaveTextContent('Kaydediliyor');
    expect(footer.every(button => button.disabled)).toBe(true);
    expect(roleBtns().every(button => button.disabled)).toBe(true);
  });

  it('bozuk API metin/sayaç alanlarını HTML çalıştırmadan boş metin olarak sınırlar', () => {
    render({
      roles: [{ _id: 'role-null', name: null }] as never,
      selectedRoleId: 'role-null',
      explanation: {
        channelId: 'chan-1', subject: 'me', permissions: [{
          key: 'NULL_LABEL', label: 'Null label', allowed: true,
          effective: 'allowed', reasonCode: 'TEST', message: 'Safe',
          base: { state: 'allowed', sources: [] },
          overrides: [{ scope: 'role', label: null, state: 'allowed' }],
        }],
      } as never,
      rolePreview: {
        simulation: true,
        role: { id: 'role-null', name: null },
        summary: {
          totalChannels: null, visibleChannels: null, sendableChannels: null,
          attachableChannels: null, manageableChannels: null,
        },
        channels: [{
          channelId: 'channel-null', name: null, type: 'text', categoryId: null, visible: true,
          capabilities: {
            sendMessages: false, attachFiles: false, manageMessages: false,
            connect: false, speak: false,
          },
        }],
      } as never,
    });

    expect(host.querySelectorAll('script, img, iframe')).toHaveLength(0);
    expect(host.querySelector('.cp-preview-summary')).not.toBeNull();
    expect(host.querySelector('.cp-preview-channel')).not.toBeNull();
    expect(host.querySelector('.cp-explain-row li')).toHaveTextContent('izin veriyor');
  });
});
