// server/tests/message-report-repository-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// MESAJ ŞİKÂYETİ DEPOSU — YİNELEME, YARIŞ VE DURUM GEÇİŞLERİ
// ════════════════════════════════════════════════════════════════════════════
//
// Şikâyet kaydı bir MODERASYON kuyruğudur. Ölçülmemiş dallar iki gerçek
// arızayı gizliyordu:
//
//   · YİNELENEN ŞİKÂYET — aynı kullanıcı aynı mesajı iki kez şikâyet ederse
//     kuyruk şişer. Benzersizlik ihlali (23505 ya da sürücüye özgü "duplicate"
//     metni) BAŞARILI yinelenen istek sayılmalıdır; ama başka her hata
//     yutulmamalıdır.
//   · ÇİFT KARAR — iki moderatör aynı anda karar verirse İKİNCİSİ sessizce
//     kazanmamalıdır. Aynı kararı tekrarlamak "already", farklı bir karara
//     çevirmek "conflict"tir.

process.env.NODE_ENV = 'test';

const messageReports = {
  findOne: jest.fn(),
  insert: jest.fn(),
  find: jest.fn(),
  update: jest.fn(),
};

jest.mock('../db/loader', () => ({ __esModule: true, default: { messageReports } }));

import MessageReports from '../db/repositories/MessageReportRepository';

const SRV = 'srv-1';
const REPORT = 'rep-1';

const input = {
  serverId: SRV, channelId: 'ch-1', messageId: 'm-1', reporterId: 'u-1',
  reason: 'spam' as const, detail: 'çok tekrar',
};

function chain(rows: Record<string, unknown>[]) {
  const limit = jest.fn(async () => rows);
  const sort = jest.fn(() => ({ limit }));
  return { chainRoot: { sort }, sort, limit };
}

beforeEach(() => {
  jest.clearAllMocks();
  messageReports.findOne.mockResolvedValue(null);
  messageReports.insert.mockImplementation(async (row: Record<string, unknown>) => row);
  messageReports.update.mockResolvedValue({ updated: 1 });
});

// ════════════════════════════════════════════════════════════════════════════
describe('create', () => {
  it('yeni şikâyet AÇIK durumda oluşturulur', async () => {
    const result = await MessageReports.create(input);

    expect(result.created).toBe(true);
    expect(result.row).toMatchObject({
      serverId: SRV, messageId: 'm-1', reporterId: 'u-1',
      status: 'open', resolvedAt: null, resolvedBy: null, resolution: null,
    });
    expect(typeof result.row._id).toBe('string');
  });

  it('AÇIK bir şikâyet zaten varsa yenisi yazılmaz', async () => {
    messageReports.findOne.mockResolvedValue({ _id: REPORT, status: 'open' });

    const result = await MessageReports.create(input);

    expect(result).toEqual({ row: { _id: REPORT, status: 'open' }, created: false });
    expect(messageReports.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['PostgreSQL benzersizlik kodu', Object.assign(new Error('duplicate key value'), { code: '23505' })],
    ['sürücüye özgü DUPLICATE metni', new Error('E11000 duplicate key')],
    ['sürücüye özgü UNIQUE metni', new Error('UNIQUE constraint failed')],
  ])('%s YARIŞTA kazananın satırıyla çözülür', async (_label, error) => {
    messageReports.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'kazanan', status: 'open' });
    messageReports.insert.mockRejectedValue(error);

    const result = await MessageReports.create(input);

    expect(result).toEqual({ row: { _id: 'kazanan', status: 'open' }, created: false });
  });

  it('benzersizlik ihlali OLMAYAN hata YUTULMAZ', async () => {
    messageReports.insert.mockRejectedValue(Object.assign(new Error('disk full'), { code: '53100' }));

    await expect(MessageReports.create(input)).rejects.toThrow('disk full');
  });

  it('kodsuz/mesajsız hata da yutulmaz', async () => {
    messageReports.insert.mockRejectedValue({});

    await expect(MessageReports.create(input)).rejects.toBeDefined();
  });

  it('benzersizlik ihlali sonrası KAZANAN bulunamazsa hata yayılır', async () => {
    messageReports.findOne.mockResolvedValue(null);
    messageReports.insert.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));

    await expect(MessageReports.create(input)).rejects.toThrow('duplicate');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('findOpenForServer', () => {
  it('yalnız AÇIK kayıtları sunucuya göre, YENİDEN ESKİYE sıralar', async () => {
    const { chainRoot, sort, limit } = chain([{ _id: REPORT }]);
    messageReports.find.mockReturnValue(chainRoot);

    const rows = await MessageReports.findOpenForServer(SRV);

    expect(messageReports.find).toHaveBeenCalledWith({ serverId: SRV, status: 'open' });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(limit).toHaveBeenCalledWith(200);
    expect(rows).toEqual([{ _id: REPORT }]);
  });

  it.each([
    ['sıfır', 0, 1],
    ['negatif', -5, 1],
    ['üst sınırın üstünde', 5_000, 500],
    ['sınır içinde', 50, 50],
  ])('%s limit güvenli aralığa çekilir', async (_label, requested, expected) => {
    const { chainRoot, limit } = chain([]);
    messageReports.find.mockReturnValue(chainRoot);

    await MessageReports.findOpenForServer(SRV, requested);

    expect(limit).toHaveBeenCalledWith(expected);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('resolveTargetState', () => {
  const resolve = (resolution: 'resolved' | 'dismissed' = 'resolved') =>
    MessageReports.resolveTargetState({ serverId: SRV, id: REPORT, actorId: 'mod-1', resolution });

  it('bulunmayan şikâyet MISSING döner ve yazma yapılmaz', async () => {
    const result = await resolve();

    expect(result).toEqual({ kind: 'missing' });
    expect(messageReports.update).not.toHaveBeenCalled();
  });

  it('AYNI karar tekrarlanırsa ALREADY döner (yeniden yazılmaz)', async () => {
    const row = { _id: REPORT, status: 'resolved', resolution: 'resolved' };
    messageReports.findOne.mockResolvedValue(row);

    expect(await resolve('resolved')).toEqual({ kind: 'already', row });
    expect(messageReports.update).not.toHaveBeenCalled();
  });

  it('KAPALI şikâyet farklı bir karara çevrilemez', async () => {
    const row = { _id: REPORT, status: 'dismissed', resolution: 'dismissed' };
    messageReports.findOne.mockResolvedValue(row);

    expect(await resolve('resolved')).toEqual({ kind: 'conflict', row });
    expect(messageReports.update).not.toHaveBeenCalled();
  });

  it('durumu bozuk satır da AÇIK sayılmaz', async () => {
    const row = { _id: REPORT };
    messageReports.findOne.mockResolvedValue(row);

    expect(await resolve()).toEqual({ kind: 'conflict', row });
  });

  it.each([
    ['resolved', 'resolved'],
    ['dismissed', 'dismissed'],
  ])('%s kararı KOŞULLU güncellemeyle yazılır', async (resolution, status) => {
    const open = { _id: REPORT, status: 'open' };
    const closed = { _id: REPORT, status, resolution };
    messageReports.findOne.mockResolvedValueOnce(open).mockResolvedValue(closed);

    const result = await MessageReports.resolveTargetState({
      serverId: SRV, id: REPORT, actorId: 'mod-1', resolution: resolution as 'resolved' | 'dismissed',
    });

    expect(messageReports.update).toHaveBeenCalledWith(
      { _id: REPORT, serverId: SRV, status: 'open' },
      { $set: expect.objectContaining({ status, resolution, resolvedBy: 'mod-1' }) },
    );
    expect(result).toEqual({ kind: 'updated', row: closed });
  });

  it('YARIŞTA satır kapanmışsa güncelleme tutmaz ve CONFLICT döner', async () => {
    const open = { _id: REPORT, status: 'open' };
    const raced = { _id: REPORT, status: 'resolved', resolution: 'resolved' };
    messageReports.findOne.mockResolvedValueOnce(open).mockResolvedValue(raced);
    messageReports.update.mockResolvedValue({ updated: 0 });

    expect(await resolve('dismissed')).toEqual({ kind: 'conflict', row: raced });
  });

  it('güncelleme sonucu belirsizse de CONFLICT döner', async () => {
    messageReports.findOne.mockResolvedValueOnce({ _id: REPORT, status: 'open' }).mockResolvedValue(null);
    messageReports.update.mockResolvedValue(null);

    expect(await resolve()).toEqual({ kind: 'conflict', row: null });
  });
});
