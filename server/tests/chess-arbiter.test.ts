// server/tests/chess-arbiter.test.ts
// Sprint 85: Chess arbiter unit testleri
//
// Sprint 85 fix: _clearAllGames_TEST_ONLY artık chessStore in-memory fallback'ini
// temizler. Redis olmadığında (test ortamı) davranış değişmedi.

import { _internal, getChessGame, _clearAllGames_TEST_ONLY } from '../socket/handlers/activities/chess-arbiter';
import type { Board } from '../socket/handlers/activities/chess-types';

const { isInCheck, getLegalMoves, applyMoveToBoard, newGame } = _internal;

/** Boş 8×8 tahta yardımcısı — tip güvenli */
function emptyBoard(): Board {
  return Array.from({ length: 8 }, () => Array(8).fill(null)) as Board;
}

beforeEach(() => _clearAllGames_TEST_ONLY());

describe('isInCheck', () => {
  it('başlangıç pozisyonunda şah yok', () => {
    const g = newGame(null, null);
    expect(isInCheck(g.board, 'w')).toBe(false);
    expect(isInCheck(g.board, 'b')).toBe(false);
  });

  it('fool\'s mate — beyaz şah mat', () => {
    // 1.f3 e5 2.g4 Vh4#
    const g = newGame(null, null);
    const moves: [number,number,number,number][] = [
      [6,5,5,5], // f3
      [1,4,3,4], // e5
      [6,6,4,6], // g4
      [0,3,4,7], // Qh4#
    ];
    let state = g;
    for (const [fr,fc,tr,tc] of moves) {
      const res = applyMoveToBoard(state.board, state, fr, fc, tr, tc);
      state = {
        ...state,
        board:    res.board,
        enPassant: res.epSquare,
        castling: { ...state.castling, ...res.castlingUpdates },
        turn:     state.turn === 'w' ? 'b' : 'w',
      };
    }
    expect(isInCheck(state.board, 'w')).toBe(true);
  });
});

describe('getLegalMoves', () => {
  it('başlangıçta beyaz için 20 hamle', () => {
    const g = newGame(null, null);
    let count = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        count += getLegalMoves(g, r, c).length;
    expect(count).toBe(20);
  });

  it('pin — şahı tehdit eden taşın önündeki taş hareket edemez', () => {
    // Elle kurulmuş pozisyon: beyaz kral e1, beyaz piyon e2, siyah kule e8
    const g = newGame(null, null);
    const board = emptyBoard();
    board[7][4] = 'wK'; // e1
    board[6][4] = 'wP'; // e2 — pin altında
    board[0][4] = 'bR'; // e8 — pin eden
    const pinState = { ...g, board, turn: 'w' as const };
    const moves = getLegalMoves(pinState, 6, 4); // e2 piyonu
    expect(moves.length).toBe(0);
  });

  it('rok — kral geçtiği kareye gidebilir', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[7][4] = 'wK';
    board[7][7] = 'wR';
    // f1, g1 boş → king-side rok mümkün
    const state = { ...g, board, turn: 'w' as const, castling: { wK: true, wQ: false, bK: false, bQ: false } };
    const moves = getLegalMoves(state, 7, 4);
    expect(moves).toContainEqual([7, 6]); // g1 — castled position
  });

  it('en passant — yasal hamle listesinde', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[3][4] = 'wP'; // e5
    board[3][5] = 'bP'; // f5 — yeni çift adım attı
    board[7][4] = 'wK';
    board[0][4] = 'bK';
    const state = {
      ...g,
      board,
      turn: 'w' as const,
      enPassant: [2, 5] as [number, number], // f6
    };
    const moves = getLegalMoves(state, 3, 4);
    expect(moves).toContainEqual([2, 5]); // en passant
  });

  it('şah altındayken yalnızca şahı kurtaran hamleler geçerli', () => {
    // Beyaz kral e1, siyah kule a1 — kral yalnızca f1/f2/e2 ye gidebilir (d1/d2 tehdit altında)
    const g = newGame(null, null);
    const board = emptyBoard();
    board[7][4] = 'wK'; // e1
    board[7][0] = 'bR'; // a1 — şah veriyor
    board[0][4] = 'bK';
    const state = { ...g, board, turn: 'w' as const };
    const moves = getLegalMoves(state, 7, 4);
    // Kral a1 kulesinin saldırı hattından (rank 7) çıkmalı
    for (const [tr, tc] of moves) {
      const res = applyMoveToBoard(board, state, 7, 4, tr, tc);
      expect(isInCheck(res.board, 'w')).toBe(false);
    }
    expect(moves.length).toBeGreaterThan(0);
  });
});

describe('applyMoveToBoard', () => {
  it('terfi — piyonu vezire dönüştür', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[1][0] = 'wP'; // a7 — bir hamle sonra a8
    board[7][4] = 'wK';
    board[0][4] = 'bK';
    const state = { ...g, board, turn: 'w' as const };
    const res = applyMoveToBoard(state.board, state, 1, 0, 0, 0, 'Q');
    expect(res.board[0][0]).toBe('wQ');
    expect(res.promotion).toBe('wQ');
  });

  it('terfi — varsayılan taş vezir olmalı', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[1][0] = 'wP';
    board[7][4] = 'wK';
    board[0][4] = 'bK';
    const state = { ...g, board, turn: 'w' as const };
    // promoteTo verilmeden — varsayılan 'Q'
    const res = applyMoveToBoard(state.board, state, 1, 0, 0, 0);
    expect(res.board[0][0]).toBe('wQ');
    expect(res.promotion).toBe('wQ');
  });

  it('rok — kule de hareket eder', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[7][4] = 'wK';
    board[7][7] = 'wR';
    const state = { ...g, board, turn: 'w' as const, castling: { wK: true, wQ: false, bK: false, bQ: false } };
    const res = applyMoveToBoard(state.board, state, 7, 4, 7, 6);
    expect(res.board[7][6]).toBe('wK');
    expect(res.board[7][5]).toBe('wR');
    expect(res.board[7][7]).toBeNull();
  });

  it('queen-side rok — kule c1\'e taşınır', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[7][4] = 'wK';
    board[7][0] = 'wR';
    const state = { ...g, board, turn: 'w' as const, castling: { wK: false, wQ: true, bK: false, bQ: false } };
    const res = applyMoveToBoard(state.board, state, 7, 4, 7, 2);
    expect(res.board[7][2]).toBe('wK'); // c1
    expect(res.board[7][3]).toBe('wR'); // d1
    expect(res.board[7][0]).toBeNull();
  });

  it('en passant — geçen piyonu alır', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[3][4] = 'wP'; // e5
    board[3][5] = 'bP'; // f5
    board[7][4] = 'wK';
    board[0][4] = 'bK';
    const state = { ...g, board, turn: 'w' as const, enPassant: [2, 5] as [number, number] };
    const res = applyMoveToBoard(state.board, state, 3, 4, 2, 5);
    expect(res.board[2][5]).toBe('wP');   // piyon f6'ya taşındı
    expect(res.board[3][5]).toBeNull();   // f5'teki siyah piyon alındı
    expect(res.captured).toBe('bP');
  });

  it('kale hareketi — rok hakkı düşer', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[7][4] = 'wK';
    board[7][7] = 'wR'; // h1 — king-side kule
    const state = { ...g, board, turn: 'w' as const, castling: { wK: true, wQ: true, bK: false, bQ: false } };
    const res = applyMoveToBoard(state.board, state, 7, 7, 5, 7); // Rh3
    expect(res.castlingUpdates.wK).toBe(false);
    expect(res.castlingUpdates.wQ).toBeUndefined(); // queen-side etkilenmedi
  });
});
