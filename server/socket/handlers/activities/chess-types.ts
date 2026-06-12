// server/socket/handlers/activities/chess-types.ts
// Paylaşılan satranç tipleri — döngüsel bağımlılığı önlemek için bağımsız dosya.
// chess-store.ts ve chess-arbiter.ts buradan import eder; bu dosya hiçbir şeye bağımlı değil.

export type Color   = 'w' | 'b';
export type PieceId = 'wP'|'wR'|'wN'|'wB'|'wQ'|'wK'|'bP'|'bR'|'bN'|'bB'|'bQ'|'bK';
export type Board   = (PieceId | null)[][];  // [row 0..7][col 0..7], row 0 = rank 8

export interface CastlingRights {
  wK: boolean; wQ: boolean;
  bK: boolean; bQ: boolean;
}

export interface MoveRecord {
  from: [number, number];
  to:   [number, number];
  piece:      PieceId;
  captured:   PieceId | null;
  promotion:  PieceId | null;
  notation:   string;
}

export interface GameState {
  board:        Board;
  turn:         Color;
  castling:     CastlingRights;
  enPassant:    [number, number] | null;  // [row, col] of capturable pawn's square
  halfmove:     number;                   // 50-move rule counter
  moveHistory:  MoveRecord[];
  gameOver:     boolean;
  result:       string | null;            // 'w' | 'b' | 'draw'
  whiteUserId:  string | null;
  blackUserId:  string | null;
}
