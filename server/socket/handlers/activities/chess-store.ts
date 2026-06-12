// server/socket/handlers/activities/chess-store.ts
// Sprint 85 fix: Chess oyun state'ini Redis'e taşı — multi-instance güvenli.
//
// Neden:
//   chess-arbiter.ts içindeki `const _games = new Map()` yalnızca tek pod için
//   çalışır. k8s/bridge.yaml'da replicas: 2 ile iki pod çalıştığında oyuncular
//   farklı pod'lara düşebilir; state kaybolur veya fork'lanır.
//
// Çözüm:
//   Her oyun state'i Redis'e JSON olarak yazılır (TTL: 4 saat).
//   Redis yoksa (geliştirme ortamı) in-memory Map fallback devreye girer.
//   Bu sayede tek-instance geliştirme çalışmaya devam eder.
//
// Kullanım:
//   import { chessStore } from './chess-store';
//   const game = await chessStore.get(channelId);
//   await chessStore.set(channelId, game);
//   await chessStore.del(channelId);

import { cache, isRedisAvailable } from '../../../lib/redisAdapter';
import logger from '../../../lib/logger';
import type { GameState } from './chess-types';

const KEY_PREFIX = 'chess:game:';
const GAME_TTL   = 60 * 60 * 4; // 4 saat

// In-memory fallback — Redis yoksa (geliştirme, test)
const _memGames = new Map<string, GameState>();

export const chessStore = {
  async get(channelId: string): Promise<GameState | null> {
    if (isRedisAvailable()) {
      try {
        return await cache.get<GameState>(`${KEY_PREFIX}${channelId}`);
      } catch (err) {
        logger.warn({ err, event: 'chess.store.get.error', channelId }, 'Redis get hatası, in-memory fallback');
      }
    }
    return _memGames.get(channelId) ?? null;
  },

  async set(channelId: string, state: GameState): Promise<void> {
    if (isRedisAvailable()) {
      try {
        await cache.set(`${KEY_PREFIX}${channelId}`, state, GAME_TTL);
        return;
      } catch (err) {
        logger.warn({ err, event: 'chess.store.set.error', channelId }, 'Redis set hatası, in-memory fallback');
      }
    }
    _memGames.set(channelId, state);
  },

  async del(channelId: string): Promise<void> {
    if (isRedisAvailable()) {
      try {
        await cache.del(`${KEY_PREFIX}${channelId}`);
        return;
      } catch (err) {
        logger.warn({ err, event: 'chess.store.del.error', channelId }, 'Redis del hatası, in-memory fallback');
      }
    }
    _memGames.delete(channelId);
  },

  // Atomik: gameOver false ise true'ya çek ve sil. Başarılıysa true döner.
  // İki eş zamanlı chess:resign / chess:draw_accept yarışını önler.
  async markGameOver(channelId: string): Promise<boolean> {
    const key = `${KEY_PREFIX}${channelId}`;
    if (isRedisAvailable()) {
      const lua = `
        local raw = redis.call('GET', KEYS[1])
        if not raw then return 0 end
        local obj = cjson.decode(raw)
        if obj.gameOver then return 0 end
        obj.gameOver = true
        redis.call('SET', KEYS[1], cjson.encode(obj), 'EX', tonumber(ARGV[1]))
        return 1
      `;
      try {
        const result = await cache.luaEval(lua, [key], [String(GAME_TTL)]);
        if (result === 1) {
          await cache.del(key);
          return true;
        }
        return false;
      } catch (err) {
        logger.warn({ err, event: 'chess.store.markGameOver.error', channelId }, 'Lua eval hatası, in-memory fallback');
      }
    }
    // In-memory fallback (single-instance, JS single-threaded → atomik)
    const game = _memGames.get(channelId);
    if (!game || game.gameOver) return false;
    game.gameOver = true;
    _memGames.delete(channelId);
    return true;
  },

  // Atomik: blackUserId null ise verilen userId'yi yaz. Başarılıysa true döner.
  // chess:join handler'ında iki eş zamanlı katılımı önler.
  async claimBlack(channelId: string, userId: string): Promise<boolean> {
    const key = `${KEY_PREFIX}${channelId}`;
    if (isRedisAvailable()) {
      const lua = `
        local raw = redis.call('GET', KEYS[1])
        if not raw then return 0 end
        local obj = cjson.decode(raw)
        if obj.blackUserId and obj.blackUserId ~= cjson.null then return 0 end
        obj.blackUserId = ARGV[1]
        redis.call('SET', KEYS[1], cjson.encode(obj), 'EX', tonumber(ARGV[2]))
        return 1
      `;
      try {
        const result = await cache.luaEval(lua, [key], [userId, String(GAME_TTL)]);
        return result === 1;
      } catch (err) {
        logger.warn({ err, event: 'chess.store.claimBlack.error', channelId }, 'Lua eval hatası, in-memory fallback');
      }
    }
    // In-memory fallback
    const game = _memGames.get(channelId);
    if (!game || game.blackUserId) return false;
    game.blackUserId = userId;
    return true;
  },

  // Test / admin yardımcısı — yalnızca in-memory fallback'i temizler
  _clearMemGames_TEST_ONLY(): void {
    _memGames.clear();
  },

  _memGames, // test erişimi için
};
