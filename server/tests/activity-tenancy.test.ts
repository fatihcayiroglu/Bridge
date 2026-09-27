// server/tests/activity-tenancy.test.ts
//
// AKTİVİTE HANDLER'LARI — KİRACI VE OYUNCU SINIRI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// Bu programda dört kez aynı desen çıktı: bir olayda uygulanan yetki/sahiplik
// denetimi, KARDEŞ olayında unutulmuş.
//
//   1. `channel:*` yayın röleleri   → yetki hiç yoktu
//   2. `voice:join` korumalı, `voice:leave` korumasız
//   3. doğrudan katılma önbelleği temizliyor, davet yolu temizlemiyor
//   4. AKTİVİTELER (bu dosya)
//
// ── DÜZELTİLEN GERÇEK AÇIKLAR ─────────────────────────────────────────────
// A) ORTAK TUVAL (draw-together) — CANLI SÖMÜRÜLDÜ
//    `draw:join` istemcinin `channelId` değerine koşulsuz güveniyordu. Üyesi
//    OLMAYAN bir kullanıcı, kurban kanalının tuvaline hem OKUMA hem YAZMA
//    erişimi kazanıyordu (e2e/_draw-tenancy.cjs ile ölçüldü: 4 olay sızdı,
//    enjekte edilen çizim kurbana ulaştı).
//
// B) SATRANÇ — oyuncu kimliği denetlenmiyordu
//    `chess:join` herhangi bir kanalda oyun oluşturup koltuk kapabiliyordu.
//    Daha kötüsü `chess:resign` / `draw_offer` / `draw_accept` oyuncu
//    olmayanlara AÇIKTI: herhangi biri başkasının oyununu bitirebiliyordu ve
//    `whiteUserId === userId ? 'w' : 'b'` ifadesi oyuncu olmayanı SİYAH
//    sayıp sonucu "beyaz kazandı" diye yayınlıyordu.
//
// `chess:move` zaten koltuk sahipliğiyle korunuyordu — yine kardeş asimetrisi.

import fs from 'fs';
import path from 'path';

const SRV = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRV, p), 'utf8');

/** Yorumları soyar: açıklamada alıntılanan kod GERÇEK kod sayılmamalı. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// ORTAK TUVAL
// ════════════════════════════════════════════════════════════════════════════
describe('draw-together — kanal erişimi', () => {
  const raw = read('socket/handlers/activities/draw-together.ts');
  const src = codeOnly(raw);

  it('KATILMA kanal yetkisi denetler', () => {
    expect(src).toContain('mayJoinCanvas(socket, user._id, channelId)');
  });

  it('yetki, oturum oluşturmadan ÖNCE gelir', () => {
    // Denetim sonra gelseydi, saldirgan yine de oturum yaratabilir ve
    // `draw:state` ile mevcut cizimleri alabilirdi.
    const join = src.slice(src.indexOf("socket.on('draw:join'"));
    const guard = join.indexOf('mayJoinCanvas');
    const create = join.indexOf('drawStore.withLock');
    const emitState = join.indexOf("socket.emit('draw:state'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(create);
    expect(guard).toBeLessThan(emitState);
  });

  it('sunucu kimliği KANALDAN okunur, istemciden DEĞİL', () => {
    // Istemcinin bildirdigi bir serverId kullanilsaydi `voice:leave` ile
    // ayni capraz-kiraci acik geri gelirdi.
    expect(src).toContain('String(channel.serverId)');
    expect(src).not.toMatch(/canViewChannel\([^)]*payload\./);
  });

  it('KANONİK yetki yardımcısı kullanılıyor — kopya YOK', () => {
    // `messages-edit.ts` ve `members.ts` zaten `canViewChannel` kullaniyor.
    expect(src).toContain("from '../../../lib/permissions'");
    expect(src).toContain('canViewChannel(');
  });

  it('yüksek frekanslı olaylar ODA ÜYELİĞİNE bağlı', () => {
    // Her stroke icin veritabanina gitmek hem pahali hem gereksizdir; oda
    // uyeligi sunucu tarafi durumdur ve istemci tarafindan uydurulamaz.
    for (const ev of ['draw:stroke', 'draw:stroke-end', 'draw:undo', 'draw:clear', 'draw:cursor']) {
      const i = src.indexOf(`socket.on('${ev}'`);
      expect({ ev, found: i > -1 }).toEqual({ ev, found: true });
      const body = src.slice(i, i + 500);
      expect({ ev, guarded: body.includes('inCanvasRoom(socket, channelId)') })
        .toEqual({ ev, guarded: true });
    }
  });

  it('oda üyeliği kontrolü SUNUCU durumunu okur', () => {
    expect(src).toContain('socket.rooms.has(`draw:${channelId}`)');
  });

  it('katılma ayrıca gerçek VOICE oda üyeliğine bağlıdır', () => {
    expect(src).toContain('socket.rooms.has(`voice:${channelId}`)');
  });

  it('gerekçe kaynakta YAZILI', () => {
    expect(raw).toMatch(/KAPATILAN GERCEK ACIK|CANLI SUNUCUDA SOMURULDU/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SATRANC
// ════════════════════════════════════════════════════════════════════════════
describe('chess — kanal ve oyuncu sınırı', () => {
  const raw = read('socket/handlers/activities/chess-arbiter.ts');
  const src = codeOnly(raw);

  it('KATILMA kanal yetkisi denetler', () => {
    expect(src).toContain('mayJoinChannelGame(socket, userId, channelId)');
  });

  it('KATILMA gerçek VOICE oda üyeliği ister', () => {
    expect(src).toContain('socket.rooms.has(`voice:${channelId}`)');
  });

  it('yetki, oyun oluşturmadan ÖNCE gelir', () => {
    const join = src.slice(src.indexOf("socket.on('chess:join'"));
    const guard = join.indexOf('mayJoinChannelGame');
    const create = join.indexOf('chessStore.set');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(create);
  });

  it('TESLİM OLMA yalnızca oyunculara açık', () => {
    // Onceden herhangi biri baskasinin oyununu bitirebiliyordu.
    const body = src.slice(src.indexOf("socket.on('chess:resign'"));
    const guard = body.indexOf('isPlayer(game, userId)');
    const over = body.indexOf('chessStore.del');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(over);      // oyunu BITIRMEDEN once
  });

  it('BERABERLİK KABULÜ yalnızca oyunculara açık', () => {
    const body = src.slice(src.indexOf("socket.on('chess:draw_accept'"));
    const guard = body.indexOf('isPlayer(game, userId)');
    const over = body.indexOf('chessStore.del');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(over);
  });

  it('BERABERLİK TEKLİFİ sahte olarak yayınlanamaz', () => {
    const body = src.slice(src.indexOf("socket.on('chess:draw_offer'"));
    const guard = body.indexOf('isPlayer(game, userId)');
    const emit = body.indexOf("emit('chess:draw_offered'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(emit);
  });

  it('HAMLE koruması korunuyor (gerileme yok)', () => {
    // Bu zaten dogruydu; duzeltme onu bozmamali.
    expect(src).toContain('expectedUser !== userId');
  });

  it('isPlayer HER İKİ koltuğu da kabul eder', () => {
    // Yalnizca beyazi kabul eden bir kontrol, siyahi kendi oyunundan ederdi.
    expect(src).toMatch(/whiteUserId === userId \|\| .*blackUserId === userId/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// isPlayer — davranis
// ════════════════════════════════════════════════════════════════════════════
function isPlayer(game: { whiteUserId?: string | null; blackUserId?: string | null }, userId: string): boolean {
  return game.whiteUserId === userId || game.blackUserId === userId;
}

describe('isPlayer — davranış', () => {
  it('BEYAZ oyuncu tanınır', () => {
    expect(isPlayer({ whiteUserId: 'u1', blackUserId: 'u2' }, 'u1')).toBe(true);
  });
  it('SİYAH oyuncu tanınır', () => {
    expect(isPlayer({ whiteUserId: 'u1', blackUserId: 'u2' }, 'u2')).toBe(true);
  });
  it('YABANCI reddedilir', () => {
    expect(isPlayer({ whiteUserId: 'u1', blackUserId: 'u2' }, 'u3')).toBe(false);
  });
  it('boş koltuk yabancıyı oyuncu YAPMAZ', () => {
    // Kusurun ozu buydu: siyah bos iken yabanci "siyah" muamelesi goruyordu.
    expect(isPlayer({ whiteUserId: 'u1', blackUserId: null }, 'u3')).toBe(false);
  });
  it('null userId eşleşmez', () => {
    expect(isPlayer({ whiteUserId: null, blackUserId: null }, 'u1')).toBe(false);
  });
});
