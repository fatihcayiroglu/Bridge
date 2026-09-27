// server/tests/clips-socket.test.ts
//
// KLİP KAYITLARI — KANAL DENETİMİ VE SINIRLI BELLEK
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN İKİ GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// 1. KANAL DENETİMİ HİÇ YAZILMAMIŞTI. `clips.ts` dosyanın başında üç izin
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
//    yardımcısını (`resolvePermissions`, `hasPermission`, `PERMS`) import
//    ediyor ama HİÇBİRİNİ kullanmıyordu — niyet açıktı, uygulama eksikti.
//    (ESLint bunu "unused import" olarak raporluyordu; uyarıyı silmek yerine
//    NEDENİNE bakınca eksik denetim ortaya çıktı.)
//
//    ŞİDDET: düşük. `clip:list` yalnızca `c.userId === userId` olan kayıtları
//    döndürür, yani başkasının verisi SIZMIYORDU. Yine de kullanıcı
//    göremediği bir kanala kayıt ilişkilendirebiliyordu.
//
// 2. `_clips` SINIRSIZ BÜYÜYORDU. Her kayıt diziye ekleniyor, hiçbir şey
//    silinmiyordu; süreç ömrü boyunca tek yönlü büyüme. Depo zaten geçicidir
//    (yeniden başlatmada kaybolur), dolayısıyla sınırsız tutmanın faydası da
//    yoktu.
//
// Her negatif iddianın yanında POZİTİF KONTROL vardır: denetim eklendikten
// sonra YETKİLİ kullanıcının hâlâ kaydedebildiğini de kanıtlarız, aksi halde
// "her şeyi reddet" de testi geçerdi.

process.env.NODE_ENV = 'test';

const mockChannels = { findById: jest.fn() };
const mockPerms    = { resolvePermissions: jest.fn(), hasPermission: jest.fn() };

jest.mock('../db/repositories', () => ({ Channels: mockChannels }));
jest.mock('../lib/permissions', () => ({
  resolvePermissions: (...a: unknown[]) => mockPerms.resolvePermissions(...a),
  hasPermission:      (...a: unknown[]) => mockPerms.hasPermission(...a),
  PERMS:              { VIEW_CHANNELS: 1 << 0 },
}));
jest.mock('../middleware/validate', () => ({
  validateSocketPayload: () => ({ valid: true }),
  socketSchemas: { clipSave: {}, clipList: {} },
}));

import { registerClipHandlers } from '../socket/handlers/clips';

interface Handler { (payload: unknown): unknown }

function makeSocket() {
  const handlers = new Map<string, Handler>();
  const emitted: { event: string; payload: unknown }[] = [];
  return {
    on: (event: string, fn: Handler) => { handlers.set(event, fn); },
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
    async fire(event: string, payload: unknown) { await handlers.get(event)?.(payload); },
    emitted,
  };
}

const CHANNEL = 'ch-1';
const clip = (over: Record<string, unknown> = {}) => ({
  channelId: CHANNEL, filename: 'k.webm', mimeType: 'video/webm',
  sizeBytes: 1000, durationMs: 5000, ...over,
});

function allowAccess() {
  mockChannels.findById.mockResolvedValue({ _id: CHANNEL, serverId: 'srv-1' });
  mockPerms.resolvePermissions.mockResolvedValue(1);
  mockPerms.hasPermission.mockReturnValue(true);
}

beforeEach(() => {
  jest.clearAllMocks();
  allowAccess();
});

// ════════════════════════════════════════════════════════════════════════════
describe('clip:save — kanal erişim denetimi', () => {
  it('POZİTİF KONTROL: yetkili kullanıcı kaydedebilir', async () => {
    const s = makeSocket();
    registerClipHandlers(s as never, 'u1');
    await s.fire('clip:save', clip());

    expect(s.emitted.map(e => e.event)).toContain('clip:saved');
  });

  it('izinler kanalın GERÇEK sunucusuna karşı çözülür', async () => {
    const s = makeSocket();
    registerClipHandlers(s as never, 'u1');
    await s.fire('clip:save', clip());

    expect(mockPerms.resolvePermissions).toHaveBeenCalledWith('u1', 'srv-1', CHANNEL);
  });

  it('VIEW_CHANNELS yoksa kayıt YAPILMAZ', async () => {
    mockPerms.hasPermission.mockReturnValue(false);
    const s = makeSocket();
    registerClipHandlers(s as never, 'u1');
    await s.fire('clip:save', clip());

    expect(s.emitted.map(e => e.event)).not.toContain('clip:saved');
  });

  it('kanal YOKSA kayıt yapılmaz', async () => {
    mockChannels.findById.mockResolvedValue(null);
    const s = makeSocket();
    registerClipHandlers(s as never, 'u1');
    await s.fire('clip:save', clip({ channelId: 'yok' }));

    expect(s.emitted.map(e => e.event)).not.toContain('clip:saved');
  });

  it('izin çözümü HATA verirse FAIL-CLOSED', async () => {
    mockPerms.resolvePermissions.mockRejectedValue(new Error('db down'));
    mockPerms.hasPermission.mockReturnValue(false);
    const s = makeSocket();
    registerClipHandlers(s as never, 'u1');
    await s.fire('clip:save', clip());

    expect(s.emitted.map(e => e.event)).not.toContain('clip:saved');
  });

  it('kanal aramasi HATA verirse FAIL-CLOSED', async () => {
    mockChannels.findById.mockRejectedValue(new Error('db down'));
    const s = makeSocket();
    registerClipHandlers(s as never, 'u1');
    await s.fire('clip:save', clip());

    expect(s.emitted.map(e => e.event)).not.toContain('clip:saved');
  });

  it('reddedilen kayıt LİSTEDE de görünmez', async () => {
    // Denetimin gerçekten kaydı engellediğini, yalnızca yanıtı
    // susturmadığını gösterir.
    mockPerms.hasPermission.mockReturnValue(false);
    const s = makeSocket();
    registerClipHandlers(s as never, 'reddedilen-kullanici');
    await s.fire('clip:save', clip());
    await s.fire('clip:list', {});

    const list = requireEmitted(s.emitted, 'clip:list_result');
    expect(list?.payload).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('clip:list — sahiplik', () => {
  it('YALNIZCA kendi kayıtları döner', async () => {
    const a = makeSocket();
    registerClipHandlers(a as never, 'sahip');
    await a.fire('clip:save', clip({ filename: 'benim.webm' }));

    const b = makeSocket();
    registerClipHandlers(b as never, 'baskasi');
    await b.fire('clip:list', {});

    const list = requireEmitted(b.emitted, 'clip:list_result');
    expect(JSON.stringify(list?.payload)).not.toContain('benim.webm');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bellek sınırlıdır', () => {
  it('kullanıcı başına kayıt sayısı KAPAKLIDIR', async () => {
    const s = makeSocket();
    registerClipHandlers(s as never, 'cok-kaydeden');
    for (let i = 0; i < 120; i++) await s.fire('clip:save', clip({ filename: `k${i}.webm` }));

    await s.fire('clip:list', {});
    const list = requireEmitted(s.emitted, 'clip:list_result')!.payload as unknown[];
    expect(list.length).toBeLessThanOrEqual(50);
  });

  it('budama EN ESKİYİ atar, EN YENİYİ tutar', async () => {
    const s = makeSocket();
    registerClipHandlers(s as never, 'siralama');
    for (let i = 0; i < 120; i++) await s.fire('clip:save', clip({ filename: `s${i}.webm` }));

    await s.fire('clip:list', {});
    const list = requireEmitted(s.emitted, 'clip:list_result')!.payload as { filename: string }[];
    const names = list.map(c => c.filename);
    expect(names).toContain('s119.webm');
    expect(names).not.toContain('s0.webm');
  });

  it('bir kullanıcının budanması BAŞKASININ kayıtlarını silmez', async () => {
    const other = makeSocket();
    registerClipHandlers(other as never, 'komsu');
    await other.fire('clip:save', clip({ filename: 'komsu.webm' }));

    const heavy = makeSocket();
    registerClipHandlers(heavy as never, 'agir');
    for (let i = 0; i < 120; i++) await heavy.fire('clip:save', clip({ filename: `a${i}.webm` }));

    await other.fire('clip:list', {});
    const list = requireEmitted(other.emitted, 'clip:list_result')!.payload as { filename: string }[];
    expect(list.map(c => c.filename)).toContain('komsu.webm');
  });
});
