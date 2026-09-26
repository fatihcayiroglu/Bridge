// server/tests/chess-arbiter.test.ts
// Sprint 85: Chess arbiter unit testleri
//
// Sprint 85 fix: _clearAllGames_TEST_ONLY artık chessStore in-memory fallback'ini
// temizler. Redis olmadığında (test ortamı) davranış değişmedi.

import { _internal, getChessGame, _clearAllGames_TEST_ONLY } from '../socket/handlers/activities/chess-arbiter';
import type { Board, GameState } from '../socket/handlers/activities/chess-types';

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

  it('pin — piyon yalnızca şahı koruyan hamleleri yapabilir', () => {
    // Elle kurulmuş pozisyon: beyaz kral e1, beyaz piyon e2, siyah kule e8
    const g = newGame(null, null);
    const board = emptyBoard();
    board[7][4] = 'wK'; // e1
    board[6][4] = 'wP'; // e2 — pin altında
    board[0][4] = 'bR'; // e8 — pin eden
    const pinState = { ...g, board, turn: 'w' as const };
    const moves = getLegalMoves(pinState, 6, 4); // e2 piyonu
    expect(moves).toEqual([[5, 4], [4, 4]]);
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

describe('chess arbiter deep rule branches', () => {
  it('detects pawn, knight, bishop, rook, queen and king attacks for both colors', () => {
    const cases: Array<{ piece: any; at: [number, number]; king: [number, number]; color: 'w'|'b' }> = [
      { piece: 'bP', at: [6,3], king: [7,4], color: 'w' },
      { piece: 'bN', at: [5,3], king: [7,4], color: 'w' },
      { piece: 'bB', at: [4,1], king: [7,4], color: 'w' },
      { piece: 'bR', at: [2,4], king: [7,4], color: 'w' },
      { piece: 'bQ', at: [3,0], king: [7,4], color: 'w' },
      { piece: 'bK', at: [6,4], king: [7,4], color: 'w' },
      { piece: 'wP', at: [1,3], king: [0,4], color: 'b' },
      { piece: 'wN', at: [2,3], king: [0,4], color: 'b' },
    ];
    for (const tc of cases) {
      const board = emptyBoard();
      board[tc.king[0]]![tc.king[1]] = `${tc.color}K` as any;
      board[tc.at[0]]![tc.at[1]] = tc.piece;
      // Keep the opposite king somewhere harmless for structurally valid states.
      const other = tc.color === 'w' ? 'bK' : 'wK';
      board[tc.color === 'w' ? 0 : 7]![0] = other as any;
      expect(isInCheck(board, tc.color)).toBe(true);
    }
  });

  it('friendly blockers stop sliding attacks while enemy blockers may be captured but not jumped', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[7]![4] = 'wK'; board[0]![4] = 'bK';
    board[4]![4] = 'wR'; board[4]![5] = 'wP'; board[4]![3] = 'bP';
    const state = { ...g, board, turn: 'w' as const };
    const rook = getLegalMoves(state, 4, 4);
    expect(rook).not.toContainEqual([4, 5]);
    expect(rook).toContainEqual([4, 3]);
    expect(rook).not.toContainEqual([4, 2]);

    board[4]![4] = 'wB'; board[5]![5] = 'wP'; board[3]![3] = 'bP';
    const bishop = getLegalMoves({ ...state, board }, 4, 4);
    expect(bishop).not.toContainEqual([5, 5]);
    expect(bishop).toContainEqual([3, 3]);
    expect(bishop).not.toContainEqual([2, 2]);
  });

  it('covers white and black rook/captured-rook castling-right transitions', () => {
    const base = newGame(null, null);
    const make = () => {
      const board = emptyBoard();
      board[7]![4] = 'wK'; board[0]![4] = 'bK';
      board[7]![0] = 'wR'; board[7]![7] = 'wR';
      board[0]![0] = 'bR'; board[0]![7] = 'bR';
      return board;
    };
    let board = make();
    expect(applyMoveToBoard(board, { ...base, board, turn:'w' }, 7,0,6,0).castlingUpdates).toMatchObject({wQ:false});
    board = make();
    expect(applyMoveToBoard(board, { ...base, board, turn:'b' }, 0,7,1,7).castlingUpdates).toMatchObject({bK:false});
    board = make();
    expect(applyMoveToBoard(board, { ...base, board, turn:'b' }, 0,0,1,0).castlingUpdates).toMatchObject({bQ:false});

    board = make(); board[6]![7] = 'wQ';
    expect(applyMoveToBoard(board, { ...base, board, turn:'w' }, 6,7,0,7).castlingUpdates).toMatchObject({bK:false});
    board = make(); board[6]![0] = 'wQ';
    expect(applyMoveToBoard(board, { ...base, board, turn:'w' }, 6,0,0,0).castlingUpdates).toMatchObject({bQ:false});
    board = make(); board[1]![7] = 'bQ';
    expect(applyMoveToBoard(board, { ...base, board, turn:'b' }, 1,7,7,7).castlingUpdates).toMatchObject({wK:false});
    board = make(); board[1]![0] = 'bQ';
    expect(applyMoveToBoard(board, { ...base, board, turn:'b' }, 1,0,7,0).castlingUpdates).toMatchObject({wQ:false});
  });

  it('black king movement clears both black castling rights and black can castle both sides when safe', () => {
    const g = newGame(null, null);
    const board = emptyBoard();
    board[0]![4] = 'bK'; board[0]![0] = 'bR'; board[0]![7] = 'bR'; board[7]![4] = 'wK';
    const state = { ...g, board, turn:'b' as const, castling:{wK:false,wQ:false,bK:true,bQ:true} };
    const legal = getLegalMoves(state,0,4);
    expect(legal).toContainEqual([0,6]);
    expect(legal).toContainEqual([0,2]);
    expect(applyMoveToBoard(board,state,0,4,1,4).castlingUpdates).toEqual({bK:false,bQ:false});
  });

  it('castling is rejected through check, attacked transit squares, and occupied paths', () => {
    const g = newGame(null, null);
    const base = emptyBoard(); base[7]![4]='wK'; base[7]![0]='wR'; base[7]![7]='wR'; base[0]![0]='bK';
    const rights={wK:true,wQ:true,bK:false,bQ:false};

    const inCheck = base.map(r=>[...r]) as Board; inCheck[0]![4]='bR';
    expect(getLegalMoves({...g,board:inCheck,turn:'w',castling:rights},7,4)).not.toContainEqual([7,6]);

    const transit = base.map(r=>[...r]) as Board; transit[0]![5]='bR';
    expect(getLegalMoves({...g,board:transit,turn:'w',castling:rights},7,4)).not.toContainEqual([7,6]);

    const blocked = base.map(r=>[...r]) as Board; blocked[7]![1]='wN';
    expect(getLegalMoves({...g,board:blocked,turn:'w',castling:rights},7,4)).not.toContainEqual([7,2]);
  });

  it('supports black pawn double-push, capture, en-passant, and promotion choices', () => {
    const g=newGame(null,null); const board=emptyBoard();
    board[0]![4]='bK'; board[7]![4]='wK'; board[1]![3]='bP'; board[2]![4]='wN';
    // Tip ACIKCA yazilir: ilk atamadan cikarilan `enPassant: null` sonraki
    // atamalari (`[5,2]`) reddediyordu.
    let state: GameState={...g,board,turn:'b' as const,enPassant:null};
    const moves=getLegalMoves(state,1,3);
    expect(moves).toContainEqual([2,3]); expect(moves).toContainEqual([3,3]); expect(moves).toContainEqual([2,4]);
    const dbl=applyMoveToBoard(board,state,1,3,3,3);
    expect(dbl.epSquare).toEqual([2,3]);

    const epBoard=emptyBoard(); epBoard[0]![4]='bK'; epBoard[7]![4]='wK'; epBoard[4]![3]='bP'; epBoard[4]![2]='wP';
    // `ChessState.enPassant` bir DEMETtir (`[number, number] | null`); dizi
    // edebisi `number[]` cikariyordu. `satisfies` demet cikarimini saglar
    // ve ayni anda uyumu DENETLER (cast degildir).
    state={...g,board:epBoard,turn:'b' as const,enPassant:[5,2]};
    expect(getLegalMoves(state,4,3)).toContainEqual([5,2]);
    expect(applyMoveToBoard(epBoard,state,4,3,5,2).captured).toBe('wP');

    const promoBoard=emptyBoard(); promoBoard[0]![4]='bK'; promoBoard[7]![4]='wK'; promoBoard[6]![0]='bP';
    const promoState={...g,board:promoBoard,turn:'b' as const};
    for(const p of ['R','B','N'] as const) expect(applyMoveToBoard(promoBoard,promoState,6,0,7,0,p).promotion).toBe(`b${p}`);
  });

  it('returns no legal moves for an empty square or the non-moving color', () => {
    const g=newGame(null,null);
    expect(getLegalMoves(g,4,4)).toEqual([]);
    expect(getLegalMoves(g,1,0)).toEqual([]);
  });
});
