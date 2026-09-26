// server/tests/push-backpressure.test.ts
//
// PUSH TOPLU BİLDİRİMİ — GERİ BASINÇ VE DEBOUNCE AÇLIĞI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN İKİ GERÇEK KUSUR (P2)
// ════════════════════════════════════════════════════════════════════════════
// `deliverPushBatched` her yeni mesajda `clearTimeout` yapıp 3 saniyelik
// zamanlayıcıyı SIFIRDAN kuruyordu ve AZAMİ BEKLEME yoktu:
//
//     if (pending.timer) clearTimeout(pending.timer);
//     pending.msgs.push(msg);
//     ...
//     pending.timer = setTimeout(flush, PUSH_DEBOUNCE_MS);
//
// A) BİLDİRİM AÇLIĞI — işlevsel kusur
//    Mesajlar 3 saniyeden sık geldiği sürece zamanlayıcı HİÇ ateşlenmez.
//    Hareketli bir sohbette kullanıcıya push bildirimi HİÇ GİTMEZ — tam da
//    en çok ihtiyaç duyulduğu anda sessizce kaybolur. Bu bir bellek sorunu
//    değil, ÜRÜNÜN SESSİZCE ÇALIŞMAMASIDIR.
//
// B) SINIRSIZ BİRİKİM — kaynak kusuru
//    `msgs` her mesajda büyüdü ve zamanlayıcı ateşlenmediği için girdi
//    Map'ten hiç silinmedi. Oysa gönderim yalnızca SON 3 mesajı ve TOPLAM
//    SAYIYI kullanır (`msgs.slice(-3)` ve `count`) — gerisini tutmanın
//    hiçbir faydası yoktu.
//
// DÜZELTME: sabit pencereli azami bekleme + sabit boyutlu tampon.

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import {
  deliverPushBatched,
  __pendingPushForTest as pendingPush,
  __PUSH_MAX_WAIT_MS as MAX_WAIT,
  __PUSH_DEBOUNCE_MS as DEBOUNCE,
  __PUSH_KEEP_MSGS as KEEP,
} from '../lib/notifications';

const mkMsg = (i: number) => ({
  _id: 'm' + i,
  channelId: 'c1',
  serverId: 's1',
  content: 'mesaj ' + i,
  displayName: 'Ali',
  username: 'ali',
});

beforeEach(() => {
  jest.useFakeTimers();
  pendingPush.clear();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const KEY = 'u1:c1';

// ════════════════════════════════════════════════════════════════════════════
// KUSUR B — SINIRSIZ BİRİKİM
// ════════════════════════════════════════════════════════════════════════════
describe('tampon sınırı', () => {
  it('200 mesajdan sonra tampon SABİT boyutta kalır', async () => {
    for (let i = 0; i < 200; i++) await deliverPushBatched('u1', mkMsg(i));
    const p = pendingPush.get(KEY)!;
    expect({ tampon: p.msgs.length, sinir: KEEP }).toEqual({ tampon: KEEP, sinir: KEEP });
  });

  it('gerçek TOPLAM sayı korunur (tampon küçülse de)', async () => {
    for (let i = 0; i < 200; i++) await deliverPushBatched('u1', mkMsg(i));
    expect(pendingPush.get(KEY)!.count).toBe(200);
  });

  it('tamponda tutulanlar EN SON mesajlardır', async () => {
    // Govde `msgs.slice(-3)` gosterdigi icin en yeniler tutulmali.
    for (let i = 0; i < 50; i++) await deliverPushBatched('u1', mkMsg(i));
    expect(pendingPush.get(KEY)!.msgs.map(m => m._id)).toEqual(['m47', 'm48', 'm49']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KUSUR A — DEBOUNCE AÇLIĞI
// ════════════════════════════════════════════════════════════════════════════
describe('azami bekleme (açlık önleme)', () => {
  it('SÜREKLİ akan mesajlar bildirimi SONSUZA ERTELEYEMEZ', async () => {
    // Duzeltmeden ONCE bu dongu zamanlayiciyi sonsuza dek sifirliyor ve
    // bildirim HIC gonderilmiyordu.
    await deliverPushBatched('u1', mkMsg(0));

    // Debounce penceresinden KISA araliklarla mesaj akisi.
    const adim = DEBOUNCE - 500;
    let gecen = 0;
    while (gecen < MAX_WAIT * 2) {
      jest.advanceTimersByTime(adim);
      gecen += adim;
      if (pendingPush.has(KEY)) await deliverPushBatched('u1', mkMsg(gecen));
    }

    // Azami bekleme sinirinda MUTLAKA bosaltilmis olmali.
    expect({ hala: pendingPush.has(KEY) }).toEqual({ hala: false });
  });

  it('gecikme HİÇBİR ZAMAN azami beklemeyi aşmaz', async () => {
    await deliverPushBatched('u1', mkMsg(0));
    const ilk = pendingPush.get(KEY)!.firstAt;

    for (let i = 1; i < 20; i++) {
      jest.advanceTimersByTime(DEBOUNCE - 500);
      if (pendingPush.has(KEY)) await deliverPushBatched('u1', mkMsg(i));
    }
    if (pendingPush.has(KEY)) {
      const bekleyen = Date.now() - ilk;
      expect(bekleyen).toBeLessThanOrEqual(MAX_WAIT);
    } else {
      expect(pendingPush.has(KEY)).toBe(false);   // zaten bosaltilmis
    }
  });

  it('firstAt İLK mesajda sabitlenir — sonrakiler kaydırmaz', async () => {
    await deliverPushBatched('u1', mkMsg(0));
    const ilk = pendingPush.get(KEY)!.firstAt;
    jest.advanceTimersByTime(1000);
    await deliverPushBatched('u1', mkMsg(1));
    expect(pendingPush.get(KEY)!.firstAt).toBe(ilk);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POZİTİF KONTROL — normal debounce davranışı KORUNUR
// ════════════════════════════════════════════════════════════════════════════
describe('POZİTİF KONTROL: olağan davranış bozulmadı', () => {
  it('tek mesaj debounce süresi sonunda gönderilir', async () => {
    // Bu olmadan "her seyi hemen bosalt" gibi asiri genis bir yama da
    // yukaridaki aclik testlerini gecerdi — ve toplu bildirim OLURDU.
    await deliverPushBatched('u1', mkMsg(1));
    expect(pendingPush.has(KEY)).toBe(true);      // henuz bekliyor
    jest.advanceTimersByTime(DEBOUNCE + 50);
    await Promise.resolve();
    expect(pendingPush.has(KEY)).toBe(false);     // bosaltildi
  });

  it('debounce GERÇEKTEN toplar — sessizleşince tek bildirim', async () => {
    await deliverPushBatched('u1', mkMsg(1));
    jest.advanceTimersByTime(1000);
    await deliverPushBatched('u1', mkMsg(2));
    // Henuz debounce dolmadi: hala tek bir bekleyen girdi olmali.
    expect({ girdi: pendingPush.size, sayi: pendingPush.get(KEY)!.count })
      .toEqual({ girdi: 1, sayi: 2 });
  });

  it('FARKLI kullanıcı/kanal AYRI kuyruklarda toplanır', async () => {
    await deliverPushBatched('u1', mkMsg(1));
    await deliverPushBatched('u2', mkMsg(2));
    await deliverPushBatched('u1', { ...mkMsg(3), channelId: 'c2' });
    expect(pendingPush.size).toBe(3);
  });
});
