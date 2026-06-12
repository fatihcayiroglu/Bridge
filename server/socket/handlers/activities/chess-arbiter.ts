// server/socket/handlers/activities/chess-arbiter.ts
// Sprint 85: Sunucu tarafı satranç hamlesi doğrulama ve oyun durumu yöneticisi.
//
// Mimari:
//   İstemci hamle gönderir → sunucu doğrular → geçerliyse yayar + durum günceller.
//   İstemci artık hamle logic'i çalıştırmaz; yalnızca server onaylı hamleleri render eder.
//
// Sprint 85 fix: Oyun state'i artık Redis'te tutulmaktadır (chess-store.ts).
//   Önceki: const _games = new Map() — tek pod, restart'ta kayıp, replicas:2 ile bozuk.
//   Şimdi:  chessStore.get/set/del — Redis + in-memory fallback, multi-instance güvenli.
//
// Kullanım (activities.ts içinden):
//   import { registerChessHandlers } from './activities/chess-arbiter';
//   registerChessHandlers(socket, io, userId);

import type { Socket, Server as IOServer } from 'socket.io';
import logger from '../../../lib/logger';
import { chessStore } from './chess-store';

// ── Types ─────────────────────────────────────────────────────
// GameState ve bağlı tipler chess-types.ts'e taşındı (döngüsel bağımlılık fix — Sprint 85)
export type { GameState } from './chess-types';
import type { Color, PieceId, Board, CastlingRights, MoveRecord, GameState } from './chess-types';

type PromotionPiece = 'Q' | 'R' | 'B' | 'N';

// ── Board helpers ─────────────────────────────────────────────

function col(p: PieceId | null): Color | null {
  if (!p) return null;
  return p[0] as Color;
}

function pieceType(p: PieceId | null): string {
  return p ? p[1]! : '';
}

function cloneBoard(b: Board): Board {
  return b.map(row => [...row]);
}

function initialBoard(): Board {
  const _ = null;
  return [
    ['bR','bN','bB','bQ','bK','bB','bN','bR'],
    ['bP','bP','bP','bP','bP','bP','bP','bP'],
    [_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_],
    [_,_,_,_,_,_,_,_],
    ['wP','wP','wP','wP','wP','wP','wP','wP'],
    ['wR','wN','wB','wQ','wK','wB','wN','wR'],
  ] as Board;
}

// ── Saldırı/tehdit tespiti ────────────────────────────────────

function isAttackedBy(board: Board, r: number, c: number, attacker: Color): boolean {
  const dir = attacker === 'w' ? 1 : -1;

  // Pawn attacks
  if (r + dir >= 0 && r + dir <= 7) {
    if (c - 1 >= 0 && board[r + dir]![c - 1] === `${attacker}P`) return true;
    if (c + 1 <= 7 && board[r + dir]![c + 1] === `${attacker}P`) return true;
  }

  // Knight
  const knightDeltas: [number,number][] = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (const [dr, dc] of knightDeltas) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7 && board[nr]![nc] === `${attacker}N`) return true;
  }

  // Sliding: rook/queen (horizontal/vertical)
  for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]] as [number,number][]) {
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
      const p = board[nr]![nc];
      if (p) {
        if (col(p) === attacker && (pieceType(p) === 'R' || pieceType(p) === 'Q')) return true;
        break;
      }
      nr += dr; nc += dc;
    }
  }

  // Sliding: bishop/queen (diagonal)
  for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]] as [number,number][]) {
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
      const p = board[nr]![nc];
      if (p) {
        if (col(p) === attacker && (pieceType(p) === 'B' || pieceType(p) === 'Q')) return true;
        break;
      }
      nr += dr; nc += dc;
    }
  }

  // King (adjacent)
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]] as [number,number][]) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7 && board[nr]![nc] === `${attacker}K`) return true;
  }

  return false;
}

function findKing(board: Board, color: Color): [number, number] {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r]![c] === `${color}K`) return [r, c];
  return [-1, -1]; // should never happen
}

function isInCheck(board: Board, color: Color): boolean {
  const [kr, kc] = findKing(board, color);
  const opp: Color = color === 'w' ? 'b' : 'w';
  return isAttackedBy(board, kr, kc, opp);
}

// ── Hamle uygulaması (board üzerinde) ────────────────────────

interface ApplyResult {
  board:     Board;
  captured:  PieceId | null;
  epSquare:  [number, number] | null;
  castlingUpdates: Partial<CastlingRights>;
  promotion: PieceId | null;
}

function applyMoveToBoard(
  board:       Board,
  state:       GameState,
  fromR: number, fromC: number,
  toR:   number, toC:   number,
  promoteTo?: PromotionPiece,
): ApplyResult {
  const b        = cloneBoard(board);
  const piece    = b[fromR]![fromC]!;
  const pColor   = col(piece)!;
  const pType    = pieceType(piece);
  let captured: PieceId | null = b[toR]![toC] ?? null;
  let epSquare: [number, number] | null = null;
  const castlingUpdates: Partial<CastlingRights> = {};
  let promotion: PieceId | null = null;

  // En passant capture
  if (pType === 'P' && state.enPassant && toR === state.enPassant[0] && toC === state.enPassant[1]) {
    const epCaptureRow = pColor === 'w' ? toR + 1 : toR - 1;
    captured = b[epCaptureRow]![toC] ?? null;
    b[epCaptureRow]![toC] = null;
  }

  // Castling: move rook
  if (pType === 'K') {
    const dc = toC - fromC;
    if (Math.abs(dc) === 2) {
      if (dc === 2) {
        // King-side
        b[fromR]![5] = b[fromR]![7]!;
        b[fromR]![7] = null;
      } else {
        // Queen-side
        b[fromR]![3] = b[fromR]![0]!;
        b[fromR]![0] = null;
      }
    }
    // King moved: lose all castling rights for this color
    if (pColor === 'w') { castlingUpdates.wK = false; castlingUpdates.wQ = false; }
    else                { castlingUpdates.bK = false; castlingUpdates.bQ = false; }
  }

  // Rook moved: lose that side's castling right
  if (pType === 'R') {
    if (pColor === 'w') {
      if (fromR === 7 && fromC === 7) castlingUpdates.wK = false;
      if (fromR === 7 && fromC === 0) castlingUpdates.wQ = false;
    } else {
      if (fromR === 0 && fromC === 7) castlingUpdates.bK = false;
      if (fromR === 0 && fromC === 0) castlingUpdates.bQ = false;
    }
  }

  // Rook captured: lose castling right
  if (captured) {
    if (captured === 'wR') {
      if (toR === 7 && toC === 7) castlingUpdates.wK = false;
      if (toR === 7 && toC === 0) castlingUpdates.wQ = false;
    } else if (captured === 'bR') {
      if (toR === 0 && toC === 7) castlingUpdates.bK = false;
      if (toR === 0 && toC === 0) castlingUpdates.bQ = false;
    }
  }

  // Double pawn push: set en passant target
  if (pType === 'P' && Math.abs(toR - fromR) === 2) {
    epSquare = [(fromR + toR) / 2, fromC];
  }

  // Promotion
  if (pType === 'P' && (toR === 0 || toR === 7)) {
    const promType = promoteTo ?? 'Q';
    promotion = `${pColor}${promType}` as PieceId;
    b[toR]![toC] = promotion;
  } else {
    b[toR]![toC] = piece;
  }
  b[fromR]![fromC] = null;

  return { board: b, captured, epSquare, castlingUpdates, promotion };
}

// ── Yasal hamle üretimi ───────────────────────────────────────

function getLegalMoves(
  state: GameState,
  fromR: number, fromC: number,
): [number, number][] {
  const { board, turn, castling, enPassant } = state;
  const piece = board[fromR]![fromC];
  if (!piece || col(piece) !== turn) return [];

  const pType  = pieceType(piece);
  const pseudo: [number, number][] = [];

  const addIfValid = (r: number, c: number) => {
    if (r >= 0 && r <= 7 && c >= 0 && c <= 7) {
      if (!board[r]![c] || col(board[r]![c]) !== turn) pseudo.push([r, c]);
    }
  };

  const slide = (deltas: [number,number][]) => {
    for (const [dr, dc] of deltas) {
      let nr = fromR + dr, nc = fromC + dc;
      while (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
        if (board[nr]![nc]) {
          if (col(board[nr]![nc]!) !== turn) pseudo.push([nr, nc]);
          break;
        }
        pseudo.push([nr, nc]);
        nr += dr; nc += dc;
      }
    }
  };

  switch (pType) {
    case 'P': {
      const dir    = turn === 'w' ? -1 : 1;
      const start  = turn === 'w' ? 6 : 1;
      const nr1    = fromR + dir;
      if (nr1 >= 0 && nr1 <= 7 && !board[nr1]![fromC]) {
        pseudo.push([nr1, fromC]);
        if (fromR === start && !board[fromR + 2 * dir]![fromC]) pseudo.push([fromR + 2 * dir, fromC]);
      }
      for (const dc of [-1, 1]) {
        const nc = fromC + dc;
        if (nc >= 0 && nc <= 7 && nr1 >= 0 && nr1 <= 7) {
          if (board[nr1]![nc] && col(board[nr1]![nc]) !== turn) pseudo.push([nr1, nc]);
          if (enPassant && nr1 === enPassant[0] && nc === enPassant[1]) pseudo.push([nr1, nc]);
        }
      }
      break;
    }
    case 'N':
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]] as [number,number][])
        addIfValid(fromR + dr, fromC + dc);
      break;
    case 'B': slide([[1,1],[1,-1],[-1,1],[-1,-1]]); break;
    case 'R': slide([[0,1],[0,-1],[1,0],[-1,0]]); break;
    case 'Q': slide([[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]]); break;
    case 'K': {
      for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]] as [number,number][])
        addIfValid(fromR + dr, fromC + dc);
      // Castling
      const opp: Color = turn === 'w' ? 'b' : 'w';
      const backRank = turn === 'w' ? 7 : 0;
      if (fromR === backRank && fromC === 4 && !isInCheck(board, turn)) {
        // King-side
        if ((turn === 'w' ? castling.wK : castling.bK)
          && !board[backRank]![5] && !board[backRank]![6]
          && !isAttackedBy(board, backRank, 5, opp)
          && !isAttackedBy(board, backRank, 6, opp)) {
          pseudo.push([backRank, 6]);
        }
        // Queen-side
        if ((turn === 'w' ? castling.wQ : castling.bQ)
          && !board[backRank]![3] && !board[backRank]![2] && !board[backRank]![1]
          && !isAttackedBy(board, backRank, 3, opp)
          && !isAttackedBy(board, backRank, 2, opp)) {
          pseudo.push([backRank, 2]);
        }
      }
      break;
    }
  }

  // Filter: moves that leave own king in check are illegal
  return pseudo.filter(([tr, tc]) => {
    const res = applyMoveToBoard(board, state, fromR, fromC, tr, tc);
    return !isInCheck(res.board, turn);
  });
}

function hasAnyLegalMove(state: GameState): boolean {
  const { board, turn } = state;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (col(board[r]![c]!) === turn && getLegalMoves(state, r, c).length > 0)
        return true;
  return false;
}

// ── Notasyon ─────────────────────────────────────────────────

function toAN(r: number, c: number): string {
  return ('abcdefgh'[c] ?? '') + (8 - r);
}

// ── Yeni oyun ─────────────────────────────────────────────────

export function newGame(whiteUserId: string | null, blackUserId: string | null): GameState {
  return {
    board:       initialBoard(),
    turn:        'w',
    castling:    { wK: true, wQ: true, bK: true, bQ: true },
    enPassant:   null,
    halfmove:    0,
    moveHistory: [],
    gameOver:    false,
    result:      null,
    whiteUserId,
    blackUserId,
  };
}

// ── Socket handler ────────────────────────────────────────────

export function registerChessHandlers(
  socket: Socket,
  io:     IOServer,
  userId: string,
): void {

  // chess:join — oyuna katıl (beyaz/siyah ata)
  socket.on('chess:join', async (payload: { channelId: string }) => {
    const { channelId } = payload ?? {};
    if (!channelId) return;

    let game = await chessStore.get(channelId);
    if (!game) {
      game = newGame(userId, null);
      await chessStore.set(channelId, game);
      socket.emit('chess:joined', { color: 'w', state: _publicState(game) });
      logger.info({ event: 'chess.created', channelId, userId }, 'Chess game created');
      return;
    }

    if (!game.blackUserId && game.whiteUserId !== userId) {
      // Atomik CAS: blackUserId hâlâ null ise bu userId'yi yaz, aksi hâlde başkası kazandı
      const claimed = await chessStore.claimBlack(channelId, userId);
      if (!claimed) {
        // Race: başka biri siyahı aldı; güncel state'i çek ve reconnect gibi davran
        const latest = await chessStore.get(channelId);
        const color = latest?.whiteUserId === userId ? 'w' : latest?.blackUserId === userId ? 'b' : null;
        socket.emit('chess:state', { color, state: latest ? _publicState(latest) : null });
        return;
      }
      // Güncel state'i oku (claimBlack içinde yazıldı)
      const started = await chessStore.get(channelId);
      if (started) {
        io.to(`channel:${channelId}`).emit('chess:started', { state: _publicState(started) });
        logger.info({ event: 'chess.started', channelId }, 'Chess game started');
      }
      return;
    }

    // Reconnect: belirle rengi
    const color = game.whiteUserId === userId ? 'w' : game.blackUserId === userId ? 'b' : null;
    socket.emit('chess:state', { color, state: _publicState(game) });
  });

  // chess:move — hamle doğrula ve uygula
  socket.on('chess:move', async (payload: {
    channelId:  string;
    from:       string;   // algebraic: "e2"
    to:         string;   // algebraic: "e4"
    promoteTo?: PromotionPiece;
  }) => {
    try {
      const { channelId, from, to, promoteTo } = payload ?? {};
      if (!channelId || !from || !to) return;

      const game = await chessStore.get(channelId);
      if (!game || game.gameOver) {
        socket.emit('chess:invalid', { reason: 'Oyun mevcut değil veya bitti.' });
        return;
      }

      // Yalnızca sırası gelen oyuncu hamle yapabilir
      const expectedUser = game.turn === 'w' ? game.whiteUserId : game.blackUserId;
      if (expectedUser && expectedUser !== userId) {
        socket.emit('chess:invalid', { reason: 'Sıra sende değil.' });
        return;
      }

      // Algebraic → board koordinatları
      const files = 'abcdefgh';
      const fromC = files.indexOf(from[0] ?? '');
      const fromR = 8 - parseInt(from[1] ?? '0');
      const toC   = files.indexOf(to[0] ?? '');
      const toR   = 8 - parseInt(to[1] ?? '0');

      if ([fromC, fromR, toC, toR].some(v => v < 0 || v > 7)) {
        socket.emit('chess:invalid', { reason: 'Geçersiz kare.' });
        return;
      }

      // Yasal hamle mi?
      const legal = getLegalMoves(game, fromR, fromC);
      if (!legal.some(([lr, lc]) => lr === toR && lc === toC)) {
        socket.emit('chess:invalid', { reason: 'Yasadışı hamle.' });
        return;
      }

      // Hamleyi uygula
      const result = applyMoveToBoard(game.board, game, fromR, fromC, toR, toC, promoteTo);

      // Durum güncelle
      game.board = result.board;
      game.enPassant = result.epSquare;
      game.castling  = { ...game.castling, ...result.castlingUpdates };
      game.halfmove  = result.captured || result.promotion || pieceType(game.board[toR]![toC]!) === 'P' ? 0 : game.halfmove + 1;

      const moveRec: MoveRecord = {
        from:      [fromR, fromC],
        to:        [toR,   toC],
        piece:     game.board[toR]![toC]!,
        captured:  result.captured,
        promotion: result.promotion,
        notation:  toAN(fromR, fromC) + toAN(toR, toC) + (result.promotion ? (result.promotion[1] ?? '').toLowerCase() : ''),
      };
      game.moveHistory.push(moveRec);

      // Sırayı değiştir
      const prevTurn = game.turn;
      game.turn = prevTurn === 'w' ? 'b' : 'w';

      // Oyun sonu kontrolü
      const opp = game.turn;
      if (!hasAnyLegalMove(game)) {
        game.gameOver = true;
        if (isInCheck(game.board, opp)) {
          game.result = prevTurn; // mat
        } else {
          game.result = 'draw';  // pat
        }
      } else if (game.halfmove >= 100) {
        game.gameOver = true;
        game.result   = 'draw'; // 50 hamle kuralı
      }

      // State'i kaydet (oyun bittiyse sil, devam ediyorsa güncelle)
      if (game.gameOver) {
        await chessStore.del(channelId);
      } else {
        await chessStore.set(channelId, game);
      }

      // Tüm oyunculara yayınla
      io.to(`channel:${channelId}`).emit('chess:move_applied', {
        move:  moveRec,
        state: _publicState(game),
      });

      if (game.gameOver) {
        io.to(`channel:${channelId}`).emit('chess:game_over', {
          result: game.result,
          reason: game.result === 'draw' ? (game.halfmove >= 100 ? '50 hamle' : 'Pat') : 'Şah mat',
          state:  _publicState(game),
        });
        logger.info({ event: 'chess.over', channelId, result: game.result }, 'Chess game over');
      }

    } catch (err) {
      logger.error({ event: 'chess.move.error', err }, 'chess:move handler error');
      socket.emit('chess:invalid', { reason: 'Sunucu hatası.' });
    }
  });

  // chess:resign — teslim ol
  socket.on('chess:resign', async (payload: { channelId: string }) => {
    const { channelId } = payload ?? {};
    if (!channelId) return;
    const game = await chessStore.get(channelId);
    if (!game || game.gameOver) return;

    const resigned = await chessStore.markGameOver(channelId);
    if (!resigned) return; // başka bir event kazandı (race condition koruması)

    const resignColor = game.whiteUserId === userId ? 'w' : 'b';
    game.result = resignColor === 'w' ? 'b' : 'w';
    io.to(`channel:${channelId}`).emit('chess:game_over', {
      result: game.result,
      reason: `${resignColor === 'w' ? 'Beyaz' : 'Siyah'} teslim oldu.`,
      state:  _publicState({ ...game, gameOver: true }),
    });
  });

  // chess:draw_offer / chess:draw_accept — beraberlik teklifi
  socket.on('chess:draw_offer', async (payload: { channelId: string }) => {
    const { channelId } = payload ?? {};
    if (!channelId) return;
    const game = await chessStore.get(channelId);
    if (!game || game.gameOver) return;
    io.to(`channel:${channelId}`).emit('chess:draw_offered', { by: userId });
  });

  socket.on('chess:draw_accept', async (payload: { channelId: string }) => {
    const { channelId } = payload ?? {};
    if (!channelId) return;
    const game = await chessStore.get(channelId);
    if (!game || game.gameOver) return;

    const accepted = await chessStore.markGameOver(channelId);
    if (!accepted) return; // başka bir event kazandı (race condition koruması)

    io.to(`channel:${channelId}`).emit('chess:game_over', {
      result: 'draw',
      reason: 'Anlaşmalı beraberlik.',
      state:  _publicState({ ...game, gameOver: true, result: 'draw' }),
    });
  });
}

// ── Public state (istemciye gönderilecek subset) ──────────────

function _publicState(g: GameState) {
  return {
    board:       g.board,
    turn:        g.turn,
    enPassant:   g.enPassant,
    castling:    g.castling,
    moveHistory: g.moveHistory,
    gameOver:    g.gameOver,
    result:      g.result,
    inCheck:     g.gameOver ? false : isInCheck(g.board, g.turn),
    whiteUserId: g.whiteUserId,
    blackUserId: g.blackUserId,
  };
}

// ── Test / admin exports ──────────────────────────────────────

export async function getChessGame(channelId: string) { return chessStore.get(channelId); }
export function _clearAllGames_TEST_ONLY()            { chessStore._clearMemGames_TEST_ONLY(); }

// İçsel fonksiyonlar — test dosyalarından erişim için
export const _internal = { isInCheck, getLegalMoves, applyMoveToBoard, newGame };
