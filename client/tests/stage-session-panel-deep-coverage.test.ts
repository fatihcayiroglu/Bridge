// client/tests/stage-session-panel-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// StageSessionPanel — KATILIM UZLAŞTIRMASI, YARIŞ VE MODERASYON
// ════════════════════════════════════════════════════════════════════════════
//
// Bu yüzey bir KONTROL DÜZLEMİDİR: sahneye katılır, rol ister, moderasyon
// uygular. Hiç ölçülmemiş 199 dalın taşıdığı riskler:
//
//   · HAYALET OTURUM — kullanıcı kanal değiştirdiğinde ÖNCEKİ sahneden
//     ayrılmak zorunludur; ayrılamıyorsa yeni sahneye katılmaya çalışmak iki
//     açık oturum bırakırdı.
//   · YARIŞ — katılım isteği sürerken kanal değişirse GEÇ gelen yanıt yeni
//     kanalın durumunu ezmemeli; açılan oturum da SIZDIRILMAMALIDIR (telafi
//     amaçlı `stage:leave` gönderilir).
//   · SESSİZ HATA — sunucu reddederse neden GÖSTERİLİR; kod bilinmiyorsa
//     genel ama anlamlı bir metne düşülür. Yanıt gelmezse zaman aşımı vardır.
//   · SAHTE DURUM — soketten gelen şekilsiz/başka kanala ait durum yükleri
//     paneli KİRLETMEZ; geçersiz katılımcı satırları render edilmez.
//   · YETKİ — moderasyon düğmeleri yalnız sunucunun `canManage` dediği
//     durumda ve KENDİN DIŞINDAKİ katılımcılar için görünür.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import StageSessionPanel from '../js/core/StageSessionPanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { t } from '../js/core/i18n/index.ts';

type StageAck = { ok: boolean; code?: string; canManage?: boolean };
type AckFn = (result: StageAck) => void;

const OWNED_KEYS = ['socket', 'getMe', 'getCurrentChannel'];
const CH = 'stage-1';
const ME = 'user-me';

interface EmittedCall { event: string; payload: unknown; ack?: AckFn }

let emitted: EmittedCall[];
let handlers: Map<string, Array<(payload: unknown) => void>>;
let offSpy: ReturnType<typeof vi.fn>;
let ackResponses: Map<string, StageAck | 'silent'>;
let emitThrows: boolean;

function installSocket(): void {
  // Her soket KENDİ casuslarını taşır: modül değişkenini kapatan bir ok işlevi,
  // soket değiştirildiğinde eski nesnenin çağrılarını yenisine yönlendirir ve
  // "eski dinleyiciler söküldü mü" sorusu ölçülemez hâle gelirdi.
  const localHandlers = new Map<string, Array<(payload: unknown) => void>>();
  const localEmitted: EmittedCall[] = [];
  const localOff = vi.fn();
  emitted = localEmitted;
  handlers = localHandlers;
  offSpy = localOff;
  BridgeRegistry.register('socket', {
    on(event: string, handler: (payload: unknown) => void) {
      const list = localHandlers.get(event) ?? [];
      list.push(handler);
      localHandlers.set(event, list);
    },
    off: (...args: unknown[]) => localOff(...args),
    emit(event: string, payload: unknown, ack?: AckFn) {
      if (emitThrows) throw new Error('socket closed');
      localEmitted.push({ event, payload, ack });
      const configured = ackResponses.get(event);
      if (configured === 'silent') return;
      ack?.(configured ?? { ok: true, canManage: false });
    },
  } as never);
}

function emit(event: string, payload: unknown): void {
  for (const handler of handlers.get(event) ?? []) handler(payload);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise(resolve => queueMicrotask(() => resolve(null)));
  }
}

const stageUser = (over: Record<string, unknown> = {}) => ({
  userId: 'user-other', displayName: 'Konuşmacı', avatarColor: '#abc',
  muted: false, handRaised: false, speaking: false, ...over,
});

const state = (over: Record<string, unknown> = {}) => ({
  channelId: CH, speakers: [], listeners: [], topic: '', live: false, ...over,
});

const surface = () => document.querySelector('.stage-session');
const errorBox = () => document.querySelector('.stage-error');
const errorText = () => errorBox()?.querySelector('span')?.textContent ?? '';
const speakers = () => [...document.querySelectorAll('.speaker-card')];
const listeners = () => [...document.querySelectorAll('.listener-row')];
const adminBox = () => document.querySelector('.stage-admin');
const eventsOf = (event: string) => emitted.filter(call => call.event === event);

function mount(props: Record<string, unknown> = {}) {
  return render(StageSessionPanel, {
    props: { active: true, channelId: CH, channelName: 'sahne', ...props },
  });
}

async function mountJoined(over: Record<string, unknown> = {}) {
  const view = mount();
  await flush();
  emit('stage:state', state(over));
  await flush();
  return view;
}

beforeEach(() => {
  ackResponses = new Map();
  emitThrows = false;
  installSocket();
  BridgeRegistry.register('getMe', (() => ({ _id: ME })) as never);
  BridgeRegistry.register('getCurrentChannel', (() => ({ _id: CH, type: 'stage' })) as never);
});

afterEach(() => {
  cleanup();
  for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════
describe('StageSessionPanel — katılım uzlaştırması', () => {
  it('etkin değilken hiçbir şey render edilmez ve istek gitmez', async () => {
    mount({ active: false });
    await flush();

    expect(surface()).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it('kanal kimliği yokken katılım denenmez', async () => {
    mount({ channelId: '' });
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(0);
  });

  it('soket yokken katılım denenmez ama yüzey çalışır', async () => {
    BridgeRegistry.unregister('socket');
    mount();
    await flush();

    expect(surface()).not.toBeNull();
    expect(document.querySelector('.stage-state')?.textContent).toBe(t('stage_preparing'));
  });

  it('etkin sahnede KATILIM ve DİNLEYİCİ rolü sırayla istenir', async () => {
    mount();
    await flush();

    expect(eventsOf('stage:join')[0]?.payload).toEqual({ channelId: CH });
    expect(eventsOf('stage:setRole')[0]?.payload).toEqual({ channelId: CH, role: 'listener' });
  });

  it.each([
    ['STAGE_UNAVAILABLE', () => t('ui_bu_sahneye_katilamadin')],
    ['STAGE_ROLE_REJECTED', () => t('ui_sahnedeki_rolun_ayarlanamadi')],
    ['STAGE_ACTION_REJECTED', () => t('ui_sahne_islemi_tamamlanamadi')],
    ['BILINMEYEN', () => t('ui_sahne_baglantisi_tamamlanamadi_tekrar_deneyebilirsin')],
  ])('katılım reddi %s kodunu okunur metne çevirir', async (code, expected) => {
    ackResponses.set('stage:join', { ok: false, code });
    mount();
    await flush();

    expect(errorText()).toBe(expected());
    expect(eventsOf('stage:setRole')).toHaveLength(0);
  });

  it('ROL reddedilirse açılan oturum SIZDIRILMAZ', async () => {
    ackResponses.set('stage:setRole', { ok: false, code: 'STAGE_ROLE_REJECTED' });
    mount();
    await flush();

    expect(errorText()).toBe(t('ui_sahnedeki_rolun_ayarlanamadi'));
    expect(eventsOf('stage:leave')).toHaveLength(1);
  });

  it('YANIT GELMEZSE zaman aşımına düşülür', async () => {
    vi.useFakeTimers();
    ackResponses.set('stage:join', 'silent');
    mount();
    await tick();
    await Promise.resolve();

    vi.advanceTimersByTime(6000);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    await flush();

    expect(errorText()).toBe(t('ui_sahne_baglantisi_tamamlanamadi_tekrar_deneyebilirsin'));
  });

  it('soket EMIT PATLARSA yüzey çökmez', async () => {
    emitThrows = true;
    mount();
    await flush();

    expect(surface()).not.toBeNull();
    expect(errorText()).toBe(t('ui_sahne_baglantisi_tamamlanamadi_tekrar_deneyebilirsin'));
  });

  it('kanal değişince ÖNCEKİ sahneden ayrılıp yenisine katılınır', async () => {
    const view = await mountJoined();
    emitted.length = 0;

    await view.rerender({ active: true, channelId: 'stage-2', channelName: 'ikinci' });
    await flush();

    expect(eventsOf('stage:leave')[0]?.payload).toEqual({ channelId: CH });
    expect(eventsOf('stage:join')[0]?.payload).toEqual({ channelId: 'stage-2' });
  });

  it('ÖNCEKİ sahneden ayrılınamazsa yeni sahneye KATILINMAZ', async () => {
    const view = await mountJoined();
    emitted.length = 0;
    ackResponses.set('stage:leave', { ok: false });

    await view.rerender({ active: true, channelId: 'stage-2', channelName: 'ikinci' });
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(0);
    expect(errorText()).toBe(t('ui_onceki_sahne_oturumu_kapatilamadi_tekrar_deneyebilir'));
  });

  it('yüzey KAPANDIĞINDA önceki oturum kapatılır, yenisi açılmaz', async () => {
    const view = await mountJoined();
    emitted.length = 0;

    await view.rerender({ active: false, channelId: CH, channelName: 'sahne' });
    await flush();

    expect(eventsOf('stage:leave')[0]?.payload).toEqual({ channelId: CH });
    expect(eventsOf('stage:join')).toHaveLength(0);
  });

  it('aynı sahneye İKİNCİ kez katılım denenmez', async () => {
    const view = await mountJoined();
    emitted.length = 0;

    await view.rerender({ active: true, channelId: CH, channelName: 'yeni-ad' });
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('StageSessionPanel — soket durum yükleri', () => {
  it('şekilsiz durum yükleri paneli KİRLETMEZ', async () => {
    await mountJoined({ speakers: [stageUser()] });

    emit('stage:state', null);
    emit('stage:state', 'metin');
    emit('stage:state', []);
    emit('stage:state', { speakers: [stageUser({ userId: 'sahte' })] });
    emit('stage:state', { channelId: 'baska-kanal', speakers: [] });
    await flush();

    expect(speakers()).toHaveLength(1);
  });

  it('geçersiz katılımcı satırları RENDER EDİLMEZ', async () => {
    await mountJoined({
      speakers: [null, 'metin', [], {}, { displayName: 'kimliksiz' }, stageUser()],
      listeners: [{ userId: 42 }, stageUser({ userId: 'dinleyici' })],
    });

    expect(speakers()).toHaveLength(1);
    expect(listeners()).toHaveLength(1);
  });

  it('dizi olmayan katılımcı alanları boş listeye indirgenir', async () => {
    await mountJoined({ speakers: 'bozuk', listeners: { rows: [] } });

    expect(document.querySelectorAll('.stage-empty')).toHaveLength(2);
  });

  it('konu 200 karakterle SINIRLANIR ve metin olmayan konu boşa düşer', async () => {
    await mountJoined({ topic: 'k'.repeat(300) });
    expect(document.querySelector<HTMLInputElement>('.topic-field input')).toBeNull();
    expect(document.querySelector('.stage-head-copy p')?.textContent).toHaveLength(200);

    emit('stage:state', state({ topic: 42 }));
    await flush();
    expect(document.querySelector('.stage-head-copy p')?.textContent)
      .toBe(t('surface_topluluk_konusmas_a23015'));
  });

  it('CANLI bayrağı yalnız gerçek `true` ile açılır', async () => {
    await mountJoined({ live: 'evet' });
    expect(document.querySelector('.stage-live-dot')?.classList.contains('live')).toBe(false);

    emit('stage:state', state({ live: true }));
    await flush();
    expect(document.querySelector('.stage-live-dot')?.classList.contains('live')).toBe(true);
  });

  it('EL KALDIRMA olayı yalnız kendi kanalında ve doğru tipte uygulanır', async () => {
    await mountJoined({ listeners: [stageUser({ userId: 'dinleyici' })] });

    emit('stage:handRaise', null);
    emit('stage:handRaise', { channelId: 'baska', userId: 'dinleyici', raised: true });
    emit('stage:handRaise', { channelId: CH, userId: 42, raised: true });
    emit('stage:handRaise', { channelId: CH, userId: 'dinleyici', raised: 'evet' });
    await flush();
    expect(document.querySelector('.hand-badge')).toBeNull();

    emit('stage:handRaise', { channelId: CH, userId: 'dinleyici', raised: true });
    await flush();
    expect(document.querySelector('.hand-badge')).not.toBeNull();
  });

  it('KONU olayı yalnız kendi kanalında uygulanır', async () => {
    await mountJoined();

    emit('stage:topicUpdate', null);
    emit('stage:topicUpdate', { channelId: 'baska', topic: 'yabancı' });
    emit('stage:topicUpdate', { channelId: CH, topic: 42 });
    await flush();
    expect(document.querySelector('.stage-head-copy p')?.textContent)
      .toBe(t('surface_topluluk_konusmas_a23015'));

    emit('stage:topicUpdate', { channelId: CH, topic: `${'k'.repeat(300)}` });
    await flush();
    expect(document.querySelector('.stage-head-copy p')?.textContent).toHaveLength(200);
  });

  it('CANLI olayı yalnız kendi kanalında uygulanır', async () => {
    await mountJoined();

    emit('stage:liveUpdate', null);
    emit('stage:liveUpdate', { channelId: 'baska', live: true });
    emit('stage:liveUpdate', { channelId: CH, live: 'evet' });
    await flush();
    expect(document.querySelector('.stage-live-dot')?.classList.contains('live')).toBe(false);

    emit('stage:liveUpdate', { channelId: CH, live: true });
    await flush();
    expect(document.querySelector('.stage-live-dot')?.classList.contains('live')).toBe(true);
  });

  it('soket sonradan hazır olduğunda yeniden bağlanılır', async () => {
    BridgeRegistry.unregister('socket');
    mount();
    await flush();

    installSocket();
    document.dispatchEvent(new Event('bridge:socket-ready'));
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(1);
  });

  it('yeniden bağlanmada ESKİ dinleyiciler sökülür', async () => {
    mount();
    await flush();
    const firstOff = offSpy;

    installSocket();
    document.dispatchEvent(new Event('bridge:socket-reconnected'));
    await flush();

    expect(firstOff).toHaveBeenCalledTimes(4);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('StageSessionPanel — katılımcı görünümü', () => {
  it('boş sahne için açık boş durumlar gösterilir', async () => {
    await mountJoined();

    const empties = [...document.querySelectorAll('.stage-empty')].map(node => node.textContent);
    expect(empties).toEqual([t('stage_no_speakers'), t('stage_no_listeners')]);
  });

  it('konuşmacı durumu susturma ve konuşma bilgisiyle sunulur', async () => {
    await mountJoined({
      speakers: [
        stageUser({ userId: 'a', muted: true, displayName: 'Susturulmuş' }),
        stageUser({ userId: 'b', speaking: true, displayName: 'Konuşan' }),
        stageUser({ userId: 'c', displayName: '' }),
      ],
    });

    const states = speakers().map(card => card.querySelector('.speaker-state')?.textContent);
    expect(states).toEqual([
      t('surface_mikrofon_kapal_7a9f4a'),
      t('surface_konusuyor_895d48'),
      t('surface_konusmac_4a103d'),
    ]);
    expect(speakers()[2]!.querySelector('.speaker-name')?.textContent).toBe(t('adm_user'));
    expect(speakers()[1]!.classList.contains('speaking')).toBe(true);
  });

  it('GÜVENLİ OLMAYAN avatar rengi markaya düşer', async () => {
    await mountJoined({
      speakers: [
        stageUser({ userId: 'a', avatarColor: 'red; background:url(x)' }),
        stageUser({ userId: 'b', avatarColor: '#1a2b3c' }),
      ],
    });

    const styles = speakers().map(card => card.querySelector('.stage-avatar')?.getAttribute('style'));
    expect(styles[0]).toContain('var(--brand)');
    expect(styles[0]).not.toContain('url(');
    expect(styles[1]).toContain('#1a2b3c');
  });

  it('rolüme göre alt bilgi ve el kaldırma düğmesi değişir', async () => {
    await mountJoined({ listeners: [stageUser({ userId: ME, displayName: 'Ben' })] });
    expect(document.querySelector('.stage-controls .stage-primary')).not.toBeNull();

    emit('stage:state', state({ speakers: [stageUser({ userId: ME, displayName: 'Ben' })] }));
    await flush();
    expect(document.querySelector('.stage-controls .stage-primary')).toBeNull();
    expect(document.querySelector('.stage-role strong')?.textContent).toBe(t('surface_konusmac_4a103d'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('StageSessionPanel — el kaldırma', () => {
  const handButton = () => document.querySelector<HTMLButtonElement>('.stage-controls .stage-primary')!;

  it('el kaldırma sunucuya bildirilir ve DURUM sunucudan gelir', async () => {
    await mountJoined({ listeners: [stageUser({ userId: ME })] });
    emitted.length = 0;

    handButton().click();
    await flush();

    expect(eventsOf('stage:handRaise')[0]?.payload).toEqual({ channelId: CH, raised: true });
    expect(handButton().getAttribute('aria-pressed')).toBe('false');

    emit('stage:handRaise', { channelId: CH, userId: ME, raised: true });
    await flush();
    expect(handButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('el kaldırılmışken düğme İNDİRME ister', async () => {
    await mountJoined({ listeners: [stageUser({ userId: ME, handRaised: true })] });
    emitted.length = 0;

    handButton().click();
    await flush();

    expect(eventsOf('stage:handRaise')[0]?.payload).toEqual({ channelId: CH, raised: false });
  });

  it('el kaldırma reddedilirse NEDEN gösterilir', async () => {
    await mountJoined({ listeners: [stageUser({ userId: ME })] });
    ackResponses.set('stage:handRaise', { ok: false, code: 'STAGE_ACTION_REJECTED' });

    handButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_sahne_islemi_tamamlanamadi'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('StageSessionPanel — moderasyon', () => {
  const joinManaged = async (over: Record<string, unknown> = {}) => {
    ackResponses.set('stage:join', { ok: true, canManage: true });
    const view = mount();
    await flush();
    emit('stage:state', state(over));
    await flush();
    return view;
  };

  it('yetki YOKSA yönetim kutusu ve satır düğmeleri görünmez', async () => {
    await mountJoined({ speakers: [stageUser({ userId: 'a' })], listeners: [stageUser({ userId: 'b' })] });

    expect(adminBox()).toBeNull();
    expect(document.querySelector('.stage-inline')).toBeNull();
  });

  it('yetki VARSA yönetim kutusu görünür', async () => {
    await joinManaged();
    expect(adminBox()).not.toBeNull();
  });

  it('KENDİ satırında moderasyon düğmesi görünmez', async () => {
    await joinManaged({
      speakers: [stageUser({ userId: ME }), stageUser({ userId: 'a' })],
      listeners: [stageUser({ userId: 'b' })],
    });

    expect(speakers()[0]!.querySelector('.stage-inline')).toBeNull();
    expect(speakers()[1]!.querySelector('.stage-inline')).not.toBeNull();
    expect(listeners()[0]!.querySelector('.stage-inline')).not.toBeNull();
  });

  it('dinleyici YÜKSELTİLİR, konuşmacı DÜŞÜRÜLÜR', async () => {
    await joinManaged({
      speakers: [stageUser({ userId: 'konusmaci' })],
      listeners: [stageUser({ userId: 'dinleyici' })],
    });
    emitted.length = 0;

    listeners()[0]!.querySelector<HTMLButtonElement>('.stage-inline')!.click();
    await flush();
    expect(eventsOf('stage:promote')[0]?.payload).toEqual({ channelId: CH, targetUserId: 'dinleyici' });

    speakers()[0]!.querySelector<HTMLButtonElement>('.stage-inline')!.click();
    await flush();
    expect(eventsOf('stage:demote')[0]?.payload).toEqual({ channelId: CH, targetUserId: 'konusmaci' });
  });

  it('moderasyon reddi NEDENİYLE gösterilir', async () => {
    await joinManaged({ listeners: [stageUser({ userId: 'dinleyici' })] });
    ackResponses.set('stage:promote', { ok: false, code: 'STAGE_ACTION_REJECTED' });

    listeners()[0]!.querySelector<HTMLButtonElement>('.stage-inline')!.click();
    await flush();

    expect(errorText()).toBe(t('ui_sahne_islemi_tamamlanamadi'));
  });

  it('konu KIRPILIR ve 200 karakterle sınırlanır', async () => {
    await joinManaged();
    emitted.length = 0;

    const input = adminBox()!.querySelector<HTMLInputElement>('input')!;
    await fireEvent.input(input, { target: { value: `   ${'k'.repeat(300)}   ` } });
    await flush();
    adminBox()!.querySelectorAll<HTMLButtonElement>('button')[0]!.click();
    await flush();

    const payload = eventsOf('stage:setTopic')[0]?.payload as { topic: string };
    expect(payload.topic).toHaveLength(200);
  });

  it('konu kaydı reddedilirse NEDEN gösterilir', async () => {
    await joinManaged();
    ackResponses.set('stage:setTopic', { ok: false, code: 'STAGE_ACTION_REJECTED' });

    adminBox()!.querySelectorAll<HTMLButtonElement>('button')[0]!.click();
    await flush();

    expect(errorText()).toBe(t('ui_sahne_islemi_tamamlanamadi'));
  });

  it('CANLI durumu tersine çevrilir', async () => {
    await joinManaged();
    emitted.length = 0;

    adminBox()!.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
    await flush();
    expect(eventsOf('stage:setLive')[0]?.payload).toEqual({ channelId: CH, live: true });

    emit('stage:liveUpdate', { channelId: CH, live: true });
    await flush();
    emitted.length = 0;
    adminBox()!.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
    await flush();
    expect(eventsOf('stage:setLive')[0]?.payload).toEqual({ channelId: CH, live: false });
  });

  it('canlı durumu reddedilirse NEDEN gösterilir', async () => {
    await joinManaged();
    ackResponses.set('stage:setLive', { ok: false, code: 'STAGE_ACTION_REJECTED' });

    adminBox()!.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
    await flush();

    expect(errorText()).toBe(t('ui_sahne_islemi_tamamlanamadi'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('StageSessionPanel — ayrılma ve yeniden katılma', () => {
  const leaveButton = () => document.querySelector<HTMLButtonElement>('.stage-head .danger')!;

  it('ayrılma sunucuya bildirilir ve yüzey BOŞ duruma geçer', async () => {
    await mountJoined();
    emitted.length = 0;

    leaveButton().click();
    await flush();

    expect(eventsOf('stage:leave')[0]?.payload).toEqual({ channelId: CH });
    expect(document.querySelector('.stage-state strong')?.textContent).toBe(t('stage_left'));
  });

  it('ayrılma reddedilirse oturum AÇIK kalır ve neden gösterilir', async () => {
    await mountJoined();
    ackResponses.set('stage:leave', { ok: false });

    leaveButton().click();
    await flush();

    expect(errorText()).toBe(t('ui_sahneden_ayrilma_tamamlanamadi_tekrar_deneyebilirsin'));
    expect(leaveButton()).not.toBeNull();
  });

  it('elle ayrıldıktan sonra kendiliğinden YENİDEN katılınmaz', async () => {
    await mountJoined();
    leaveButton().click();
    await flush();
    emitted.length = 0;

    document.dispatchEvent(new Event('bridge:socket-ready'));
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(0);
  });

  it('YENİDEN KATIL düğmesi oturumu geri açar', async () => {
    await mountJoined();
    leaveButton().click();
    await flush();
    emitted.length = 0;

    document.querySelector<HTMLButtonElement>('.stage-state .stage-primary')!.click();
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(1);
  });

  it('KANAL SEÇİMİ olayı elle ayrılmış sahneye geri döndürür', async () => {
    await mountJoined();
    leaveButton().click();
    await flush();
    emitted.length = 0;

    document.dispatchEvent(new Event('bridge:channel-selected'));
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(1);
  });

  it('BAŞKA kanal seçildiğinde geri dönülmez', async () => {
    BridgeRegistry.register('getCurrentChannel', (() => ({ _id: 'baska', type: 'stage' })) as never);
    await mountJoined();
    leaveButton().click();
    await flush();
    emitted.length = 0;

    document.dispatchEvent(new Event('bridge:channel-selected'));
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(0);
  });

  it('SAHNE OLMAYAN kanal seçildiğinde geri dönülmez', async () => {
    BridgeRegistry.register('getCurrentChannel', (() => ({ _id: CH, type: 'text' })) as never);
    await mountJoined();
    leaveButton().click();
    await flush();
    emitted.length = 0;

    document.dispatchEvent(new Event('bridge:channel-selected'));
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(0);
  });

  it('hata kutusundaki YENİDEN DENE bağlantıyı tazeler', async () => {
    ackResponses.set('stage:join', { ok: false, code: 'STAGE_UNAVAILABLE' });
    mount();
    await flush();
    emitted.length = 0;
    ackResponses.delete('stage:join');

    errorBox()!.querySelector<HTMLButtonElement>('button')!.click();
    await flush();

    expect(eventsOf('stage:join')).toHaveLength(1);
    expect(errorBox()).toBeNull();
  });

  it('unmount açık oturumu kapatır ve dinleyicileri söker', async () => {
    const view = await mountJoined();
    emitted.length = 0;

    view.unmount();
    await flush();

    expect(eventsOf('stage:leave')[0]?.payload).toEqual({ channelId: CH });
    expect(offSpy).toHaveBeenCalledTimes(4);
  });

  it('unmount sırasında soket patlarsa sökme yine tamamlanır', async () => {
    const view = await mountJoined();
    emitThrows = true;

    expect(() => view.unmount()).not.toThrow();
    expect(offSpy).toHaveBeenCalledTimes(4);
  });
});
